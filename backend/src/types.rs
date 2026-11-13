use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Instant;
use tokio::sync::{Mutex, broadcast, watch};
use tokio::task::AbortHandle;

pub const UI_REPOSITORY: &str = match option_env!("XKEEN_UI_REPOSITORY") {
    Some(repository) => repository,
    None => "nvorobev/XKeenUI",
};

pub const APP_CONFIG: &str = "/opt/etc/xkeen/xkeen-ui.json";
pub const APP_CONFIG_LEGACY: &str = "/opt/share/www/XKeen-UI/config.json";
pub const DEFAULT_ACCESS_LOG: &str = "/opt/var/log/xray/access.log";
pub const DEFAULT_ERROR_LOG: &str = "/opt/var/log/xray/error.log";
pub const MIHOMO_CONF: &str = "/opt/etc/mihomo/config.yaml";
pub const MIHOMO_CONF_DIR: &str = "/opt/etc/mihomo";
pub const S24XRAY: &str = "/opt/etc/init.d/S24xray";
pub const S99XKEEN: &str = "/opt/etc/init.d/S99xkeen";
pub const S99XKEEN_UI: &str = "/opt/etc/init.d/S99xkeen-ui";
pub const VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub const XKEEN_CONF_DIR: &str = "/opt/etc/xkeen";
pub const XKEEN_CONF: &str = "/opt/etc/xkeen/xkeen.json";
pub const XKEEN_UI_LOG: &str = "/opt/var/log/xkeen-ui.log";
pub const XRAY_ASSET_DIR: &str = "/opt/etc/xray/dat";
pub const XRAY_CONF_DIR: &str = "/opt/etc/xray/configs";

pub type GeoCache = std::collections::HashMap<String, (std::time::SystemTime, bool, bool)>;

#[derive(Clone)]
pub struct XrayLogPaths {
    pub error: String,
    pub access: String,
}

impl Default for XrayLogPaths {
    fn default() -> Self {
        Self {
            error: DEFAULT_ERROR_LOG.into(),
            access: DEFAULT_ACCESS_LOG.into(),
        }
    }
}

static XRAY_LOG_PATHS: LazyLock<RwLock<XrayLogPaths>> = LazyLock::new(|| RwLock::new(XrayLogPaths::default()));

/// The directory Xray logs must live in: the journal reads and clears these files, so a path
/// taken from a config must not point at anything else (the panel config, sessions, devices).
const XRAY_LOG_ROOT: &str = "/opt/var/log";

/// Whether `path` is a regular location inside `root`: absolute, no `..`, and, once symlinks are
/// resolved for the parts that exist, still inside `root`.
fn is_log_path_allowed(path: &str, root: &str) -> bool {
    use std::path::{Component, Path};

    let candidate = Path::new(path);
    if !candidate.is_absolute()
        || !candidate.starts_with(root)
        || candidate.components().any(|c| matches!(c, Component::ParentDir))
    {
        return false;
    }
    // Resolve the deepest existing ancestor (the file itself may not exist yet).
    let Ok(root_real) = std::fs::canonicalize(root) else {
        return true;
    };
    let mut existing = candidate;
    loop {
        match std::fs::canonicalize(existing) {
            Ok(real) => {
                if !real.starts_with(&root_real) {
                    return false;
                }
                // An existing file must be a regular file, not a device or directory.
                return existing != candidate || real.is_file();
            }
            Err(_) => match existing.parent() {
                Some(parent) => existing = parent,
                None => return false,
            },
        }
    }
}

fn normalize_xray_log_path(path: Option<&str>, fallback: &str) -> String {
    normalize_xray_log_path_in(path, fallback, XRAY_LOG_ROOT)
}

fn normalize_xray_log_path_in(path: Option<&str>, fallback: &str, root: &str) -> String {
    path.map(str::trim)
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("none"))
        .filter(|p| {
            let allowed = is_log_path_allowed(p, root);
            if !allowed {
                crate::logger::log(
                    "WARN",
                    format!("Путь журнала Xray {p} вне {root}, используется {fallback}"),
                );
            }
            allowed
        })
        .unwrap_or(fallback)
        .to_string()
}

