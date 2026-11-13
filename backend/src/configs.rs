use crate::fsutil::{DEFAULT_MODE, write_atomic};
use crate::healthchecker::serve_config;
use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::net::UnixListener;

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    pub(crate) file: String,
    pub(crate) content: String,
}
#[derive(Deserialize)]
pub struct DeleteReq {
    file: String,
}
#[derive(Deserialize)]
pub struct RenameReq {
    file: String,
    new_file: String,
}

async fn collect_configs(paths: &[String], is_mihomo: bool) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        let metadata = tokio::fs::metadata(path).await;
        if metadata.as_ref().is_ok_and(|m| m.is_dir()) {
            match tokio::fs::read_dir(path).await {
                Err(e) => {
                    log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e));
                }
                Ok(mut entries) => {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let entry_path = entry.path();
                        let matches = if is_mihomo {
                            entry_path.extension().is_some_and(|e| e == "yaml" || e == "yml")
                        } else {
                            entry_path.extension().is_some_and(|e| e == "json")
                        };
                        if matches {
                            match tokio::fs::read_to_string(&entry_path).await {
                                Ok(content) => results.push(ConfigItem {
                                    file: entry_path.to_string_lossy().into(),
                                    content,
                                }),
                                Err(e) => {
                                    log(
                                        "ERROR",
                                        format!("Не удалось прочитать файл {}: {}", entry_path.display(), e),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        } else if metadata.is_ok() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem {
                    file: path_str.clone(),
                    content,
                }),
                Err(e) => {
                    log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e));
                }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(
    State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let target_core = parameters.get("core").cloned().unwrap_or_else(|| {
        state
            .core
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .name
            .clone()
    });
    let is_mihomo = target_core == "mihomo";

    let core_paths = {
        let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        let default_path = if is_mihomo {
            MIHOMO_CONF_DIR.to_string()
        } else {
            XRAY_CONF_DIR.to_string()
        };
        let mut paths = vec![default_path];
        let extra = if is_mihomo {
            settings.append_config_paths.mihomo.clone()
        } else {
            settings.append_config_paths.xray.clone()
        };
        paths.extend(extra);
        paths
    };

    let mut core_configs = collect_configs(&core_paths, is_mihomo).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if (path.extension().is_some_and(|e| e == "lst") || name == "xkeen.json")
                && let Ok(content) = tokio::fs::read_to_string(&path).await
            {
                lst_configs.push(ConfigItem {
                    file: path.to_string_lossy().into(),
                    content,
                });
            }
        }
    }

    lst_configs.sort_by(|a, b| a.file.cmp(&b.file));
    core_configs.append(&mut lst_configs);

    Json(serde_json::json!({ "success": true, "configs": core_configs }))
}

fn get_allowed_prefixes(state: &AppState, is_lst: bool) -> Vec<String> {
    if is_lst {
        return vec![XKEEN_CONF_DIR.to_string()];
    }
    let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    let core = state.core.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    let default_path = if core.name == "mihomo" {
        MIHOMO_CONF_DIR.to_string()
    } else {
        XRAY_CONF_DIR.to_string()
    };
    let extra = if core.name == "mihomo" {
        settings.append_config_paths.mihomo.clone()
    } else {
        settings.append_config_paths.xray.clone()
    };
    let mut paths = vec![default_path];
    paths.extend(extra);
    paths
}

/// Resolves symlinks of an existing file, or of the parent directory of a new one.
/// `None` for dangling symlinks and unreadable paths.
fn canonical_target(file: &Path) -> Option<PathBuf> {
    match fs::symlink_metadata(file) {
        Ok(_) => fs::canonicalize(file).ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = fs::canonicalize(file.parent()?).ok()?;
            Some(parent.join(file.file_name()?))
        }
        Err(_) => None,
    }
}

fn matches_prefix(file: &Path, prefix: &Path, prefix_is_dir: bool) -> bool {
    if prefix_is_dir {
        file.starts_with(prefix)
    } else {
        file == prefix
    }
}

