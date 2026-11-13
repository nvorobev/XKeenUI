//! Persistent, bounded journals, independent of native init scripts truncating core logs.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const ERROR: &str = "/opt/var/log/xkeen-ui-journal.log";
pub const ACCESS: &str = "/opt/var/log/xkeen-ui-access.log";
pub const MAX_LINES: usize = 1000;
const STATE: &str = "/opt/var/log/xkeen-ui-journal-state.json";
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct Cursor {
    device: u64,
    inode: u64,
    offset: u64,
    anchor: Vec<u8>,
}

fn push(lines: &mut VecDeque<String>, line: String) {
    lines.push_back(line);
    while lines.len() > MAX_LINES {
        lines.pop_front();
    }
}

fn collect(sources: &[(String, PathBuf, bool)], state_path: &Path, event: Option<&str>) -> io::Result<()> {
    let mut cursors: BTreeMap<String, Cursor> = match fs::read(state_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error),
    };
    let mut output = BTreeMap::<PathBuf, VecDeque<String>>::new();
    let mut changed = false;
    for (source, target, panel) in sources {
        let seen: HashSet<String> = if *panel {
            output
                .get(target)
                .cloned()
                .unwrap_or_else(|| {
                    fs::read_to_string(target)
                        .unwrap_or_default()
                        .lines()
                        .map(str::to_owned)
                        .collect()
                })
                .into_iter()
                .collect()
        } else {
            HashSet::new()
        };
        let mut file = match File::open(source) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        let cursor = cursors.entry(source.clone()).or_default();
        let mut reset =
            cursor.device != metadata.dev() || cursor.inode != metadata.ino() || cursor.offset > metadata.len();
        if !reset && !cursor.anchor.is_empty() {
            file.seek(SeekFrom::Start(cursor.offset - cursor.anchor.len() as u64))?;
            let mut anchor = vec![0; cursor.anchor.len()];
            reset = file.read_exact(&mut anchor).is_err() || anchor != cursor.anchor;
        }
        if reset {
            cursor.offset = 0;
            changed = true;
        }
        file.seek(SeekFrom::Start(cursor.offset))?;
        let mut reader = BufReader::new(file);
        loop {
            let mut bytes = Vec::new();
            let read = reader.read_until(b'\n', &mut bytes)?;
            if read == 0 {
                break;
            }
            cursor.offset += read as u64;
            changed = true;
            let line = String::from_utf8_lossy(&bytes)
                .trim_end_matches(['\r', '\n'])
                .to_string();
            let lines = output.entry(target.clone()).or_insert_with(|| {
                let lines: VecDeque<_> = fs::read_to_string(target)
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_owned)
                    .collect();
                lines
            });
            // logger::log mirrors timestamped messages to both stdout and the core file.
            if *panel && line.as_bytes().get(4) == Some(&b'/') && seen.contains(&line) {
                continue;
            }
            push(lines, line);
        }
        let mut file = reader.into_inner();
        cursor.device = metadata.dev();
        cursor.inode = metadata.ino();
        let length = cursor.offset.min(64);
        file.seek(SeekFrom::Start(cursor.offset - length))?;
        cursor.anchor = vec![0; length as usize];
        if file.read_exact(&mut cursor.anchor).is_err() {
            cursor.anchor.clear();
            cursor.offset = 0;
        }
    }
    if let Some(event) = event {
        let target = &sources[0].1;
        let lines = output.entry(target.clone()).or_insert_with(|| {
            fs::read_to_string(target)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        });
        for line in event.lines() {
            push(lines, line.to_string());
        }
        changed = true;
    }
    for (path, lines) in output {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let start = lines.len().saturating_sub(MAX_LINES);
        let data = lines.into_iter().skip(start).collect::<Vec<_>>().join("\n") + "\n";
        crate::fsutil::write_atomic_sync(&path, data.as_bytes(), crate::fsutil::PRIVATE_MODE)?;
    }
    if changed {
        if let Some(parent) = state_path.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::fsutil::write_atomic_sync(
            state_path,
            &serde_json::to_vec(&cursors).map_err(io::Error::other)?,
            crate::fsutil::PRIVATE_MODE,
        )?;
    }
    Ok(())
}

fn capture(event: Option<&str>) -> io::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    collect(
        &[
            (crate::types::error_log_path(), PathBuf::from(ERROR), false),
            (crate::types::access_log_path(), PathBuf::from(ACCESS), false),
            ("/opt/var/log/xkeen-ui.log".into(), PathBuf::from(ERROR), true),
        ],
        Path::new(STATE),
        event,
    )
}

pub async fn record(message: String) {
    let line = crate::logger::format_plain_log("INFO", &message);
    match tokio::task::spawn_blocking(move || capture(Some(&line))).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Journal: {error}"),
        Err(error) => eprintln!("Journal task: {error}"),
    }
}

pub fn clear(access: bool) -> io::Result<()> {
    capture(None)?;
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    crate::fsutil::write_atomic_sync(
        Path::new(if access { ACCESS } else { ERROR }),
        b"",
        crate::fsutil::PRIVATE_MODE,
    )
}

pub fn start() {
    tokio::spawn(async {
        let mut last_error = String::new();
        loop {
            let error = match tokio::task::spawn_blocking(|| capture(None)).await {
                Ok(Ok(())) => String::new(),
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
            };
            if !error.is_empty() && error != last_error {
                eprintln!("Journal: {error}");
            }
            last_error = error;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn survives_restart_truncation_and_replacement_without_losing_history_and_keeps_last_thousand() {
        let dir = std::env::temp_dir().join(format!("journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("core.log");
        let target = dir.join("journal.log");
        let state = dir.join("state.json");
        let sources = [(source.to_string_lossy().to_string(), target.clone(), false)];
        fs::write(&source, "first launch\nfirst stop\n").unwrap();
        collect(&sources, &state, None).unwrap();
        collect(&sources, &state, None).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "first launch\nfirst stop\n");
        fs::write(&source, "second launch, longer than the previous file\n").unwrap();
        collect(&sources, &state, None).unwrap();
        assert!(
            fs::read_to_string(&target)
                .unwrap()
                .contains("first stop\nsecond launch")
        );
        fs::remove_file(&source).unwrap();
        fs::write(&source, (0..1100).map(|n| format!("line-{n}\n")).collect::<String>()).unwrap();
        collect(&sources, &state, None).unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert_eq!(text.lines().count(), 1000);
        assert!(text.starts_with("line-100\n"));
        assert!(text.ends_with("line-1099\n"));
        collect(&sources, &state, None).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), text);
        fs::remove_dir_all(dir).unwrap();
    }
}