fn resolve_xray_log_paths() -> XrayLogPaths {
    let mut paths = XrayLogPaths::default();
    let Ok(entries) = std::fs::read_dir(XRAY_CONF_DIR) else {
        return paths;
    };

    let mut json_files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")))
        .collect();

    json_files.sort();

    for path in json_files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Xray configs may carry comments and trailing commas (JSONC).
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&crate::jsonc::strip_jsonc(&text)) else {
            continue;
        };

        if let Some(log) = json.get("log").and_then(|v| v.as_object()) {
            if let Some(access) = log.get("access").and_then(|v| v.as_str()) {
                paths.access = normalize_xray_log_path(Some(access), DEFAULT_ACCESS_LOG);
            }
            if let Some(error) = log.get("error").and_then(|v| v.as_str()) {
                paths.error = normalize_xray_log_path(Some(error), DEFAULT_ERROR_LOG);
            }
        }
    }

    paths
}

/// Re-reads the log paths from the Xray configs; true when they changed.
pub fn refresh_xray_log_paths() -> bool {
    let next = resolve_xray_log_paths();
    let mut paths = XRAY_LOG_PATHS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let changed = paths.access != next.access || paths.error != next.error;
    *paths = next;
    changed
}

pub fn error_log_path() -> String {
    XRAY_LOG_PATHS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .error
        .clone()
}

pub fn access_log_path() -> String {
    XRAY_LOG_PATHS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .access
        .clone()
}

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<RwLock<CoreInfo>>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub init_file: Arc<RwLock<Option<String>>>,
    pub http_client: reqwest::Client,
    /// Клиент без общего таймаута запроса — для загрузки файлов обновлений (прогресс отменяется вручную).
    pub update_client: reqwest::Client,
    pub update_checker: UpdateChecker,
    pub update_session: UpdateSession,
    pub geo_cache: Arc<RwLock<GeoCache>>,
    pub log_tx: Arc<broadcast::Sender<String>>,
    pub log_watcher: Arc<Mutex<Option<AbortHandle>>>,
    pub app_config_lock: Arc<Mutex<()>>,
    pub debug: bool,
    pub rci_token: Option<String>,
}

#[derive(Clone, Default)]
pub struct UpdateChecker {
    pub ui_outdated: Arc<RwLock<bool>>,
    pub core_outdated: Arc<RwLock<bool>>,
    pub last_ui_check: Arc<RwLock<Option<Instant>>>,
    pub last_core_check: Arc<RwLock<Option<Instant>>>,
    pub last_ui_failure: Arc<RwLock<Option<Instant>>>,
    pub last_core_failure: Arc<RwLock<Option<Instant>>>,
    pub last_ui_toast: Arc<RwLock<Option<Instant>>>,
    pub last_core_toast: Arc<RwLock<Option<Instant>>>,
    pub ui_latest_tag: Arc<RwLock<Option<String>>>,
    pub core_latest_tag: Arc<RwLock<Option<String>>>,
}

/// Событие процесса обновления с монотонным номером — рассылается по WebSocket
/// и копится в истории сессии. `seq` позволяет получателям дедуплицировать
/// события, приходящие и из истории, и из broadcast-потока.
#[derive(Clone, Serialize)]
pub struct UpdateEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub data: UpdateEventData,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UpdateEventData {
    Stage { stage: String },
    Log { ts: String, level: String, message: String },
    Progress { downloaded: u64, total: u64, speed: f64 },
    Done { success: bool, error: Option<String> },
}

/// Команда управляющих кнопок окна обновления.
#[derive(Clone, Copy, PartialEq)]
pub enum UpdateCtl {
    Run,
    Cancel,
    Proxy,
}

#[derive(Clone)]
pub struct UpdateSession {
    pub events: broadcast::Sender<UpdateEvent>,
    pub history: Arc<RwLock<Vec<UpdateEvent>>>,
    pub control: Arc<watch::Sender<UpdateCtl>>,
    pub ctl_rx: watch::Receiver<UpdateCtl>,
    pub running: Arc<AtomicBool>,
    seq: Arc<std::sync::Mutex<u64>>,
}

impl Default for UpdateSession {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateSession {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(512);
        let (control, ctl_rx) = watch::channel(UpdateCtl::Run);
        Self {
            events,
            history: Arc::new(RwLock::new(Vec::new())),
            control: Arc::new(control),
            ctl_rx,
            running: Arc::new(AtomicBool::new(false)),
            seq: Arc::new(std::sync::Mutex::new(0)),
        }
    }