/// The path must match an allowed prefix both as written and after resolving
/// symlinks, so a link (or a symlinked parent) cannot point outside the allowed set.
/// Blocking: call from `spawn_blocking`.
fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    let file_path = Path::new(file);
    let prefixes: Vec<(&Path, bool)> = prefixes
        .iter()
        .map(|prefix| {
            let path = Path::new(prefix.as_str());
            (path, path.is_dir())
        })
        .collect();
    if !prefixes
        .iter()
        .any(|(prefix, is_dir)| matches_prefix(file_path, prefix, *is_dir))
    {
        return false;
    }
    let Some(target) = canonical_target(file_path) else {
        return false;
    };
    prefixes.iter().any(|(prefix, is_dir)| {
        let canonical = fs::canonicalize(prefix).unwrap_or_else(|_| prefix.to_path_buf());
        matches_prefix(&target, &canonical, *is_dir)
    })
}

/// In the XKeen directory the editor may touch only `*.lst` lists and `xkeen.json`:
/// the panel keeps its own state there (`xkeen-ui.json` with passwords and sessions,
/// the server pool), which only its dedicated endpoints may change.
fn is_xkeen_editable(file: &str) -> bool {
    let path = Path::new(file);
    let in_xkeen_dir = path.parent() == Some(Path::new(XKEEN_CONF_DIR));
    file.ends_with(".lst") || (in_xkeen_dir && path.file_name().is_some_and(|name| name == "xkeen.json"))
}

pub(crate) async fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let is_xkeen = is_xkeen_editable(file);
    let prefixes = get_allowed_prefixes(state, is_xkeen);
    let owned = file.to_string();
    let allowed = tokio::task::spawn_blocking(move || is_path_allowed(&owned, &prefixes))
        .await
        .unwrap_or(false);
    if !allowed {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

/// Файлы, которые xray берёт из конфигдиректории при формате json (`getRegepxByFormat`).
fn is_xray_json(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("json") | Some("jsonc")
    )
}

pub async fn put_config(
    state: State<AppState>, params: Query<HashMap<String, String>>, request: Json<ConfigReq>,
) -> Response {
    // A native restart can disconnect the browser; finish the journal and rollback
    // independently of the lifetime of that HTTP request.
    let app = state.0.clone();
    let response = match tokio::spawn(put_config_inner(state, params, request)).await {
        Ok(response) => response,
        Err(error) => api_error(error.to_string()).into_response(),
    };
    // A saved Xray config may name other log files.
    crate::websocket::refresh_log_paths(&app).await;
    response
}

