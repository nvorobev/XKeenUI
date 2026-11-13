use crate::logger::log;
use crate::types::{APP_CONFIG, ApiResponse, AppState, MIHOMO_CONF_DIR, XKEEN_CONF_DIR, XRAY_CONF_DIR};
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use chrono::{DateTime, FixedOffset, Offset, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use tar::{Archive, Builder};

fn mtime_string(time: Result<SystemTime, std::io::Error>, tz: i32) -> String {
    let secs = time
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    match FixedOffset::east_opt(tz * 3600) {
        Some(offset) => DateTime::from_timestamp(secs, 0)
            .map(|dt| dt.with_timezone(&offset).format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

const BACKUP_DIR: &str = "/opt/backups";
const BACKUP_SUFFIX: &str = "xkeen-ui.tar";
const CONTENT_ORDER: [&str; 4] = ["xkeen", "xkeen-ui", "xray", "mihomo"];

#[derive(Serialize)]
struct BackupListData {
    backups: Vec<BackupItem>,
}

#[derive(Serialize)]
struct BackupData {
    backup: BackupItem,
}

#[derive(Serialize, Clone)]
struct BackupItem {
    name: String,
    mtime: String,
    size: u64,
    content: BackupContentFiles,
}

#[derive(Serialize, Clone, Default)]
struct BackupContentFiles {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xkeen: Vec<String>,
    #[serde(rename = "xkeen-ui", skip_serializing_if = "Vec::is_empty")]
    xkeen_ui: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xray: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mihomo: Vec<String>,
}

impl BackupContentFiles {
    fn insert(&mut self, key: &str, file: String) {
        match key {
            "xkeen" => self.xkeen.push(file),
            "xkeen-ui" => self.xkeen_ui.push(file),
            "xray" => self.xray.push(file),
            "mihomo" => self.mihomo.push(file),
            _ => unreachable!("unknown backup content: {key}"),
        }
    }

    fn sort(&mut self) {
        self.xkeen.sort();
        self.xkeen_ui.sort();
        self.xray.sort();
        self.mihomo.sort();
    }
}

#[derive(Deserialize)]
pub struct BackupReq {
    name: String,
    contents: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct BackupRenameReq {
    name: String,
    new_name: String,
}

async fn run_blocking<T: Serialize>(
    task: tokio::task::JoinHandle<Result<Option<T>, String>>, err_msg: &str,
) -> impl IntoResponse {
    match task.await {
        Ok(Ok(data)) => Json(ApiResponse {
            success: true,
            error: None,
            data,
        })
        .into_response(),
        Ok(Err(e)) => api_error(format!("{err_msg}: {e}")).into_response(),
        Err(e) => api_error(format!("{err_msg}: {e}")).into_response(),
    }
}

pub async fn get_backups(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .log
        .timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || list_backups_sync(tz).map(|backups| Some(BackupListData { backups }))),
        "Не удалось получить список бэкапов",
    )
    .await
}

pub async fn put_backup(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .log
        .timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || create_backup_sync(tz).map(|backup| Some(BackupData { backup }))),
        "Не удалось создать бэкап",
    )
    .await
}

pub async fn post_backup(State(state): State<AppState>, Json(req): Json<BackupReq>) -> impl IntoResponse {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    // The panel settings are read and rewritten here: a password change at the same moment
    // must wait, or the restored file would carry the access from before it.
    let _config_guard = state.app_config_lock.lock().await;
    let touches_xray = req
        .contents
        .as_ref()
        .is_none_or(|contents| contents.iter().any(|content| content == "xray"));
    if touches_xray && crate::xray_servers::is_active().await {
        return api_error("Сначала отключите управление в окне «Серверы Xray»: бэкап перезапишет его файлы".into())
            .into_response();
    }
    run_blocking(
        tokio::task::spawn_blocking(move || restore_backup_sync(&req.name, req.contents).map(|_| None::<()>)),
        "Не удалось восстановить бэкап",
    )
    .await
    .into_response()
}

pub async fn delete_backup(Json(req): Json<BackupReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || delete_backup_sync(&req.name).map(|_| None::<()>)),
        "Не удалось удалить бэкап",
    )
    .await
}

pub async fn patch_backup(Json(req): Json<BackupRenameReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || rename_backup_sync(&req.name, &req.new_name).map(|_| None::<()>)),
        "Не удалось переименовать бэкап",
    )
    .await
}