    pub fn emit(&self, data: UpdateEventData) {
        let mut h = self.history.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = {
            let mut counter = self.seq.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            *counter += 1;
            *counter
        };
        let event = UpdateEvent { seq, data };
        if matches!(event.data, UpdateEventData::Progress { .. })
            && matches!(
                h.last(),
                Some(UpdateEvent {
                    data: UpdateEventData::Progress { .. },
                    ..
                })
            )
        {
            h.pop();
        }
        h.push(event.clone());
        if h.len() > 200 {
            let excess = h.len() - 200;
            h.drain(..excess);
        }
        _ = self.events.send(event);
    }

    pub fn stage(&self, stage: &str) {
        self.emit(UpdateEventData::Stage { stage: stage.into() });
    }

    pub fn log(&self, level: &str, message: impl Into<String>) {
        self.emit(UpdateEventData::Log {
            ts: chrono::Local::now().format("%H:%M:%S").to_string(),
            level: level.into(),
            message: message.into(),
        });
    }

    pub fn progress(&self, downloaded: u64, total: u64, speed: f64) {
        self.emit(UpdateEventData::Progress {
            downloaded,
            total,
            speed,
        });
    }

    pub fn done(&self, success: bool, error: Option<String>) {
        self.emit(UpdateEventData::Done { success, error });
    }

    pub fn cancelled(&self) -> bool {
        *self.ctl_rx.borrow() == UpdateCtl::Cancel
    }

    /// Атомарно начинает сессию обновления; false, если обновление уже выполняется.
    pub fn try_begin(&self) -> bool {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        self.history
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        _ = self.control.send(UpdateCtl::Run);
        true
    }

