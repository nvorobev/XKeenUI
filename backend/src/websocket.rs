use crate::logger::{process_log_line, ts};
use crate::types::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

static WS_COUNTER: AtomicU32 = AtomicU32::new(0);

#[derive(Deserialize)]
pub struct LogParams {
    file: Option<String>,
}

fn log_path(file: Option<&str>) -> String {
    if file == Some("access.log") {
        access_log_path()
    } else {
        error_log_path()
    }
}

pub async fn log_ws_handler(
    ws: WebSocketUpgrade, State(state): State<AppState>, Query(params): Query<LogParams>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_log_socket(socket, state, params.file))
}

pub async fn update_ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_update_socket(socket, state))
}

fn read_log_file(p: String, offset: u64, query: String, full: bool, tz: i32) -> (String, Vec<String>, u64) {
    let mut f = match File::open(&p) {
        Ok(f) => f,
        _ => return ("clear".into(), vec![], 0),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut current_pos = offset;

    if full && query.is_empty() && len > 128000 {
        let seek_pos = len - 128000;
        _ = f.seek(SeekFrom::Start(seek_pos));
        let mut reader = BufReader::new(&mut f);
        let mut discard = String::new();
        let skipped = reader.read_line(&mut discard).unwrap_or(0);
        current_pos = seek_pos + skipped as u64;
    } else if !full && len < offset {
        return ("clear".into(), vec![], 0);
    } else if full {
        current_pos = 0;
    }

    _ = f.seek(SeekFrom::Start(current_pos));
    let mut lines = Vec::new();
    let mut total_bytes = 0usize;
    let mut bytes_read = current_pos;
    let keywords: Vec<String> = query
        .split('|')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let reader = BufReader::new(f);

    for line in reader.lines().map_while(Result::ok) {
        let line_len = line.len() + 1;
        bytes_read += line_len as u64;

        let matched = if query.is_empty() {
            true
        } else {
            let normalized = line
                .replace("[Debug]", "[DEBUG]")
                .replace("level=debug", "level=DEBUG")
                .replace("[Info]", "[INFO]")
                .replace("level=info", "level=INFO")
                .replace("[Warning]", "[WARN]")
                .replace("level=warning", "level=WARN")
                .replace("[Error]", "[ERROR]")
                .replace("level=error", "level=ERROR")
                .replace("[Fatal]", "[FATAL]")
                .replace("level=fatal", "level=FATAL");
            keywords.iter().any(|k| normalized.contains(k))
        };

        if matched {
            let proc = process_log_line(line, tz);
            if !proc.is_empty() {
                if full && !query.is_empty() {
                    total_bytes += line_len;
                    if total_bytes >= 128000 {
                        break;
                    }
                }
                lines.push(proc);
            }
        }
    }
    (if full { "initial".into() } else { "append".into() }, lines, bytes_read)
}

/// Sent on the log channel when the Xray log paths changed: open journals reopen their file.
const LOG_PATHS_CHANGED: &str = "\0log-paths-changed";

fn spawn_log_watcher(tx: std::sync::Arc<tokio::sync::broadcast::Sender<String>>) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        let (mpsc_tx, mut mpsc_rx) = tokio::sync::mpsc::channel::<String>(32);
        let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(e) = res
                && (e.kind.is_modify() || e.kind.is_create())
            {
                for path in e.paths {
                    let _ = mpsc_tx.try_send(path.to_string_lossy().to_string());
                }
            }
        }) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("{} [ERROR] Failed to start log watcher: {}", ts(), e);
                return;
            }
        };

        // Watch the directories, not the files: a log that does not exist yet (or is recreated
        // by rotation) is still picked up. Events carry the full file path.
        let mut dirs: Vec<std::path::PathBuf> = [error_log_path(), access_log_path()]
            .iter()
            .filter_map(|file| Path::new(file).parent().map(Path::to_path_buf))
            .collect();
        dirs.dedup();
        for dir in dirs {
            let _ = std::fs::create_dir_all(&dir);
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("{} [ERROR] Failed to watch {}: {}", ts(), dir.display(), e);
            }
        }

        while let Some(path) = mpsc_rx.recv().await {
            let _ = tx.send(path);
        }
    })
    .abort_handle()
}

/// Re-reads the log paths from the Xray configs (called when a journal opens and after a
/// config is saved). On a change the watcher moves to the new files and open journals follow.
pub(crate) async fn refresh_log_paths(state: &AppState) {
    let changed = tokio::task::spawn_blocking(crate::types::refresh_xray_log_paths)
        .await
        .unwrap_or(false);
    if !changed {
        return;
    }
    let mut guard = state.log_watcher.lock().await;
    if let Some(watcher) = guard.take() {
        watcher.abort();
    }
    if WS_COUNTER.load(Ordering::SeqCst) > 0 {
        *guard = Some(spawn_log_watcher(state.log_tx.clone()));
    }
    let _ = state.log_tx.send(LOG_PATHS_CHANGED.into());
}