fn api_error(message: String) -> Json<ApiResponse<()>> {
    Json(ApiResponse {
        success: false,
        error: Some(message),
        data: None,
    })
}

fn list_backups_sync(tz: i32) -> Result<Vec<BackupItem>, String> {
    ensure_backup_dir().map_err(io_error)?;
    let entries = fs::read_dir(BACKUP_DIR).map_err(io_error)?;
    let mut backups = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_tar_file(&path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(md) => md,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать метаданные {}: {}", path.display(), e),
                );
                continue;
            }
        };

        let content = match inspect_backup_content(&path) {
            Ok(res) => res,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать содержимое бэкапа {}: {}", path.display(), e),
                );
                BackupContentFiles::default()
            }
        };

        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };

        backups.push(BackupItem {
            name: name.to_string(),
            mtime: mtime_string(metadata.modified(), tz),
            size: metadata.len(),
            content,
        });
    }

    Ok(backups)
}

fn create_backup_sync(tz: i32) -> Result<BackupItem, String> {
    ensure_backup_dir().map_err(io_error)?;
    let files = collect_backup_files().map_err(io_error)?;
    if files.is_empty() {
        return Err("не найдено ни одного файла для архивации".into());
    }

    let name = next_backup_name(tz);
    let final_path = Path::new(BACKUP_DIR).join(&name);
    let temp_path = final_path.with_extension("tar.tmp");
    let content = collect_backup_content(files.iter().map(|(_, rel)| rel.as_str()));

    let write_result = (|| -> io::Result<()> {
        let file = File::create(&temp_path)?;
        let mut builder = Builder::new(file);
        builder.follow_symlinks(true);
        for (source, relative) in &files {
            builder.append_path_with_name(source, relative)?;
        }
        builder.finish()?;
        let file = builder.into_inner()?;
        file.sync_all()?;
        fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error(error));
    }

    let metadata = fs::metadata(&final_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций создан: {}", final_path.display()));

    Ok(BackupItem {
        name: name.clone(),
        mtime: mtime_string(metadata.modified(), tz),
        size: metadata.len(),
        content,
    })
}

fn restore_backup_sync(name: &str, requested_contents: Option<Vec<String>>) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    let requested_contents = normalize_requested_contents(requested_contents)?;
    validate_backup_entries(&backup_path)?;

    let file = File::open(&backup_path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut restored_contents = HashSet::new();

    for entry in entries {
        let mut entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        let content = detect_content_key(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        if requested_contents
            .as_ref()
            .is_some_and(|contents| !contents.contains(content))
        {
            continue;
        }
        let target =
            archive_relative_to_target(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }

        let mut data = Vec::new();
        io::Read::read_to_end(&mut entry, &mut data).map_err(io_error)?;
        if content == "xkeen-ui" {
            data = keep_current_access(&data, fs::read_to_string(APP_CONFIG).ok().as_deref())?;
        }
        // An existing file keeps its mode; a new one gets the mode stored in the archive.
        let default_mode = entry
            .header()
            .mode()
            .map_or(crate::fsutil::DEFAULT_MODE, |mode| mode & 0o777);
        crate::fsutil::write_atomic_sync(&target, &data, default_mode).map_err(io_error)?;

        restored_contents.insert(content);
    }

    validate_restored_contents(&requested_contents, &restored_contents)?;
    log("INFO", restore_log_message(&backup_path, &requested_contents));
    Ok(())
}

/// Panel settings restored from a backup keep the current accounts, sessions and login
/// switch, and the file access of the config editor: an old copy must not bring back a
/// disabled login, a former password or wider access.
fn keep_current_access(backup: &[u8], current: Option<&str>) -> Result<Vec<u8>, String> {
    let mut restored: serde_json::Value =
        serde_json::from_slice(backup).map_err(|e| format!("настройки панели в бэкапе повреждены: {e}"))?;
    let current: Option<serde_json::Value> = current.and_then(|text| serde_json::from_str(text).ok());
    let restored_map = restored
        .as_object_mut()
        .ok_or("настройки панели в бэкапе повреждены: нужен JSON-объект")?;
    for key in ["auth", "append_config_paths"] {
        match current.as_ref().and_then(|value| value.get(key)) {
            Some(value) => {
                restored_map.insert(key.into(), value.clone());
            }
            None => {
                restored_map.remove(key);
            }
        }
    }
    serde_json::to_vec_pretty(&restored).map_err(|e| e.to_string())
}

fn delete_backup_sync(name: &str) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    fs::remove_file(&backup_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций удалён: {}", backup_path.display()));
    Ok(())
}

fn rename_backup_sync(name: &str, new_name: &str) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    let new_name = new_name.trim();
    if new_name.is_empty()
        || new_name.contains('/')
        || new_name.contains('\\')
        || new_name.contains("..")
        || !is_backup_name(Some(new_name))
    {
        return Err("некорректное имя файла".into());
    }
    let new_path = Path::new(BACKUP_DIR).join(new_name);
    if new_path.exists() {
        return Err("файл с таким именем уже существует".into());
    }
    fs::rename(&backup_path, &new_path).map_err(io_error)?;
    log(
        "INFO",
        format!(
            "Бэкап конфигураций переименован: {} -> {}",
            backup_path.display(),
            new_path.display()
        ),
    );
    Ok(())
}

fn ensure_backup_dir() -> io::Result<()> {
    fs::create_dir_all(BACKUP_DIR)
}

fn is_tar_file(path: &Path) -> bool {
    path.is_file() && is_backup_name(path.file_name().and_then(|v| v.to_str()))
}

fn collect_backup_files() -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    files.extend(collect_dir_files(XKEEN_CONF_DIR, &["lst", "json"])?);
    files.extend(collect_dir_files(XRAY_CONF_DIR, &["json"])?);
    files.extend(collect_dir_files(MIHOMO_CONF_DIR, &["yaml", "yml"])?);
    files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(files)
}