async fn put_config_inner(
    State(state): State<AppState>, Query(params): Query<HashMap<String, String>>, Json(req): Json<ConfigReq>,
) -> Response {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    let is_lst = match check_access(&req.file, &state).await {
        Ok(val) => val,
        Err(error) => return api_error(error).into_response(),
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    let apply = params.get("apply").is_some_and(|value| value == "true");
    match crate::xray_servers::update_routing_config(&state, &req.file, &content, apply).await {
        Ok(Some(running)) => {
            return Json(serde_json::json!({"success": true, "applied": true, "running": running})).into_response();
        }
        Ok(None) => {}
        Err(error) => return api_error(error).into_response(),
    }
    if let Err(error) = crate::xray_servers::guard_config_edit(&req.file, Some(content.as_str())).await {
        return api_error(error).into_response();
    }

    if let Some(core_type) = params.get("validate") {
        if core_type == "mihomo" {
            let close_conns = params
                .get("closeConns")
                .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false);
            return apply_mihomo_hot_reload(&state, &req.file, &content, close_conns)
                .await
                .into_response();
        }
        if core_type == "xray" {
            let mut validate_files = Vec::new();
            if let Ok(mut entries) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
                let mut found_current = false;
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let path = entry.path();
                    if is_xray_json(&path) {
                        let path_str = path.to_string_lossy().into_owned();
                        let file_content = if path_str == req.file {
                            found_current = true;
                            content.clone()
                        } else {
                            tokio::fs::read_to_string(&path).await.unwrap_or_default()
                        };
                        validate_files.push(ConfigReq {
                            file: path_str,
                            content: file_content,
                        });
                    }
                }
                if !found_current {
                    validate_files.push(ConfigReq {
                        file: req.file.clone(),
                        content: content.clone(),
                    });
                }
            } else {
                validate_files.push(ConfigReq {
                    file: req.file.clone(),
                    content: content.clone(),
                });
            }

            if let Err(err_msg) = validate_core(&validate_files).await {
                log("ERROR", err_msg);
                return api_error("Validation failed").into_response();
            }
        }
    }

    if let Err(error) = write_atomic(&req.file, &content, DEFAULT_MODE).await {
        log("ERROR", format!("Не удалось записать {}: {}", req.file, error));
        return api_error("Write error").into_response();
    }
    api_ok().into_response()
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    let is_lst = match check_access(&req.file, &state).await {
        Ok(val) => val,
        Err(error) => return api_error(error),
    };
    if tokio::fs::try_exists(&req.file).await.unwrap_or(true) {
        return api_error("File already exists");
    }
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    if let Err(error) = crate::xray_servers::guard_config_edit(&req.file, Some(content.as_str())).await {
        return api_error(error);
    }
    if let Err(error) = write_atomic(&req.file, &content, DEFAULT_MODE).await {
        log("ERROR", format!("Не удалось записать {}: {}", req.file, error));
        return api_error("Write error");
    }
    api_ok()
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    if let Err(e) = check_access(&req.file, &state).await {
        return api_error(e);
    }
    if let Err(error) = crate::xray_servers::guard_config_edit(&req.file, None).await {
        return api_error(error);
    }
    if tokio::fs::remove_file(&req.file).await.is_err() {
        return api_error("Delete error");
    }
    api_ok()
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    if let Err(e) = check_access(&req.file, &state).await {
        return api_error(e);
    }
    if let Err(e) = check_access(&req.new_file, &state).await {
        return api_error(e);
    }
    if tokio::fs::try_exists(&req.new_file).await.unwrap_or(true) {
        return api_error("File already exists");
    }
    for file in [&req.file, &req.new_file] {
        if let Err(error) = crate::xray_servers::guard_config_edit(file, None).await {
            return api_error(error);
        }
    }
    if tokio::fs::rename(&req.file, &req.new_file).await.is_err() {
        return api_error("Rename error");
    }
    api_ok()
}

/// Общий дедлайн валидации: и выдача конфигов через абстрактные сокеты, и сам
/// `xray -test` должны уложиться в эту воронку (xray обычно стартует за 0.1–1 c).
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(30);