async fn attach_log_client(state: &AppState) {
    refresh_log_paths(state).await;
    let mut guard = state.log_watcher.lock().await;
    let count = WS_COUNTER.fetch_add(1, Ordering::SeqCst);
    if state.debug {
        println!("{} [INFO] WS-{} Connected (Total: {})", ts(), count, count + 1);
    }
    if guard.as_ref().is_none_or(|h| h.is_finished()) {
        if state.debug {
            println!("{} [INFO] 🚀 Starting log watcher...", ts());
        }
        *guard = Some(spawn_log_watcher(state.log_tx.clone()));
    }
}

async fn detach_log_client(state: &AppState) {
    let mut guard = state.log_watcher.lock().await;
    let remaining = WS_COUNTER.fetch_sub(1, Ordering::SeqCst) - 1;
    if state.debug {
        println!("{} [INFO] WS Disconnected. Remaining: {}", ts(), remaining);
    }
    if remaining == 0 {
        if state.debug {
            println!("{} [INFO] 💤 Stopping log watcher...", ts());
        }
        if let Some(abort_handle) = guard.take() {
            abort_handle.abort();
        }
    }
}

async fn handle_log_socket(socket: WebSocket, state: AppState, file: Option<String>) {
    attach_log_client(&state).await;
    run_log_socket(socket, state.clone(), file).await;
    detach_log_client(&state).await;
}

async fn run_log_socket(socket: WebSocket, state: AppState, file: Option<String>) {
    let (mut tx, mut rx) = socket.split();
    let mut log_rx = state.log_tx.subscribe();
    let mut kind = file;
    let mut path = log_path(kind.as_deref());
    let mut query = String::new();
    let tz = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .log
        .timezone;

    let p_clone = path.clone();
    let q_clone = query.clone();
    let Ok((t, l, mut offset)) =
        tokio::task::spawn_blocking(move || read_log_file(p_clone, 0, q_clone, true, tz)).await
    else {
        return;
    };

    let init_msg = if l.is_empty() {
        serde_json::json!({"type": "clear"})
    } else {
        serde_json::json!({"type": t, "lines": l})
    };
    if tx.send(Message::Text(init_msg.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Text(txt))) => {
                        let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                        let tz = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner).log.timezone;
                        match v["type"].as_str() {
                            Some("switchFile") => {
                                kind = v["file"].as_str().map(str::to_string);
                                path = log_path(kind.as_deref());

                                let p = path.clone();
                                let q = query.clone();
                                let Ok((t, l, off)) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await else { break; };
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": t, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("filter") | Some("reload") => {
                                query = v["query"].as_str().unwrap_or("").to_string();
                                let q = query.clone();
                                let p = path.clone();
                                let Ok((t, l, off)) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await else { break; };
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": if v["type"] == "filter" { "filtered" } else { t.as_str() }, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("clear") => {
                                let p = path.clone();
                                offset = 0;
                                tokio::task::spawn_blocking(move || { File::create(p).ok(); });
                                if tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                            },
                            _ => {}
                        }
                    },
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            result = log_rx.recv() => {
                let changed_path = match result {
                    Ok(p) => p,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => path.clone(),
                    Err(_) => break,
                };
                let current = log_path(kind.as_deref());
                if changed_path == LOG_PATHS_CHANGED || current != path {
                    // The Xray config now names another file: show that one from the start.
                    if current == path {
                        continue;
                    }
                    path = current;
                    let tz = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner).log.timezone;
                    let p = path.clone();
                    let q = query.clone();
                    let Ok((t, l, off)) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await else { break; };
                    offset = off;
                    let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": t, "lines": l}) };
                    if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                } else if changed_path == path {
                    let tz = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner).log.timezone;
                    let p = path.clone();
                    let q = query.clone();
                    let off_curr = offset;
                    let Ok((t, l, new_off)) = tokio::task::spawn_blocking(move || read_log_file(p, off_curr, q, false, tz)).await else { break; };
                    offset = new_off;

                    if !l.is_empty() {
                        let content = l.join("\n");
                        if tx.send(Message::Text(serde_json::json!({"type": t, "content": content}).to_string().into())).await.is_err() { break; }
                    } else if t == "clear"
                         && tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                }
            }
        }
    }
}

async fn handle_update_socket(socket: WebSocket, state: AppState) {
    let (mut tx, mut rx) = socket.split();
    let mut update_rx = state.update_session.events.subscribe();
    let history = state
        .update_session
        .history
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let mut last_seq = history.last().map_or(0, |event| event.seq);
    let initial = serde_json::json!({ "type": "update", "history": history });
    if tx.send(Message::Text(initial.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            msg = rx.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            result = update_rx.recv() => {
                let payload = match result {
                    Ok(event) if event.seq <= last_seq => continue,
                    Ok(event) => {
                        last_seq = event.seq;
                        serde_json::json!({ "type": "update", "event": event })
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let history = state.update_session.history.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
                        let Some(newest_seq) = history.last().map(|event| event.seq) else { continue };
                        last_seq = last_seq.max(newest_seq);
                        serde_json::json!({ "type": "update", "history": history })
                    }
                    Err(_) => break,
                };
                if tx.send(Message::Text(payload.to_string().into())).await.is_err() {
                    break;
                }
            }
        }
    }
}