fn collect_dir_files(dir: &str, exts: &[&str]) -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || !matches_extension(&path, exts) {
            continue;
        }
        files.push((path.clone(), to_archive_relative(&path)));
    }

    Ok(files)
}

fn matches_extension(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn to_archive_relative(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn resolve_backup_path(name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !is_backup_name(Some(name))
    {
        return Err("некорректное имя файла".into());
    }

    let path = Path::new(BACKUP_DIR).join(name);
    if !path.is_file() {
        return Err("файл не найден".into());
    }
    Ok(path)
}

fn inspect_backup_content(path: &Path) -> io::Result<BackupContentFiles> {
    let file = File::open(path)?;
    let mut archive = Archive::new(file);
    let mut content = BackupContentFiles::default();

    for entry in archive.entries()? {
        let entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let Ok(relative) = normalize_entry_path(&entry.path()?) else {
            continue;
        };
        if let Some(key) = detect_content_key(&relative) {
            content.insert(key, content_file_name(key, &relative));
        }
    }

    content.sort();
    Ok(content)
}

fn validate_backup_entries(path: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut seen = HashSet::new();
    let mut has_files = false;

    for entry in entries {
        let entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            return Err("архив содержит неподдерживаемые записи".into());
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        if archive_relative_to_target(&relative).is_none() {
            return Err(format!("недопустимый путь в архиве: {relative}"));
        }
        if !seen.insert(relative) {
            return Err("архив содержит дубликаты файлов".into());
        }
        has_files = true;
    }

    if !has_files {
        return Err("архив пустой".into());
    }

    Ok(())
}

fn normalize_entry_path(path: &Path) -> Result<String, &'static str> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            _ => return Err("обнаружен запрещённый компонент пути"),
        }
    }
    if parts.is_empty() {
        return Err("путь пустой");
    }
    Ok(parts.join("/"))
}

fn archive_relative_to_target(relative: &str) -> Option<PathBuf> {
    detect_content_key(relative).map(|_| PathBuf::from(format!("/{relative}")))
}

fn detect_content_key(relative: &str) -> Option<&'static str> {
    if relative == APP_CONFIG.trim_start_matches('/') {
        return Some("xkeen-ui");
    }

    let check_prefix = |prefix: &str, exts: &[&str]| {
        relative
            .strip_prefix(prefix.trim_start_matches('/'))
            .map(|rest| rest.trim_start_matches('/'))
            .filter(|name| !name.contains('/') && matches_file_name(name, exts))
    };

    if check_prefix(XKEEN_CONF_DIR, &["lst", "json"]).is_some() {
        return Some("xkeen");
    }
    if check_prefix(XRAY_CONF_DIR, &["json"]).is_some() {
        return Some("xray");
    }
    if check_prefix(MIHOMO_CONF_DIR, &["yaml", "yml"]).is_some() {
        return Some("mihomo");
    }

    None
}