    pub fn finish(&self) {
        self.running.store(false, Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        _ = self.control.send(UpdateCtl::Cancel);
    }

    pub fn switch_to_proxy(&self) {
        _ = self.control.send(UpdateCtl::Proxy);
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreInfo {
    pub name: String,
    pub conf_dir: String,
    pub is_json: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct GuiSettings {
    pub routing: bool,
    pub outbounds: bool,
    pub log: bool,
    pub auto_apply: bool,
}

pub const DEFAULT_CHECK_INTERVAL_HOURS: u32 = 2;
pub const MAX_CHECK_INTERVAL_HOURS: u32 = 24;

fn deserialize_check_interval<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum LegacyOrHours {
        Legacy(bool),
        Hours(u32),
    }
    Ok(match LegacyOrHours::deserialize(deserializer)? {
        LegacyOrHours::Legacy(enabled) => u32::from(enabled) * DEFAULT_CHECK_INTERVAL_HOURS,
        LegacyOrHours::Hours(hours) => hours,
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterSettings {
    #[serde(deserialize_with = "deserialize_check_interval")]
    pub auto_check_ui: u32,
    #[serde(deserialize_with = "deserialize_check_interval")]
    pub auto_check_core: u32,
    pub backup_core: bool,
    pub github_proxy: Vec<String>,
    pub xray_repo: String,
    pub mihomo_repo: String,
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        Self {
            github_proxy: vec!["https://gh-proxy.com".into(), "https://ghfast.top".into()],
            xray_repo: "https://github.com/XTLS/Xray-core".into(),
            mihomo_repo: "https://github.com/MetaCubeX/mihomo".into(),
            backup_core: false,
            auto_check_ui: DEFAULT_CHECK_INTERVAL_HOURS,
            auto_check_core: DEFAULT_CHECK_INTERVAL_HOURS,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogSettings {
    pub timezone: i32,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self { timezone: 3 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PingMode {
    Single,
    Double,
    DoubleKeepAlive,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClashApiSettings {
    pub ping_url: String,
    pub ping_timeout: u32,
    pub show_source_name: bool,
    pub hide_unavailable_proxies: bool,
    pub hide_unavailable_proxies_counter: u32,
    pub proxy_sort_order: String,
    pub auto_dns: String,
    pub close_connections_on_apply: bool,
    pub mobile_layout: bool,
    pub ping_mode: PingMode,
}

impl Default for ClashApiSettings {
    fn default() -> Self {
        Self {
            ping_url: "https://yahoo.com".into(),
            ping_timeout: 5000,
            show_source_name: false,
            hide_unavailable_proxies: false,
            hide_unavailable_proxies_counter: 3,
            proxy_sort_order: "default".into(),
            auto_dns: "disabled".into(),
            close_connections_on_apply: false,
            mobile_layout: true,
            ping_mode: PingMode::DoubleKeepAlive,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PanelUser {
    pub username: String,
    pub password_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthSettings {
    pub enabled: bool,
    pub password_hash: Option<String>,
    pub session_ids: Vec<String>,
    pub users: Vec<PanelUser>,
    pub session_users: std::collections::HashMap<String, String>,
}

impl Default for AuthSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            password_hash: None,
            session_ids: Vec::new(),
            users: Vec::new(),
            session_users: Default::default(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppendConfigPaths {
    pub xray: Vec<String>,
    pub mihomo: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UiSettings {
    pub hidden_files: Vec<String>,
}

pub const DEFAULT_CONFIG_HISTORY_MAX_SNAPSHOTS: usize = 0;
pub const MAX_CONFIG_HISTORY_SNAPSHOTS: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigHistorySettings {
    pub max_snapshots: usize,
}

impl Default for ConfigHistorySettings {
    fn default() -> Self {
        Self {
            max_snapshots: DEFAULT_CONFIG_HISTORY_MAX_SNAPSHOTS,
        }
    }
}

#[derive(Clone, Serialize, Default)]
pub struct AppSettings {
    pub gui: GuiSettings,
    pub updater: UpdaterSettings,
    pub log: LogSettings,
    pub clash_api: ClashApiSettings,
    pub append_config_paths: AppendConfigPaths,
    pub auth: AuthSettings,
    pub ui: UiSettings,
    pub config_history: ConfigHistorySettings,
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawConfig {
            #[serde(default)]
            gui: GuiSettings,
            #[serde(default)]
            updater: UpdaterSettings,
            #[serde(default)]
            log: LogSettings,
            #[serde(default)]
            clash_api: ClashApiSettings,
            #[serde(default)]
            append_config_paths: AppendConfigPaths,
            #[serde(default)]
            auth: AuthSettings,
            #[serde(default)]
            ui: UiSettings,
            #[serde(default)]
            config_history: ConfigHistorySettings,
            #[serde(rename = "timezoneOffset")]
            legacy_tz: Option<i32>,
        }
        let mut raw = RawConfig::deserialize(deserializer)?;
        if let Some(tz) = raw.legacy_tz {
            raw.log.timezone = tz;
        }
        Ok(Self {
            gui: raw.gui,
            updater: raw.updater,
            log: raw.log,
            clash_api: raw.clash_api,
            append_config_paths: raw.append_config_paths,
            auth: raw.auth,
            ui: raw.ui,
            config_history: raw.config_history,
        })
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.updater.github_proxy = self
            .updater
            .github_proxy
            .iter()
            .map(|p| {
                if p.starts_with("http") {
                    p.to_string()
                } else {
                    format!("https://{}", p.trim_start_matches("://"))
                }
            })
            .collect();
    }
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Option<T>,
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub core: String,
    pub version: String,
    pub backup_core: bool,
    #[serde(default)]
    pub assets: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateControlReq {
    pub action: String,
}

#[cfg(test)]
mod log_path_tests {
    use super::*;

    #[test]
    fn log_path_must_stay_in_log_root() {
        let root = std::env::temp_dir().join(format!("xkeen-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("xray")).unwrap();
        let root_str = root.to_str().unwrap();
        let fallback = "/fallback.log";
        let ok = format!("{root_str}/xray/access.log");
        assert_eq!(normalize_xray_log_path_in(Some(&ok), fallback, root_str), ok);
        let new_dir = format!("{root_str}/new/dir/a.log");
        assert_eq!(normalize_xray_log_path_in(Some(&new_dir), fallback, root_str), new_dir);
        for bad in [
            "/opt/etc/xkeen/xkeen-ui.json".to_string(),
            "/dev/zero".to_string(),
            format!("{root_str}/../etc/passwd"),
            "relative.log".to_string(),
            format!("{root_str}/xray"),
        ] {
            assert_eq!(
                normalize_xray_log_path_in(Some(&bad), fallback, root_str),
                fallback,
                "{bad}"
            );
        }
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        let through_link = format!("{root_str}/link/hosts");
        assert_eq!(
            normalize_xray_log_path_in(Some(&through_link), fallback, root_str),
            fallback
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