/// Валидация Xray-конфигов без временных файлов — по аналогии с пингом аутбаундов
/// в outbounds.rs: одноразовый HTTP-сервер на абстрактном unix-сокете, xray сам
/// забирает конфиг (`xray run -test -c '@name'` — remote-источник:
/// `main/confloader/external::isRemoteSource` делает ровно один GET на `/` и ждёт
/// статус 200 с JSON-телом). Абстрактные имена нужны Xray не старее #6111 (май 2026).
///
/// Про `-test` и мерж файлов:
/// - `-test` есть у команды `run` (main/run.go): конфиг грузится, инбаунды НЕ стартуют
///   (занимать порты нечем — и не нужно), после «Configuration OK.» процесс выходит.
/// - Валидируется весь набор файлов: несколько `-c` мержатся в порядке аргументов
///   ровно как файлы из `-confdir` — тот читает директорию через `readConfDir`/
///   `os.ReadDir` (по алфавиту), поэтому и `-c` передаём в порядке имён файлов.
///
/// Отличие от локальных файлов: remote-JSON декодируется строгим парсером
/// (`DecodeJSONConfigStrict`, infra/conf/serial) — конфиги с комментариями
/// (JSON5/JSONC) будут отклонены. Это фундаментальное ограничение remote-лоадера,
/// а не баг.
pub(crate) async fn validate_core(files: &[ConfigReq]) -> Result<(), String> {
    // Валидируем только json/jsonc — ровно такой набор xray отбирает из
    // конфигдиректории при формате json (`getRegepxByFormat`).
    let mut sorted: Vec<&ConfigReq> = files
        .iter()
        .filter(|item| is_xray_json(Path::new(&item.file)))
        .collect();
    if sorted.is_empty() {
        return Ok(());
    }
    // Порядок мержа как у -confdir: os.ReadDir отдаёт файлы по алфавиту.
    sorted.sort_by(|a, b| Path::new(&a.file).file_name().cmp(&Path::new(&b.file).file_name()));

    let deadline = Instant::now() + VALIDATION_TIMEOUT;

    // Серверы конфига готовим ДО запуска xray: тот читает конфиги сразу на старте,
    // причём файлы — последовательно, поэтому каждый сокет ждёт ровно один GET.
    let mut sockets = Vec::with_capacity(sorted.len());
    let mut servers = Vec::with_capacity(sorted.len());
    let mut setup_error = None;
    for item in sorted.iter() {
        match bind_config_socket(&item.file).await {
            Ok((listener, socket)) => {
                servers.push(tokio::spawn(serve_config(
                    listener,
                    item.content.clone().into_bytes(),
                    deadline,
                )));
                sockets.push(socket);
            }
            Err(error) => {
                setup_error = Some(error);
                break;
            }
        }
    }
    if let Some(error) = setup_error {
        for server in servers {
            server.abort();
        }
        return Err(error);
    }

    let mut cmd = tokio::process::Command::new("xray");
    // `-format json` обязателен: автоопределение формата (`core::GetFormat`) смотрит на
    // расширение аргумента, а у абстрактного сокета его нет (`Failed to get format of @…`).
    cmd.args(["run", "-test", "-format", "json"]);
    for socket in &sockets {
        cmd.arg("-c").arg(format!("@{socket}"));
    }
    cmd.env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let output = tokio::time::timeout(VALIDATION_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("Таймаут валидации конфига ({} с)", VALIDATION_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;

    // Конфиги уже выданы (или xray умер): серверы больше не нужны, абстрактные имена
    // освобождаются при закрытии листенеров.
    for server in servers {
        server.abort();
    }

    if output.status.success() {
        return Ok(());
    }

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(combined)
}

/// Отдаёт слушатель на свободном абстрактном адресе, производном от имени файла:
/// в обычном случае это сам basename (в strace/ps видно, какой конфиг валидируется).
/// Абстрактное пространство имён глобально в системе, поэтому на конфликт — файл с тем
/// же basename в наборе или параллельная валидация того же файла — берём порядковые
/// «-2», «-3», … пока адрес не освободится.
async fn bind_config_socket(file: &str) -> Result<(UnixListener, String), String> {
    const MAX_ATTEMPTS: u32 = 100;
    let base = socket_name_base(file);
    for attempt in 1..=MAX_ATTEMPTS {
        let name = if attempt == 1 {
            base.clone()
        } else {
            format!("{base}-{attempt}")
        };
        match UnixListener::bind(format!("\0{name}")) {
            Ok(listener) => return Ok((listener, name)),
            Err(e) if attempt == MAX_ATTEMPTS => {
                return Err(format!("Не удалось открыть сокет выдачи конфига {name}: {e}"));
            }
            Err(_) => {}
        }
    }
    unreachable!("loop has MAX_ATTEMPTS iterations")
}

/// Читаемое основание абстрактного имени для файла конфига — его basename.
/// Оставляем только безопасные символы (буквы/цифры, '-', '_', '.'), всё прочее —
/// '_': последовательность ':/' внутри имени транспорт Xray
/// (`common/utils::SplitHTTPUnixURL`) трактует как разделитель HTTP-пути, а '@'
/// меняет вид сокета (padded abstract). Лимиты: абстрактный адрес — не больше
/// 106 байт (`sun_path[108]`: ведущий байт — `\0`, абстрактные адреса не
/// терминируются), плюс резерв на конфликтный порядковый «-99». Неожиданно длинный
/// basename укорачиваем, оставляя хвостом короткий отпечаток полного пути
/// (fnv1a-32) — сохраняет различимость файлов из разных каталогов.
fn socket_name_base(file: &str) -> String {
    const LIMIT: usize = 106 - 3; // итоговое имя ≤ 106 байт: base + «-99»
    const FINGERPRINT: usize = 9; // «-xxxxxxxx» — 8 hex-символов

    let mut name: String = Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        name = "config.json".into();
    }
    if name.len() > LIMIT - FINGERPRINT {
        name.truncate(LIMIT - FINGERPRINT);
        name.push_str(&format!("-{:08x}", fnv1a32(file.as_bytes())));
    }
    name
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[derive(Deserialize)]
struct MihomoError {
    message: String,
}

fn api_ok() -> Json<ApiResponse<()>> {
    Json(ApiResponse {
        success: true,
        error: None,
        data: None,
    })
}

fn api_error(error: impl Into<String>) -> Json<ApiResponse<()>> {
    Json(ApiResponse {
        success: false,
        error: Some(error.into()),
        data: None,
    })
}

struct MihomoApiCreds {
    port: Option<u16>,
    secret: Option<String>,
    unix_path: Option<String>,
}

fn yaml_value_to_string(value: &yaml_rust2::Yaml) -> Option<String> {
    match value {
        yaml_rust2::Yaml::String(s) => Some(s.clone()),
        yaml_rust2::Yaml::Integer(i) => Some(i.to_string()),
        yaml_rust2::Yaml::Real(s) => Some(s.clone()),
        yaml_rust2::Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn parse_mihomo_api_creds(yaml_content: &str) -> MihomoApiCreds {
    let mut creds = MihomoApiCreds {
        port: None,
        secret: None,
        unix_path: None,
    };
    let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(yaml_content) else {
        return creds;
    };
    let Some(doc) = docs.first() else { return creds };
    if let Some(unix_val) = yaml_value_to_string(&doc["external-controller-unix"]) {
        let trimmed = unix_val.trim();
        if !trimmed.is_empty()
            && let Some(name) = Path::new(trimmed)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
        {
            creds.unix_path = Some(format!("{}/{}", MIHOMO_CONF_DIR, name));
        }
    }
    if let Some(controller) = yaml_value_to_string(&doc["external-controller"])
        && let Some(port_str) = controller.trim().rsplit(':').next()
    {
        let port_str = port_str.trim().trim_matches(|c| c == '"' || c == '\'');
        if let Ok(port) = port_str.parse::<u16>() {
            creds.port = Some(port);
        }
    }
    if let Some(secret) = yaml_value_to_string(&doc["secret"]) {
        let trimmed = secret.trim().to_string();
        if !trimmed.is_empty() {
            creds.secret = Some(trimmed);
        }
    }
    creds
}

const HOT_RELOAD_UNAVAILABLE: &str = "Hot reload unavailable";

async fn apply_mihomo_hot_reload(
    state: &AppState, file: &str, content: &str, close_conns: bool,
) -> Json<ApiResponse<()>> {
    let main_config = format!("{}/config.yaml", MIHOMO_CONF_DIR);
    let creds_source = tokio::fs::read_to_string(&main_config).await.unwrap_or_default();
    let creds = parse_mihomo_api_creds(&creds_source);

    let previous = tokio::fs::read_to_string(file).await.ok();
    if let Err(error) = write_atomic(file, content, DEFAULT_MODE).await {
        return api_error(format!("Write error: {error}"));
    }

    let (client, base_url, secret) = match (creds.unix_path, creds.port) {
        (Some(socket_path), _) => match reqwest::Client::builder().unix_socket(socket_path).build() {
            Ok(client) => (client, "http://127.0.0.1".to_string(), None),
            Err(_) => return api_error(HOT_RELOAD_UNAVAILABLE),
        },
        (None, Some(port)) => (
            state.http_client.clone(),
            format!("http://127.0.0.1:{port}"),
            creds.secret,
        ),
        (None, None) => return api_error(HOT_RELOAD_UNAVAILABLE),
    };

    let mut request = client
        .put(format!("{base_url}/configs?force=true"))
        .json(&serde_json::json!({}))
        .timeout(Duration::from_secs(15));
    if let Some(secret) = secret.as_deref() {
        request = request.bearer_auth(secret);
    }
    let Ok(response) = request.send().await else {
        return api_error(HOT_RELOAD_UNAVAILABLE);
    };

    let status = response.status();
    if status == StatusCode::NO_CONTENT {
        if close_conns {
            let mut req = client
                .delete(format!("{base_url}/connections"))
                .timeout(Duration::from_secs(15));
            if let Some(secret) = secret.as_deref() {
                req = req.bearer_auth(secret);
            }
            if let Err(error) = req.send().await {
                log("ERROR", format!("Ошибка Mihomo: {error}"));
            }
        }
        return api_ok();
    }

    if status != StatusCode::BAD_REQUEST {
        return api_error(HOT_RELOAD_UNAVAILABLE);
    }

    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<MihomoError>(&body).map_or(body, |error| error.message);
    let detail = match message.trim() {
        "" => format!("Mihomo вернул {status}"),
        trimmed => trimmed.chars().take(2000).collect(),
    };
    log("ERROR", format!("Ошибка Mihomo: {detail}"));

    if let Some(old) = previous {
        _ = write_atomic(file, old, DEFAULT_MODE).await;
    } else {
        _ = tokio::fs::remove_file(file).await;
    }
    api_error("Validation failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(file: &str, content: &str) -> ConfigReq {
        ConfigReq {
            file: file.to_string(),
            content: content.to_string(),
        }
    }

    // Требует xray в PATH; без него просто пропускается.
    async fn xray_available() -> bool {
        tokio::process::Command::new("xray")
            .arg("version")
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }

    // Конфиг выдаётся через абстрактный сокет и проходит строгий тест.
    #[tokio::test(flavor = "multi_thread")]
    async fn valid_config_passes() {
        if !xray_available().await {
            return;
        }
        let files = vec![req(
            "/opt/etc/xray/00-log.json",
            r#"{"log":{"loglevel":"none"}}
{"inbounds":[],"outbounds":[{"protocol":"freedom","settings":{}}]}
"#,
        )];
        assert_eq!(validate_core(&files).await, Ok(()));
    }

    // Битый протокол — ошибка теста с текстом от самого xray.
    #[tokio::test(flavor = "multi_thread")]
    async fn broken_config_reports_xray_error() {
        if !xray_available().await {
            return;
        }
        let files = vec![req(
            "/opt/etc/xray/config.json",
            r#"{"inbounds":[],"outbounds":[{"protocol":"nonsense","settings":{}}]}"#,
        )];
        let result = validate_core(&files).await;
        assert!(result.unwrap_err().to_lowercase().contains("nonsense"));
    }

    // Несколько файлов мержатся в порядке имён, как из -confdir.
    #[tokio::test(flavor = "multi_thread")]
    async fn multiple_files_merge_like_confdir() {
        if !xray_available().await {
            return;
        }
        let files = vec![
            req(
                "/opt/etc/xray/10-out.json",
                r#"{"outbounds":[{"protocol":"freedom","settings":{}}]}"#,
            ),
            req("/opt/etc/xray/00-log.json", r#"{"log":{"loglevel":"none"}}"#),
            req("/opt/etc/xray/20-in.json", r#"{"inbounds":[]}"#),
        ];
        assert_eq!(validate_core(&files).await, Ok(()));
    }

    // Отсутствие json-файлов — валидировать нечего, выделение сокетов не нужно.
    #[tokio::test]
    async fn no_validatable_files_is_ok() {
        let files = vec![req("/opt/etc/xray/notes.lst", "runtime")];
        assert_eq!(validate_core(&files).await, Ok(()));
    }

    #[test]
    fn xkeen_dir_exposes_only_lists_and_xkeen_json() {
        assert!(is_xkeen_editable("/opt/etc/xkeen/ip_exclude.lst"));
        assert!(is_xkeen_editable("/opt/etc/xkeen/xkeen.json"));
        assert!(!is_xkeen_editable("/opt/etc/xkeen/xkeen-ui.json"));
        assert!(!is_xkeen_editable("/opt/etc/xkeen/xray-servers.json"));
        assert!(!is_xkeen_editable("/opt/etc/xkeen/sub/xkeen.json"));
        assert!(!is_xkeen_editable("/opt/etc/xray/configs/xkeen.json"));
    }

    // Сокет называется по файлу: читаемый basename, а не индексы.
    #[test]
    fn socket_name_base_is_readable_basename() {
        assert_eq!(socket_name_base("/opt/etc/xray/main.json"), "main.json");
        // Берётся только basename — каталоги в имени не участвуют.
        assert_eq!(socket_name_base("/opt/etc/xray/00-out.json"), "00-out.json");
        // Небезопасные символы (пробел, ':', '/' — последний Xray считает разделителем
        // HTTP-пути, ':' ломает SplitHTTPUnixURL) уводятся в '_'.
        assert_eq!(
            socket_name_base("/opt/etc/xray/main config:v2.json"),
            "main_config_v2.json"
        );
        assert_eq!(socket_name_base("/opt/etc/xray/a@b.json"), "a_b.json");
        // Не-UTF8-имя или вообще пустое — безопасный фолбэк.
        assert_eq!(socket_name_base("/"), "config.json");
    }

    // Слишком длинный basename укорачивается до лимита абстрактного адреса
    // и остаётся различимым за счёт отпечатка полного пути.
    #[test]
    fn long_basename_is_truncated_with_path_fingerprint() {
        let long = format!("/opt/etc/xray/{}.json", "a".repeat(200));
        let base = socket_name_base(&long);
        assert_eq!(base.len(), 103);
        // Усечение хвост резало вслепую — вместо «.json» может остаться отпечаток пути.
        assert!(base.starts_with(&"a".repeat(94)), "{base}");
        // Отпечаток полного пути: у короче лимита его нет.
        assert_eq!(socket_name_base("/opt/etc/xray/short.json"), "short.json");
    }

    // Одинаковые basename из разных каталогов получают разные адреса, пока оба слушателя живы.
    #[tokio::test]
    async fn same_basename_gets_distinct_abstract_names() {
        // Abstract sockets share a namespace with other tests and processes.
        let basename = format!("same-basename-{}.json", uuid::Uuid::new_v4());
        let (listener_a, name_a) = bind_config_socket(&format!("/dir-a/{basename}")).await.unwrap();
        let (listener_b, name_b) = bind_config_socket(&format!("/dir-b/{basename}")).await.unwrap();
        assert_eq!(name_a, basename);
        assert_eq!(name_b, format!("{basename}-2"));
        drop((listener_a, listener_b));
        let (_listener, reused) = bind_config_socket(&format!("/dir-a/{basename}")).await.unwrap();
        assert_eq!(reused, basename);
    }

    // Файлы с одинаковым basename из разных каталогов валидируются вместе:
    // конфликт по имени сокета решается порядковым суффиксом, а мерж xray — по своим правилам.
    #[tokio::test(flavor = "multi_thread")]
    async fn duplicate_basenames_validate_independently() {
        if !xray_available().await {
            return;
        }
        let files = vec![
            req("/opt/etc/xray2/10-part.json", r#"{"log":{"loglevel":"none"}}"#),
            req(
                "/opt/etc/xray/10-part.json",
                r#"{"outbounds":[{"protocol":"freedom","settings":{}}]}"#,
            ),
        ];
        assert_eq!(validate_core(&files).await, Ok(()));
    }
}