fn matches_file_name(name: &str, exts: &[&str]) -> bool {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn normalize_requested_contents(
    requested_contents: Option<Vec<String>>,
) -> Result<Option<HashSet<&'static str>>, String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(None);
    };
    if requested_contents.is_empty() {
        return Err("не указаны категории для восстановления".into());
    }

    let mut contents = HashSet::new();
    for content in requested_contents {
        let Some(content) = parse_content_key(&content) else {
            return Err(format!("неизвестная категория: {content}"));
        };
        contents.insert(content);
    }

    Ok(Some(contents))
}

fn parse_content_key(value: &str) -> Option<&'static str> {
    CONTENT_ORDER.iter().copied().find(|&content| content == value)
}

fn validate_restored_contents(
    requested_contents: &Option<HashSet<&'static str>>, restored_contents: &HashSet<&'static str>,
) -> Result<(), String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(());
    };

    let missing = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content) && !restored_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>();

    if missing.is_empty() {
        return Ok(());
    }

    Err(format!("в архиве не найдены категории: {}", missing.join(", ")))
}

fn collect_backup_content<'a>(paths: impl Iterator<Item = &'a str>) -> BackupContentFiles {
    let mut content = BackupContentFiles::default();
    for path in paths {
        if let Some(key) = detect_content_key(path) {
            content.insert(key, content_file_name(key, path));
        }
    }
    content.sort();
    content
}

fn content_label(content: &str) -> &'static str {
    match content {
        "xkeen" => "XKeen",
        "xkeen-ui" => "XKeen UI",
        "xray" => "Xray",
        "mihomo" => "Mihomo",
        _ => unreachable!("unknown backup content: {content}"),
    }
}

fn content_file_name(key: &str, relative: &str) -> String {
    match key {
        "xkeen" => strip_content_prefix(relative, XKEEN_CONF_DIR),
        "xray" => strip_content_prefix(relative, XRAY_CONF_DIR),
        "mihomo" => strip_content_prefix(relative, MIHOMO_CONF_DIR),
        "xkeen-ui" => Path::new(relative)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(relative)
            .to_string(),
        _ => relative.to_string(),
    }
}

fn strip_content_prefix(relative: &str, root: &str) -> String {
    relative
        .strip_prefix(root.trim_start_matches('/'))
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or(relative)
        .to_string()
}

fn restore_log_message(backup_path: &Path, requested_contents: &Option<HashSet<&'static str>>) -> String {
    let Some(requested_contents) = requested_contents else {
        return format!("Конфигурации восстановлены из {}", backup_path.display());
    };

    let contents = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>()
        .join(", ");

    format!("Конфигурации {} восстановлены из {}", contents, backup_path.display())
}

fn next_backup_name(tz: i32) -> String {
    let base = backup_now(tz).format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut name = format!("{base}_{BACKUP_SUFFIX}");
    let mut index = 2;
    while Path::new(BACKUP_DIR).join(&name).exists() {
        name = format!("{base}_{index}_{BACKUP_SUFFIX}");
        index += 1;
    }
    name
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn is_backup_name(name: Option<&str>) -> bool {
    name.is_some_and(|v| v.ends_with(BACKUP_SUFFIX))
}

fn backup_now(tz: i32) -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&backup_offset(tz))
}

fn backup_offset(tz: i32) -> FixedOffset {
    FixedOffset::east_opt(tz.clamp(-12, 14) * 3600).unwrap_or_else(|| Utc.fix())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_panel_settings_keep_current_access() {
        let backup = br#"{"auth":{"enabled":false,"password_hash":"old"},"append_config_paths":{"xray":["/"]},"log":{"timezone":5}}"#;
        let current = r#"{"auth":{"enabled":true,"password_hash":"new"},"log":{"timezone":3}}"#;
        let restored: serde_json::Value =
            serde_json::from_slice(&keep_current_access(backup, Some(current)).unwrap()).unwrap();
        assert_eq!(
            restored["auth"],
            serde_json::json!({"enabled": true, "password_hash": "new"})
        );
        assert!(restored.get("append_config_paths").is_none());
        assert_eq!(restored["log"]["timezone"], 5);
        // Without a current file the copy brings no accounts at all: the panel then starts with admin/admin.
        let fresh: serde_json::Value = serde_json::from_slice(&keep_current_access(backup, None).unwrap()).unwrap();
        assert!(fresh.get("auth").is_none());
        assert!(keep_current_access(b"[1]", Some(current)).is_err());
    }
}
