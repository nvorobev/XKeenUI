//! Persistent Xray server pool. The UI owns one balancer; other routing is preserved.
//! Probes and failover run here, independently of browser lifetime.
use crate::controller;
use crate::types::{AppState, XRAY_CONF_DIR};
use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

const STORE: &str = "/opt/etc/xkeen/xray-servers.json";
const LIBRARY: &str = "/opt/etc/xkeen/xray-server-library.json";
const JOURNAL: &str = "/opt/etc/xkeen/xray-servers-transaction.json";
const MANAGED_NAME: &str = "07_pool.json";
const LEGACY_MANAGED_NAME: &str = "zz-xkeen-ui-servers-tail.json";
const BALANCER: &str = "xkeen-ui-servers";
const PREFIX: &str = "xkeen-ui-server-";
// Top-level sections moved into the managed file while the pool is enabled.
const OWNED_KEYS: [&str; 2] = ["routing", "api"];

// Also taken by config mutations/control actions, so failover cannot race a core switch.
pub(crate) static ACTION_LOCK: Mutex<()> = Mutex::const_new(());
static RUNTIME: LazyLock<Mutex<Runtime>> = LazyLock::new(|| Mutex::new(Runtime::default()));
static CHECK_CHANGED: Notify = Notify::const_new();

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub outbound: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub target_tag: String,
    pub servers: Vec<Server>,
    pub selected_id: String,
    pub auto: bool,
    pub interval_secs: u64,
    // Older stores and clients only contain interval_secs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    pub failure_threshold: u32,
    pub probe_url: String,
    pub timeout_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            target_tag: String::new(),
            servers: Vec::new(),
            selected_id: String::new(),
            auto: false,
            interval_secs: 60,
            interval_ms: None,
            failure_threshold: 3,
            probe_url: "https://yahoo.com".into(),
            timeout_ms: 5000,
        }
    }
}

impl Settings {
    fn check_interval_ms(&self) -> u64 {
        self.interval_ms
            .unwrap_or_else(|| self.interval_secs.saturating_mul(1000))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FileChange {
    path: PathBuf,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Installed {
    settings: Settings,
    api_address: String,
    managed: String,
    originals: Vec<FileChange>,
    #[serde(default)]
    selected_since: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Probe {
    pub id: String,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Runtime {
    installed: Option<Installed>,
    probes: Vec<Probe>,
    failures: u32,
    error: Option<String>,
    last_check: Option<String>,
    last_switch: Option<String>,
    ready: bool,
}

#[derive(Clone)]
struct Document {
    path: PathBuf,
    text: String,
    value: Value,
}

fn alias(id: &str) -> String {
    format!("{PREFIX}{id}.")
}
pub(crate) fn is_managed_file(path: &Path) -> bool {
    path == managed_path() || path == legacy_managed_path()
}
fn managed_path() -> PathBuf {
    Path::new(XRAY_CONF_DIR).join(MANAGED_NAME)
}
fn legacy_managed_path() -> PathBuf {
    Path::new(XRAY_CONF_DIR).join(LEGACY_MANAGED_NAME)
}
fn pretty(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| e.to_string())
}
fn reply(result: Result<(), String>) -> Json<Value> {
    match result {
        Ok(()) => Json(json!({"success": true})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}
fn has_config_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "json" | "jsonc"))
}
fn owned_key(value: &Value) -> Option<&'static str> {
    OWNED_KEYS
        .into_iter()
        .find(|key| value.get(key).is_some_and(|v| !v.is_null()))
}
fn parse_object(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(&crate::jsonc::strip_jsonc(text))
        .ok()
        .filter(Value::is_object)
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    if settings.target_tag.trim().is_empty() || settings.target_tag.starts_with(PREFIX) {
        return Err("Выберите существующий outbound, трафиком которого нужно управлять".into());
    }
    if settings.servers.is_empty() || settings.servers.len() > 32 {
        return Err("Нужно от 1 до 32 серверов".into());
    }
    if !(1000..=3_600_000).contains(&settings.check_interval_ms())
        || !(1..=10).contains(&settings.failure_threshold)
        || !(500..=30000).contains(&settings.timeout_ms)
    {
        return Err("Интервал: 1000–3600000 мс; отказов подряд: 1–10; таймаут: 500–30000 мс".into());
    }
    let url = reqwest::Url::parse(&settings.probe_url).map_err(|_| "Некорректный URL проверки")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Для проверки нужен HTTP(S) URL".into());
    }
    let mut ids = HashSet::new();
    for server in &settings.servers {
        validate_server(server)?;
        if !ids.insert(&server.id) {
            return Err("Некорректный или повторяющийся ID сервера".into());
        }
    }
    if !ids.contains(&settings.selected_id) {
        return Err("Выбранный сервер отсутствует в списке".into());
    }
    Ok(())
}

fn validate_server(server: &Server) -> Result<(), String> {
    if uuid::Uuid::parse_str(&server.id).is_err() {
        return Err("Некорректный ID сервера".into());
    }
    if server.name.trim().is_empty() || server.name.chars().count() > 100 {
        return Err("Укажите имя сервера длиной до 100 символов".into());
    }
    if !standalone(&server.outbound) {
        return Err(format!(
            "{}: нужен самостоятельный proxy outbound без proxySettings/dialerProxy",
            server.name
        ));
    }
    Ok(())
}

fn standalone(outbound: &Value) -> bool {
    outbound
        .get("protocol")
        .and_then(Value::as_str)
        .is_some_and(|p| !matches!(p, "freedom" | "blackhole" | "dns" | "loopback") && !p.is_empty())
        && outbound.get("proxySettings").is_none_or(Value::is_null)
        && outbound
            .pointer("/streamSettings/sockopt/dialerProxy")
            .is_none_or(|v| v.as_str().is_none_or(str::is_empty))
}

async fn documents() -> Result<Vec<Document>, String> {
    let mut result = Vec::new();
    let mut entries = fs::read_dir(XRAY_CONF_DIR)
        .await
        .map_err(|e| format!("Конфиги Xray: {e}"))?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if !has_config_ext(&path) {
            continue;
        }
        // Never replace a symlink with an unrelated regular file.
        if entry.file_type().await.map_err(|e| e.to_string())?.is_symlink() {
            return Err(format!(
                "{}: управление серверами не поддерживает симлинки",
                path.display()
            ));
        }
        let text = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&crate::jsonc::strip_jsonc(&text))
            .map_err(|_| format!("{}: не удалось разобрать JSON/JSONC", path.display()))?;
        if !value.is_object() {
            return Err(format!("{}: ожидается JSON-объект", path.display()));
        }
        result.push(Document { path, text, value });
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

// Earlier user routing/api remain intact; the managed file supplies the effective
// pool configuration. Later routing/api or outbounds could override it.
fn check_layout(docs: &[Document]) -> Result<(), String> {
    let managed = managed_path();
    for doc in docs.iter().filter(|d| d.path != managed) {
        if doc.path > managed
            && (owned_key(&doc.value).is_some() || doc.value["outbounds"].as_array().is_some_and(|v| !v.is_empty()))
        {
            return Err(format!(
                "{} загружается после {MANAGED_NAME} и перекрывает пул серверов; переименуйте файл",
                doc.path.display()
            ));
        }
    }
    Ok(())
}

// Xray prepends new outbounds unless the filename contains `tail`, and replaces matching tags.
fn merged_outbounds(docs: &[Document]) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for doc in docs {
        let mut prepend = Vec::new();
        for outbound in doc.value["outbounds"].as_array().into_iter().flatten() {
            if let Some(index) = result
                .iter()
                .position(|v| outbound["tag"].as_str().is_some_and(|tag| v["tag"] == tag))
            {
                result[index] = outbound.clone();
            } else if doc
                .path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains("tail")
            {
                result.push(outbound.clone());
            } else {
                prepend.push(outbound.clone());
            }
        }
        prepend.extend(result);
        result = prepend;
    }
    result
}

fn pool_document(settings: &Settings, mut value: Value) -> Result<Value, String> {
    value["outbounds"] = Value::Array(
        settings
            .servers
            .iter()
            .map(|s| {
                let mut outbound = s.outbound.clone();
                outbound["tag"] = alias(&s.id).into();
                outbound
            })
            .collect(),
    );
    let balancers = value
        .pointer_mut("/routing/balancers")
        .and_then(Value::as_array_mut)
        .ok_or("Нет списка балансеров")?;
    balancers.retain(|v| v["tag"] != BALANCER);
    // Singleton prefix ending in '.' prevents prefix collisions. Disk state pins the chosen server even before the UI daemon reconnects.
    balancers
        .push(json!({"tag": BALANCER, "selector": [alias(&settings.selected_id)], "strategy": {"type": "random"}}));
    Ok(value)
}

fn prepare(settings: &Settings, docs: &[Document]) -> Result<(Value, Vec<FileChange>, String), String> {
    prepare_pool(settings, docs, false)
}

fn prepare_pool(
    settings: &Settings, docs: &[Document], allow_unused: bool,
) -> Result<(Value, Vec<FileChange>, String), String> {
    if docs.iter().any(|d| is_managed_file(&d.path)) {
        return Err(format!(
            "Найден {MANAGED_NAME} или файл, загружаемый после него. Если это остаток прежней настройки, нажмите «Отключить управление»"
        ));
    }
    check_layout(docs)?;
    let outbounds = merged_outbounds(docs);
    if !outbounds
        .iter()
        .any(|v| v["tag"] == settings.target_tag && standalone(v))
    {
        return Err("Выбранный исходный proxy outbound не найден".into());
    }
    let mut routing = docs
        .iter()
        .rev()
        .find_map(|d| d.value.get("routing").filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or(json!({}));
    if routing
        .get("script")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("Маршрутизация через script не поддерживается".into());
    }
    if !routing.is_object() {
        return Err("Неверный routing".into());
    }
    if routing.get("balancers").is_none() {
        routing["balancers"] = json!([]);
    }
    if routing["balancers"]
        .as_array()
        .is_none_or(|v| v.iter().any(|b| b["tag"] == BALANCER))
    {
        return Err("Имя балансера xkeen-ui-servers уже занято или balancers не является массивом".into());
    }
    if routing.get("rules").is_none() {
        routing["rules"] = json!([]);
    }
    let rules = routing["rules"]
        .as_array_mut()
        .ok_or("routing.rules должен быть массивом")?;
    let mut matched = false;
    for rule in rules.iter_mut() {
        if rule["outboundTag"] == settings.target_tag {
            rule.as_object_mut().ok_or("Неверное правило")?.remove("outboundTag");
            rule["balancerTag"] = BALANCER.into();
            matched = true;
        }
    }
    if outbounds.first().is_some_and(|v| v["tag"] == settings.target_tag) {
        rules.push(json!({"type": "field", "network": "tcp,udp", "balancerTag": BALANCER}));
        matched = true;
    } else {
        // 07_pool.json has no `tail` suffix, so Xray prepends its new outbounds.
        // Pin the original default explicitly instead of changing unmatched traffic.
        let default_tag = outbounds
            .first()
            .and_then(|v| v["tag"].as_str())
            .filter(|s| !s.is_empty())
            .ok_or("Для пула задайте tag исходному outbound по умолчанию")?;
        rules.push(json!({"type": "field", "network": "tcp,udp", "outboundTag": default_tag}));
    }
    if !matched && !allow_unused {
        return Err("Outbound не используется напрямую в правилах или как выход по умолчанию; выберите другой".into());
    }
    let mut api = docs
        .iter()
        .rev()
        .find_map(|d| d.value.get("api").filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or(json!({"tag": "xkeen-ui-api", "listen": "127.0.0.1:10085", "services": []}));
    let address = api["listen"]
        .as_str()
        .ok_or("Задайте локальный api.listen, например 127.0.0.1:10085")?
        .to_string();
    let parsed: SocketAddr = address
        .parse()
        .map_err(|_| "api.listen должен быть локальным IP:порт")?;
    if !parsed.ip().is_loopback() || parsed.port() == 0 {
        return Err("API Xray должен слушать loopback-адрес с ненулевым портом".into());
    }
    let services = api["services"]
        .as_array_mut()
        .ok_or("api.services должен быть массивом")?;
    if !services
        .iter()
        .any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case("RoutingService")))
    {
        services.push("RoutingService".into());
    }
    Ok((
        pool_document(settings, json!({"routing": routing, "api": api}))?,
        Vec::new(),
        address,
    ))
}

async fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path).await {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

async fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Нет родительской директории")?;
    fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    // Keep the mode of existing user configs; new files may hold credentials.
    crate::fsutil::write_atomic(path, text, crate::fsutil::PRIVATE_MODE)
        .await
        .map_err(|e| e.to_string())
}

async fn write_value(path: &Path, value: &Option<String>) -> Result<(), String> {
    match value {
        Some(text) => write_private(path, text).await,
        None => match fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

async fn rollback(changes: &[FileChange]) -> Result<(), String> {
    let mut errors = Vec::new();
    for change in changes.iter().rev() {
        match read_optional(&change.path).await {
            Ok(current) if current == change.after => {
                if let Err(e) = write_value(&change.path, &change.before).await {
                    errors.push(e);
                }
            }
            Ok(current) if current == change.before => {}
            Ok(_) => errors.push(format!(
                "{} изменён извне; резервная копия сохранена в журнале",
                change.path.display()
            )),
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn commit_files(changes: &[FileChange], journal: &Path) -> Result<(), String> {
    if read_optional(journal).await?.is_some() {
        return Err("Есть незавершённая транзакция; перезапустите панель для восстановления".into());
    }
    for change in changes {
        if read_optional(&change.path).await? != change.before {
            return Err(format!("{} изменён извне; обновите страницу", change.path.display()));
        }
    }
    write_private(journal, &pretty(&changes)?).await?;
    for change in changes {
        if let Err(error) = write_value(&change.path, &change.after).await {
            return Err(match rollback_transaction(changes, journal).await {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; откат: {rollback_error}"),
            });
        }
    }
    Ok(())
}

// The transaction is applied; a leftover journal would roll it back on the next start.
async fn finish_journal(journal: &Path) -> Result<(), String> {
    match fs::remove_file(journal).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Не удалось удалить журнал {}: {e}", journal.display())),
    }
}

// File-only rollback (no running core was changed).
async fn rollback_transaction(changes: &[FileChange], journal: &Path) -> Result<(), String> {
    rollback(changes).await?;
    finish_journal(journal).await
}

async fn recover_files(journal: &Path, store: &Path, config_dir: &Path) -> Result<bool, String> {
    if let Some(text) = read_optional(journal).await? {
        let changes: Vec<FileChange> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if changes
            .iter()
            .any(|c| c.path != store && c.path.parent() != Some(config_dir))
        {
            return Err("Неверные пути в журнале восстановления".into());
        }
        rollback_transaction(&changes, journal).await?;
        return Ok(true);
    }
    Ok(false)
}

async fn recover() -> Result<bool, String> {
    recover_files(Path::new(JOURNAL), Path::new(STORE), Path::new(XRAY_CONF_DIR)).await
}

// Call under ACTION_LOCK. Recovery may roll back a transaction already reflected
// in RUNTIME, so reload the restored store before another operation can use it.
async fn recover_runtime() -> Result<bool, String> {
    if !recover().await? {
        return Ok(false);
    }
    *RUNTIME.lock().await = Runtime::default();
    let installed = load_store().await?;
    if let Some(installed) = &installed {
        validate_settings(&installed.settings)?;
    }
    RUNTIME.lock().await.installed = installed;
    Ok(true)
}

async fn recover_running(state: &AppState) -> Result<(), String> {
    if recover_runtime().await? && core_is_xray(state)? && !controller::get_pid("xray").is_empty() {
        restart(state).await?;
    }
    Ok(())
}

async fn api_override(address: &str, id: &str) -> Result<(), String> {
    run_api(&["bo", "--server", address, "-b", BALANCER, &alias(id)]).await?;
    let output = run_api(&["bi", "--server", address, "--json", BALANCER]).await?;
    let result: Value = serde_json::from_slice(&output).map_err(|_| "Xray API вернул неверный ответ")?;
    if result.pointer("/balancer/override/target").and_then(Value::as_str) != Some(alias(id).as_str()) {
        return Err("Xray не подтвердил выбор сервера".into());
    }
    Ok(())
}

async fn run_api(args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("xray");
    cmd.arg("api").args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .map_err(|_| "Таймаут API Xray")?
        .map_err(|e| format!("API Xray: {e}"))?;
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr).chars().take(500).collect();
        return Err(format!("API Xray недоступен ({}): {}", output.status, detail.trim()));
    }
    Ok(output.stdout)
}

async fn wait_ready(installed: &Installed) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        match api_override(&installed.api_address, &installed.settings.selected_id).await {
            Ok(()) => return Ok(()),
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(format!("Xray не подтвердил запуск пула: {error}"));
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn restart(state: &AppState) -> Result<(), String> {
    // Do not kill an init script halfway through rebuilding policy/firewall rules.
    // Callers own a detached task and ACTION_LOCK until the command completes.
    controller::restart_service(state).await
}

fn core_is_xray(state: &AppState) -> Result<bool, String> {
    Ok(state.core.read().map_err(|_| "Состояние ядра недоступно")?.name == "xray")
}

fn require_xray(state: &AppState) -> Result<(), String> {
    if !core_is_xray(state)? {
        return Err("Сначала выберите ядро Xray".into());
    }
    if controller::get_pid("xray").is_empty() {
        return Err("Сначала запустите Xray".into());
    }
    Ok(())
}

async fn disk_change(path: PathBuf, after: Option<String>) -> Result<FileChange, String> {
    Ok(FileChange {
        before: read_optional(&path).await?,
        path,
        after,
    })
}

async fn save(state: &AppState, mut settings: Settings) -> Result<(), String> {
    require_xray(state)?;
    validate_settings(&settings)?;
    preserve_servers(&settings.servers).await?;
    let previous = RUNTIME.lock().await.installed.clone();
    if let Some(ref old) = previous {
        if !settings.servers.iter().any(|s| s.id == old.settings.selected_id) {
            return Err("Сначала выберите другой сервер, затем удалите текущий".into());
        }
        // A browser draft may predate automatic failover. Saving settings must not undo it.
        settings.selected_id = old.settings.selected_id.clone();
    }
    if let Some(ref old) = previous {
        // Editing the active server must not cut traffic with a valid-but-dead outbound.
        let outbound = |s: &Settings| {
            s.servers
                .iter()
                .find(|v| v.id == old.settings.selected_id)
                .map(|v| v.outbound.clone())
        };
        if outbound(&settings) != outbound(&old.settings) {
            let mut single = settings.clone();
            single.servers.retain(|v| v.id == old.settings.selected_id);
            let results = probes(state, &single).await?;
            if results.first().is_none_or(|p| p.latency_ms.is_none()) {
                return Err("Изменённый активный сервер не прошёл проверку; изменения не применены".into());
            }
        }
    }
    let docs = documents().await?;
    let (value, originals, api_address, mut changes) = if let Some(ref old) = previous {
        if settings.target_tag != old.settings.target_tag {
            return Err("Перед сменой исходного outbound отключите управление серверами".into());
        }
        ensure_managed(old).await?;
        let value: Value = serde_json::from_str(&old.managed).map_err(|e| e.to_string())?;
        (
            pool_document(&settings, value)?,
            old.originals.clone(),
            old.api_address.clone(),
            Vec::new(),
        )
    } else {
        let (value, originals, address) = prepare(&settings, &docs)?;
        (value, originals.clone(), address, originals)
    };
    let installed = Installed {
        selected_since: previous
            .as_ref()
            .and_then(|old| old.selected_since)
            .or(Some(chrono::Utc::now().timestamp())),
        settings,
        managed: pretty(&value)?,
        originals,
        api_address,
    };
    // Validate the complete proposed config set BEFORE touching live files.
    let mut proposed = Vec::new();
    for doc in &docs {
        if doc.path == managed_path() {
            continue;
        }
        let text = changes
            .iter()
            .find(|c| c.path == doc.path)
            .and_then(|c| c.after.as_ref())
            .unwrap_or(&doc.text);
        proposed.push(crate::configs::ConfigReq {
            file: doc.path.to_string_lossy().into(),
            content: crate::jsonc::strip_jsonc(text),
        });
    }
    proposed.push(crate::configs::ConfigReq {
        file: managed_path().to_string_lossy().into(),
        content: installed.managed.clone(),
    });
    crate::configs::validate_core(&proposed).await.map_err(|e| {
        let reason: String = e.chars().take(400).collect();
        format!("Xray отклонил конфигурацию, активные файлы не изменены: {reason}")
    })?;
    let needs_restart = previous.as_ref().is_none_or(|old| old.managed != installed.managed);
    changes.push(disk_change(managed_path(), Some(installed.managed.clone())).await?);
    changes.push(disk_change(PathBuf::from(STORE), Some(pretty(&installed)?)).await?);
    commit_files(&changes, Path::new(JOURNAL)).await?;
    let result = if needs_restart {
        match restart(state).await {
            Ok(()) => wait_ready(&installed).await,
            Err(e) => Err(e),
        }
    } else {
        api_override(&installed.api_address, &installed.settings.selected_id).await
    };
    if let Err(error) = result {
        return Err(restore_after_failure(state, &changes, previous.as_ref(), needs_restart, error).await);
    }
    {
        let mut runtime = RUNTIME.lock().await;
        runtime.installed = Some(installed);
        runtime.probes.clear();
        runtime.failures = 0;
        runtime.error = None;
        runtime.ready = true;
    }
    finish_journal(Path::new(JOURNAL)).await?;
    CHECK_CHANGED.notify_one();
    Ok(())
}

async fn ensure_managed(installed: &Installed) -> Result<(), String> {
    if read_optional(&managed_path()).await?.as_ref() != Some(&installed.managed) {
        return Err(format!(
            "{MANAGED_NAME} изменён вне окна серверов. Автопереключение приостановлено; отключите управление, чтобы восстановить исходные настройки"
        ));
    }
    check_layout(&documents().await?)
}

async fn restore_after_failure(
    state: &AppState, changes: &[FileChange], previous: Option<&Installed>, restart_core: bool, error: String,
) -> String {
    if let Err(e) = rollback(changes).await {
        return format!("{error}; не удалось восстановить файлы: {e}");
    }
    let restored = if restart_core {
        match restart(state).await {
            Err(e) => Err(e),
            Ok(()) => {
                if let Some(old) = previous {
                    wait_ready(old).await
                } else {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    if controller::get_pid("xray").is_empty() {
                        Err("Прежний Xray не запустился".into())
                    } else {
                        Ok(())
                    }
                }
            }
        }
    } else if let Some(old) = previous {
        api_override(&old.api_address, &old.settings.selected_id).await
    } else {
        Ok(())
    };
    let message = match restored {
        Err(e) => format!("{error}; файлы восстановлены, но запуск прежнего сервера не подтверждён: {e}"),
        Ok(()) => format!("{error}. Предыдущая конфигурация восстановлена"),
    };
    // Keep crash recovery until the core restoration attempt finishes, but do not
    // leave a completed file rollback blocking every retry if the core is unavailable.
    match finish_journal(Path::new(JOURNAL)).await {
        Ok(()) => message,
        Err(e) => format!("{message}; {e}"),
    }
}

async fn probes(state: &AppState, settings: &Settings) -> Result<Vec<Probe>, String> {
    let outbounds: Vec<Value> = settings
        .servers
        .iter()
        .map(|s| {
            let mut v = s.outbound.clone();
            v["tag"] = s.id.clone().into();
            v
        })
        .collect();
    crate::healthchecker::probe_servers(state, &outbounds, &settings.probe_url, settings.timeout_ms)
        .await
        .map(|results| {
            results
                .into_iter()
                .map(|(id, result)| match result {
                    Ok(latency_ms) => Probe {
                        id,
                        latency_ms: Some(latency_ms),
                        error: None,
                    },
                    Err(error) => Probe {
                        id,
                        latency_ms: None,
                        error: Some(error),
                    },
                })
                .collect()
        })
}

// Missing samples are inconclusive. Only consecutive measured failures trigger failover.
fn choose(settings: &Settings, probes: &[Probe], failures: &mut u32) -> Option<String> {
    let current = probes.iter().find(|p| p.id == settings.selected_id)?;
    if current.latency_ms.is_some() {
        *failures = 0;
        return None;
    }
    if !settings.auto {
        *failures = 0;
        return None;
    }
    *failures = failures.saturating_add(1);
    if *failures < settings.failure_threshold {
        return None;
    }
    probes
        .iter()
        .filter(|p| p.id != settings.selected_id && settings.servers.iter().any(|s| s.id == p.id))
        .filter_map(|p| p.latency_ms.map(|latency| (latency, &p.id)))
        .min()
        .map(|(_, id)| id.clone())
}

async fn select(state: &AppState, id: &str, measured: bool) -> Result<(), String> {
    recover_running(state).await?;
    require_xray(state)?;
    let previous = RUNTIME
        .lock()
        .await
        .installed
        .clone()
        .ok_or("Сначала сохраните серверы")?;
    ensure_managed(&previous).await?;
    let server = previous
        .settings
        .servers
        .iter()
        .find(|s| s.id == id)
        .ok_or("Сервер не найден")?;
    if !measured {
        let mut settings = previous.settings.clone();
        settings.servers = vec![server.clone()];
        let results = probes(state, &settings).await?;
        if results.first().is_none_or(|p| p.latency_ms.is_none()) {
            return Err("Сервер не прошёл проверку доступности; текущий сервер сохранён".into());
        }
    }
    let mut installed = previous.clone();
    installed.settings.selected_id = id.to_string();
    installed.selected_since = Some(chrono::Utc::now().timestamp());
    let value = pool_document(
        &installed.settings,
        serde_json::from_str(&previous.managed).map_err(|e| e.to_string())?,
    )?;
    installed.managed = pretty(&value)?;
    let changes = vec![
        disk_change(managed_path(), Some(installed.managed.clone())).await?,
        disk_change(PathBuf::from(STORE), Some(pretty(&installed)?)).await?,
    ];
    commit_files(&changes, Path::new(JOURNAL)).await?;
    // API overrides affect new sessions only. A manual switch must also move
    // existing client connections, so use the same native restart as the toolbar.
    let restart_core = !measured;
    let result = if restart_core {
        match restart(state).await {
            Ok(()) => wait_ready(&installed).await,
            Err(error) => Err(error),
        }
    } else {
        api_override(&installed.api_address, id).await
    };
    if let Err(error) = result {
        return Err(restore_after_failure(state, &changes, Some(&previous), restart_core, error).await);
    }
    {
        let mut runtime = RUNTIME.lock().await;
        runtime.installed = Some(installed);
        runtime.failures = 0;
        runtime.error = None;
        runtime.ready = true;
        runtime.last_switch = Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    finish_journal(Path::new(JOURNAL)).await
}

fn same_settings(a: &Settings, b: &Settings) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

async fn check(state: &AppState) -> Result<(), String> {
    require_xray(state)?;
    let installed = RUNTIME
        .lock()
        .await
        .installed
        .clone()
        .ok_or("Сначала сохраните серверы")?;
    ensure_managed(&installed).await?;
    // Probing can last the whole timeout: run it without blocking config edits and control actions.
    let samples = probes(state, &installed.settings).await?;
    // Shared ping history: the Servers page shows the latest state of every server from one source.
    for sample in &samples {
        crate::healthchecker::record_ping_history(&sample.id, sample.latency_ms.unwrap_or(0), sample.error.clone())
            .await;
    }
    let _guard = ACTION_LOCK.lock().await;
    let next = {
        let mut runtime = RUNTIME.lock().await;
        let unchanged = runtime
            .installed
            .as_ref()
            .is_some_and(|c| c.managed == installed.managed && same_settings(&c.settings, &installed.settings));
        if !unchanged {
            // Settings changed while probing; the next run uses the fresh ones.
            return Ok(());
        }
        let next = choose(&installed.settings, &samples, &mut runtime.failures);
        runtime.probes = samples;
        runtime.last_check = Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        runtime.ready = true;
        runtime.error =
            if installed.settings.auto && runtime.failures >= installed.settings.failure_threshold && next.is_none() {
                Some("Все серверы недоступны; выбор сохранён, проверки продолжаются".into())
            } else {
                None
            };
        next
    };
    if let Some(id) = next {
        select(state, &id, true).await?;
    }
    Ok(())
}

async fn load_store() -> Result<Option<Installed>, String> {
    match read_optional(Path::new(STORE)).await? {
        Some(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{STORE}: {e}")),
        None => Ok(None),
    }
}

async fn managed_exists() -> bool {
    fs::try_exists(managed_path()).await.unwrap_or(false)
        || fs::try_exists(legacy_managed_path()).await.unwrap_or(false)
}

pub(crate) async fn is_active() -> bool {
    RUNTIME.lock().await.installed.is_some() || managed_exists().await
}

// Prefer the in-memory state; fall back to disk when startup failed to load it.
async fn installed_or_store() -> Result<Option<Installed>, String> {
    if let Some(installed) = RUNTIME.lock().await.installed.clone() {
        return Ok(Some(installed));
    }
    if let Ok(Some(installed)) = load_store().await {
        return Ok(Some(installed));
    }
    if managed_exists().await {
        return Err(format!(
            "Нет корректного {STORE}: исходные routing/api неизвестны. Перенесите их из {} в свой конфиг и удалите этот файл",
            managed_path().display()
        ));
    }
    Ok(None)
}

// What a user file should become when the pool is removed. Later manual edits are kept:
// only the sections the pool took are put back.
fn restored_text(original: &FileChange, current: Option<&str>) -> Result<Option<String>, String> {
    if current == original.after.as_deref() {
        return Ok(original.before.clone());
    }
    if current == original.before.as_deref() {
        return Ok(None);
    }
    let Some(current) = current else {
        // The file was deleted; recreate it, otherwise routing would vanish with the managed file.
        return Ok(original.before.clone());
    };
    let (Some(mut value), Some(before)) = (parse_object(current), original.before.as_deref().and_then(parse_object))
    else {
        return Err(format!(
            "{}: не удалось разобрать файл; верните routing/api вручную",
            original.path.display()
        ));
    };
    for key in OWNED_KEYS {
        if value.get(key).is_none_or(Value::is_null)
            && let Some(saved) = before.get(key)
        {
            value[key] = saved.clone();
        }
    }
    pretty(&value).map(Some)
}

async fn restore_file_changes(installed: Option<&Installed>) -> Result<Vec<FileChange>, String> {
    let mut changes = Vec::new();
    for original in installed.map(|i| i.originals.as_slice()).unwrap_or_default() {
        let current = read_optional(&original.path).await?;
        if let Some(text) = restored_text(original, current.as_deref())? {
            changes.push(FileChange {
                path: original.path.clone(),
                before: current,
                after: Some(text),
            });
        }
    }
    changes.push(disk_change(managed_path(), None).await?);
    changes.push(disk_change(legacy_managed_path(), None).await?);
    changes.push(disk_change(PathBuf::from(STORE), None).await?);
    changes.retain(|c| c.before != c.after);
    Ok(changes)
}

// Puts user routing/api back and removes pool files. The journal stays until the caller finishes.
async fn restore_files(installed: Option<&Installed>) -> Result<Vec<FileChange>, String> {
    let changes = restore_file_changes(installed).await?;
    if !changes.is_empty() {
        commit_files(&changes, Path::new(JOURNAL)).await?;
    }
    Ok(changes)
}

fn same_outbound(a: &Value, b: &Value) -> bool {
    match (a.as_object(), b.as_object()) {
        (Some(a), Some(b)) => a
            .iter()
            .filter(|(k, _)| *k != "tag")
            .eq(b.iter().filter(|(k, _)| *k != "tag")),
        _ => false,
    }
}

fn routed_tags(docs: &[Document]) -> Vec<&str> {
    docs.iter()
        .rev()
        .find_map(|doc| doc.value.get("routing").filter(|v| !v.is_null()))
        .and_then(|routing| routing["rules"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|rule| rule["outboundTag"].as_str())
        .collect()
}

fn current_outbound(docs: &[Document]) -> Option<Value> {
    let outbounds = merged_outbounds(docs);
    let routed = routed_tags(docs);
    outbounds
        .iter()
        .enumerate()
        .find(|(index, outbound)| {
            standalone(outbound) && (*index == 0 || outbound["tag"].as_str().is_some_and(|tag| routed.contains(&tag)))
        })
        .map(|(_, outbound)| outbound.clone())
}

fn proposed_documents(docs: &[Document], changes: &[FileChange]) -> Result<Vec<Document>, String> {
    let mut proposed = docs.to_vec();
    for change in changes {
        if change.path.parent() != Some(Path::new(XRAY_CONF_DIR)) || !has_config_ext(&change.path) {
            continue;
        }
        proposed.retain(|doc| doc.path != change.path);
        if let Some(text) = &change.after {
            let value = parse_object(text).ok_or_else(|| format!("{}: неверный JSON/JSONC", change.path.display()))?;
            proposed.push(Document {
                path: change.path.clone(),
                text: text.clone(),
                value,
            });
        }
    }
    proposed.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(proposed)
}

async fn validate_documents(docs: &[Document]) -> Result<(), String> {
    let configs: Vec<_> = docs
        .iter()
        .map(|doc| crate::configs::ConfigReq {
            file: doc.path.to_string_lossy().into(),
            content: crate::jsonc::strip_jsonc(&doc.text),
        })
        .collect();
    crate::configs::validate_core(&configs).await
}

struct RoutingUpdate {
    previous: Installed,
    installed: Installed,
    changes: Vec<FileChange>,
    proposed: Vec<Document>,
}

// Call under ACTION_LOCK. Source routes and the derived pool file must be planned
// together; validating only the source would validate the old effective routes.
async fn routing_update(file: &str, content: &str) -> Result<Option<RoutingUpdate>, String> {
    let path = Path::new(file);
    if path.parent() != Some(Path::new(XRAY_CONF_DIR)) || !has_config_ext(path) || !is_active().await {
        return Ok(None);
    }
    if is_managed_file(path) || path > managed_path().as_path() {
        guard_config_edit(file, Some(content)).await?;
        return Ok(None);
    }
    let previous = installed_or_store()
        .await?
        .ok_or("Не удалось прочитать настройки пула")?;
    ensure_managed(&previous).await?;
    if !previous.originals.is_empty() {
        return Err("Дождитесь завершения переноса конфигурации пула".into());
    }
    let docs = documents().await?;
    let current = docs
        .iter()
        .find(|doc| doc.path == path)
        .ok_or("Файл конфигурации не найден")?;
    let next_value = parse_object(content).ok_or("Неверный JSON/JSONC")?;
    if current.value.get("routing").is_none() && next_value.get("routing").is_none() {
        return Ok(None);
    }
    let mut before = current.value.clone();
    let mut after = next_value.clone();
    before.as_object_mut().ok_or("Неверный конфиг")?.remove("routing");
    after.as_object_mut().ok_or("Неверный конфиг")?.remove("routing");
    if before != after {
        return Err("При включённом пуле изменяйте маршруты отдельно от остальных разделов этого файла".into());
    }
    if next_value
        .pointer("/routing/rules")
        .and_then(Value::as_array)
        .is_some_and(|rules| {
            rules.iter().any(|rule| {
                rule["outboundTag"].as_str().is_some_and(|tag| tag.starts_with(PREFIX))
                    || rule["balancerTag"] == BALANCER
            })
        })
    {
        return Err(
            "В исходных маршрутах выбирайте обычное подключение; служебные теги пула добавляются автоматически".into(),
        );
    }
    let mut changes = vec![FileChange {
        path: path.to_path_buf(),
        before: Some(current.text.clone()),
        after: Some(content.into()),
    }];
    let sources: Vec<_> = proposed_documents(&docs, &changes)?
        .into_iter()
        .filter(|doc| !is_managed_file(&doc.path))
        .collect();
    let (value, _, api_address) = prepare_pool(&previous.settings, &sources, true)?;
    let installed = Installed {
        managed: pretty(&value)?,
        api_address,
        ..previous.clone()
    };
    changes.push(disk_change(managed_path(), Some(installed.managed.clone())).await?);
    changes.push(disk_change(PathBuf::from(STORE), Some(pretty(&installed)?)).await?);
    let proposed = proposed_documents(&docs, &changes)?;
    Ok(Some(RoutingUpdate {
        previous,
        installed,
        changes,
        proposed,
    }))
}

pub(crate) async fn preview_routing_config(
    file: &str, content: &str,
) -> Result<Option<Vec<crate::configs::ConfigReq>>, String> {
    Ok(routing_update(file, content).await?.map(|plan| {
        plan.proposed
            .into_iter()
            .map(|doc| crate::configs::ConfigReq {
                file: doc.path.to_string_lossy().into_owned(),
                content: doc.text,
            })
            .collect()
    }))
}

// Both Save and Apply update an enabled pool atomically. A running service is
// restarted once; Apply also starts a stopped service. The caller is detached.
pub(crate) async fn update_routing_config(
    state: &AppState, file: &str, content: &str, apply: bool,
) -> Result<Option<bool>, String> {
    recover_running(state).await?;
    let Some(plan) = routing_update(file, content).await? else {
        return Ok(None);
    };
    // Only the core choice matters: a stopped Xray is saved without a restart, and Apply starts it.
    if !core_is_xray(state)? {
        return Err("Сначала выберите ядро Xray".into());
    }
    validate_documents(&plan.proposed).await?;
    let was_running = !controller::get_pid("xray").is_empty();
    let needs_restart = apply || was_running;
    commit_files(&plan.changes, Path::new(JOURNAL)).await?;
    let result = async {
        if needs_restart {
            restart(state).await?;
            wait_ready(&plan.installed).await?;
        }
        finish_journal(Path::new(JOURNAL)).await
    }
    .await;
    if let Err(error) = result {
        if was_running {
            return Err(restore_after_failure(state, &plan.changes, Some(&plan.previous), true, error).await);
        }
        if needs_restart {
            let _ = controller::run_init_command(state, &["stop"]).await;
        }
        return Err(match rollback_transaction(&plan.changes, Path::new(JOURNAL)).await {
            Ok(()) => format!("{error}. Предыдущая конфигурация восстановлена"),
            Err(rollback) => format!("{error}; откат: {rollback}"),
        });
    }
    let mut runtime = RUNTIME.lock().await;
    runtime.installed = Some(plan.installed);
    runtime.ready = needs_restart;
    runtime.error = None;
    runtime.failures = 0;
    drop(runtime);
    CHECK_CHANGED.notify_one();
    Ok(Some(needs_restart))
}

// Restore user files taken by older releases, then replace the old managed file
// in the same recoverable transaction. A missing pool file is rebuilt from store.
async fn migrate_pool(state: &AppState, old: Installed) -> Result<Installed, String> {
    let current = read_optional(&managed_path()).await?;
    let legacy = read_optional(&legacy_managed_path()).await?;
    if current.is_some() && legacy.is_none() && old.originals.is_empty() {
        return Ok(old);
    }
    if current.as_ref().is_some_and(|text| text != &old.managed)
        || legacy.as_ref().is_some_and(|text| text != &old.managed)
    {
        return Err("Файл пула изменён извне; автоматический перенос остановлен, исходные файлы сохранены".into());
    }
    let docs = documents().await?;
    let mut changes = restore_file_changes(Some(&old)).await?;
    let restored = proposed_documents(&docs, &changes)?;
    let (value, originals, api_address) = prepare(&old.settings, &restored)?;
    let installed = Installed {
        selected_since: old.selected_since,
        settings: old.settings.clone(),
        managed: pretty(&value)?,
        originals,
        api_address,
    };
    for (path, after) in [
        (managed_path(), Some(installed.managed.clone())),
        (PathBuf::from(STORE), Some(pretty(&installed)?)),
    ] {
        if let Some(change) = changes.iter_mut().find(|change| change.path == path) {
            change.after = after;
        } else {
            changes.push(disk_change(path, after).await?);
        }
    }
    changes.retain(|change| change.before != change.after);
    validate_documents(&proposed_documents(&docs, &changes)?).await?;
    commit_files(&changes, Path::new(JOURNAL)).await?;
    let was_running = core_is_xray(state)? && !controller::get_pid("xray").is_empty();
    if was_running {
        let result = match restart(state).await {
            Ok(()) => wait_ready(&installed).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            return Err(restore_after_failure(state, &changes, Some(&old), true, error).await);
        }
    }
    finish_journal(Path::new(JOURNAL)).await?;
    Ok(installed)
}

// Replace only the effective target outbound. Its tag and every routing/inbound
// setting stay the same; standalone selection needs no balancer or API listener.
fn activation_change(docs: &[Document], target: &str, server: &Server) -> Result<FileChange, String> {
    let outbounds = merged_outbounds(docs);
    if !outbounds.iter().any(|o| o["tag"] == target && standalone(o)) {
        return Err("Исходное подключение не найдено".into());
    }
    if outbounds.first().is_none_or(|o| o["tag"] != target) && !routed_tags(docs).contains(&target) {
        return Err("Исходное подключение не используется в маршрутах".into());
    }
    for doc in docs.iter().rev() {
        let mut value = doc.value.clone();
        if let Some(outbounds) = value["outbounds"].as_array_mut()
            && let Some(index) = outbounds.iter().rposition(|o| o["tag"] == target)
        {
            let mut outbound = server.outbound.clone();
            outbound["tag"] = target.into();
            outbounds[index] = outbound;
            return Ok(FileChange {
                path: doc.path.clone(),
                before: Some(doc.text.clone()),
                after: Some(pretty(&value)?),
            });
        }
    }
    Err("Файл исходного подключения не найден".into())
}

#[derive(Deserialize)]
pub struct ActivateRequest {
    id: String,
    #[serde(default)]
    target_tag: String,
}

async fn activate(state: &AppState, request: ActivateRequest) -> Result<(), String> {
    recover_running(state).await?;
    require_xray(state)?;
    let previous = installed_or_store().await?;
    let server = load_library()
        .await?
        .into_iter()
        .find(|s| s.id == request.id)
        .ok_or("Сервер не найден")?;
    validate_server(&server)?;
    let docs = documents().await?;
    let mut changes = restore_file_changes(previous.as_ref()).await?;
    let restored = proposed_documents(&docs, &changes)?;
    let target = previous
        .as_ref()
        .map(|old| old.settings.target_tag.clone())
        .or_else(|| (!request.target_tag.is_empty()).then_some(request.target_tag))
        .or_else(|| current_outbound(&restored).and_then(|o| o["tag"].as_str().map(str::to_owned)))
        .ok_or("Нет исходного proxy outbound; сначала настройте конфигурацию Xray")?;
    let replacement = activation_change(&restored, &target, &server)?;
    if let Some(change) = changes.iter_mut().find(|change| change.path == replacement.path) {
        change.after = replacement.after;
    } else {
        changes.push(replacement);
    }
    let proposed = proposed_documents(&docs, &changes)?;
    validate_documents(&proposed).await?;
    let mut probe = previous.as_ref().map(|old| old.settings.clone()).unwrap_or_default();
    if previous.is_none() {
        let settings = state.settings.read().map_err(|_| "Настройки панели недоступны")?;
        probe.probe_url = settings.clash_api.ping_url.clone();
        probe.timeout_ms = u64::from(settings.clash_api.ping_timeout);
    }
    probe.servers = vec![server];
    let results = probes(state, &probe).await?;
    if results.first().is_none_or(|sample| sample.latency_ms.is_none()) {
        let detail = results
            .first()
            .and_then(|sample| sample.error.as_deref())
            .unwrap_or("нет ответа");
        return Err(format!(
            "Сервер не прошёл проверку: {detail}. Текущее подключение сохранено"
        ));
    }
    if let Some(old) = &previous {
        preserve_servers(&old.settings.servers).await?;
    }
    changes.retain(|change| change.before != change.after);
    if changes.is_empty() {
        return Ok(());
    }
    commit_files(&changes, Path::new(JOURNAL)).await?;
    let result = async {
        restart(state).await?;
        tokio::time::sleep(Duration::from_secs(1)).await;
        require_xray(state)
    }
    .await;
    if let Err(error) = result {
        return Err(restore_after_failure(state, &changes, previous.as_ref(), true, error).await);
    }
    *RUNTIME.lock().await = Runtime {
        ready: true,
        last_switch: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        ..Runtime::default()
    };
    finish_journal(Path::new(JOURNAL)).await
}

pub async fn post_activate(State(state): State<AppState>, Json(request): Json<ActivateRequest>) -> Json<Value> {
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            activate(&state, request).await
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

// Works even when Xray is stopped or the managed file was edited: this is the way out.
async fn disable(state: &AppState) -> Result<(), String> {
    let recovered = recover_runtime().await?;
    let installed = installed_or_store().await?;
    if let Some(installed) = &installed {
        preserve_servers(&installed.settings.servers).await?;
    }
    let was_running = core_is_xray(state)? && !controller::get_pid("xray").is_empty();
    let changes = restore_files(installed.as_ref()).await?;
    if was_running && (!changes.is_empty() || recovered) {
        let started = match restart(state).await {
            Ok(()) => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if controller::get_pid("xray").is_empty() {
                    Err("Исходный Xray не запустился".to_string())
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(e),
        };
        if let Err(error) = started {
            return Err(restore_after_failure(state, &changes, installed.as_ref(), true, error).await);
        }
    }
    *RUNTIME.lock().await = Runtime::default();
    finish_journal(Path::new(JOURNAL)).await
}

/// Used by the uninstaller while the panel is stopped. Restores files only; returns whether
/// anything changed so the caller can restart the core.
pub async fn disable_offline() -> Result<bool, String> {
    let recovered = recover().await?;
    let installed = installed_or_store().await?;
    if let Some(installed) = &installed {
        preserve_servers(&installed.settings.servers).await?;
    }
    let changes = restore_files(installed.as_ref()).await?;
    finish_journal(Path::new(JOURNAL)).await?;
    Ok(recovered || !changes.is_empty())
}

/// Rejects config edits that the pool would silently override or that would break it.
pub(crate) async fn guard_config_edit(file: &str, content: Option<&str>) -> Result<(), String> {
    let path = Path::new(file);
    if path.parent() != Some(Path::new(XRAY_CONF_DIR)) || !has_config_ext(path) || !is_active().await {
        return Ok(());
    }
    let managed = managed_path();
    if is_managed_file(path) {
        return Err(format!("{MANAGED_NAME} управляется окном «Серверы Xray»"));
    }
    if path > managed.as_path() {
        return Err(format!(
            "Имя файла должно идти раньше {MANAGED_NAME}, иначе файл перекроет пул серверов"
        ));
    }
    if let Some(key) = content.and_then(parse_object).as_ref().and_then(owned_key) {
        return Err(format!(
            "Раздел {key} сейчас управляется окном «Серверы Xray». Отключите управление, чтобы редактировать его здесь"
        ));
    }
    Ok(())
}

pub async fn get_servers() -> Json<Value> {
    let core_started = tokio::task::spawn_blocking(|| crate::system::core_started_at("xray"))
        .await
        .unwrap_or(None);
    let managed_present = managed_exists().await;
    let servers = match load_library().await {
        Ok(servers) => servers,
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    let active_id = match documents().await {
        Ok(docs) => current_outbound(&docs).map(|outbound| {
            servers
                .iter()
                .find(|server| same_outbound(&server.outbound, &outbound))
                .map(|server| server.id.clone())
                .unwrap_or_else(|| format!("config:{}", outbound["tag"].as_str().unwrap_or_default()))
        }),
        Err(_) => None,
    };
    let runtime = RUNTIME.lock().await;
    let active_since = core_started.and_then(|started| {
        let selected = runtime
            .installed
            .as_ref()
            .and_then(|installed| installed.selected_since)
            .unwrap_or(started);
        chrono::DateTime::from_timestamp(started.max(selected), 0)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    let settings = runtime.installed.as_ref().map(|i| {
        let mut settings = i.settings.clone();
        settings.interval_ms = Some(settings.check_interval_ms());
        settings
    });
    Json(
        json!({"success": true, "servers": servers, "settings": settings, "probes": runtime.probes,
        "active_id": settings.as_ref().map(|s| s.selected_id.as_str()).or(active_id.as_deref()),
        "active_since": active_since,
        "failures": runtime.failures, "error": runtime.error, "ready": runtime.ready,
        "managed_present": managed_present,
        "last_check": runtime.last_check, "last_switch": runtime.last_switch}),
    )
}

async fn load_library() -> Result<Vec<Server>, String> {
    let mut servers: Vec<Server> = match read_optional(Path::new(LIBRARY)).await? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{LIBRARY}: {e}"))?,
        None => Vec::new(),
    };
    // Existing installations already have servers inside the active pool.
    if let Some(installed) = &RUNTIME.lock().await.installed {
        for server in &installed.settings.servers {
            if !servers.iter().any(|s| s.id == server.id) {
                servers.push(server.clone());
            }
        }
    }
    Ok(servers)
}

async fn preserve_servers(servers: &[Server]) -> Result<(), String> {
    let mut library = load_library().await?;
    for server in servers {
        if !library.iter().any(|saved| saved.id == server.id) {
            library.push(server.clone());
        }
    }
    write_private(Path::new(LIBRARY), &pretty(&library)?).await
}

async fn upsert_library(path: &Path, servers: &mut Vec<Server>, server: Server) -> Result<(), String> {
    validate_server(&server)?;
    if let Some(saved) = servers.iter_mut().find(|s| s.id == server.id) {
        *saved = server;
    } else {
        if servers.len() >= 32 {
            return Err("В списке может быть не больше 32 серверов".into());
        }
        servers.push(server);
    }
    write_private(path, &pretty(servers)?).await
}

pub async fn put_library_server(Json(server): Json<Server>) -> Json<Value> {
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            let mut servers = load_library().await?;
            upsert_library(Path::new(LIBRARY), &mut servers, server).await
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

pub async fn delete_library_server(Json(request): Json<SelectRequest>) -> Json<Value> {
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            if RUNTIME
                .lock()
                .await
                .installed
                .as_ref()
                .is_some_and(|i| i.settings.servers.iter().any(|s| s.id == request.id))
            {
                return Err("Сначала уберите сервер из пула и сохраните изменения".into());
            }
            let mut servers = load_library().await?;
            servers.retain(|s| s.id != request.id);
            write_private(Path::new(LIBRARY), &pretty(&servers)?).await
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

pub async fn get_candidates() -> Json<Value> {
    match documents().await {
        Ok(docs) => {
            let merged = merged_outbounds(&docs);
            // Same facts `prepare` relies on: the default outbound and tags used directly by rules.
            let default_tag = merged.first().and_then(|v| v["tag"].as_str()).map(str::to_owned);
            let routed_tags: Vec<String> = docs
                .iter()
                .rev()
                .find_map(|d| d.value.get("routing").filter(|v| !v.is_null()))
                .and_then(|r| r["rules"].as_array())
                .into_iter()
                .flatten()
                .filter_map(|rule| rule["outboundTag"].as_str().map(str::to_owned))
                .collect();
            let outbounds: Vec<Value> = merged
                .into_iter()
                .filter(|v| standalone(v) && v["tag"].as_str().is_some_and(|s| !s.starts_with(PREFIX)))
                .collect();
            Json(
                json!({"success": true, "outbounds": outbounds, "default_tag": default_tag, "routed_tags": routed_tags}),
            )
        }
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

#[derive(Deserialize)]
pub struct PutServersRequest {
    #[serde(flatten)]
    settings: Settings,
    /// The active server the browser draft was made from. A draft that still carries it did not
    /// choose a server: saving such a draft must not undo a failover that happened meanwhile.
    base_selected_id: Option<String>,
}

/// The server a save asks to switch to, if the user picked one in the draft.
fn explicit_selection(requested: &str, base: Option<&str>, current: Option<&str>) -> Option<String> {
    let current = current?;
    let picked = match base {
        Some(base) => requested != base,
        None => true,
    };
    (picked && !requested.is_empty() && requested != current).then(|| requested.to_string())
}

pub async fn put_servers(State(state): State<AppState>, Json(request): Json<PutServersRequest>) -> Json<Value> {
    let PutServersRequest {
        settings,
        base_selected_id,
    } = request;
    // Detached task finishes its transaction even if the browser disconnects midway.
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            recover_running(&state).await?;
            let requested = settings.selected_id.clone();
            let previous = RUNTIME
                .lock()
                .await
                .installed
                .as_ref()
                .map(|i| i.settings.selected_id.clone());
            save(&state, settings).await?;
            // An existing pool keeps its selection on save (a stale draft must not undo failover);
            // an explicit new choice is applied right after, probed like a manual selection.
            match explicit_selection(&requested, base_selected_id.as_deref(), previous.as_deref()) {
                Some(id) => select(&state, &id, false).await,
                None => Ok(()),
            }
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

#[derive(Deserialize)]
pub struct SelectRequest {
    id: String,
}

pub async fn post_select(State(state): State<AppState>, Json(request): Json<SelectRequest>) -> Json<Value> {
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            select(&state, &request.id, false).await
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

pub async fn post_check(State(state): State<AppState>) -> Json<Value> {
    // `check` takes ACTION_LOCK itself, only after probing.
    reply(
        tokio::spawn(async move { check(&state).await })
            .await
            .unwrap_or_else(|e| Err(e.to_string())),
    )
}

pub async fn delete_servers(State(state): State<AppState>) -> Json<Value> {
    reply(
        tokio::spawn(async move {
            let _guard = ACTION_LOCK.lock().await;
            disable(&state).await
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string())),
    )
}

pub async fn start(state: AppState) {
    // Handlers wait on this lock until recovery finishes, so the HTTP server starts at once.
    let guard = ACTION_LOCK.lock().await;
    tokio::spawn(async move {
        let loaded = async {
            recover_running(&state).await?;
            match load_store().await? {
                Some(installed) => {
                    validate_settings(&installed.settings)?;
                    Ok::<_, String>(Some(migrate_pool(&state, installed).await?))
                }
                None => Ok(None),
            }
        }
        .await;
        match loaded {
            Ok(installed) => RUNTIME.lock().await.installed = installed,
            Err(error) => RUNTIME.lock().await.error = Some(error),
        }
        drop(guard);
        loop {
            let installed = RUNTIME.lock().await.installed.clone();
            let delay = installed
                .as_ref()
                .filter(|i| i.settings.auto)
                .map_or(10_000, |i| i.settings.check_interval_ms());
            if let Some(installed) = installed {
                if require_xray(&state).is_ok() {
                    // Manual mode needs no API calls: the selection is pinned in the config on disk.
                    let result = if installed.settings.auto {
                        check(&state).await
                    } else {
                        ensure_managed(&installed).await
                    };
                    let mut runtime = RUNTIME.lock().await;
                    // Skip stale results when settings changed meanwhile.
                    if runtime
                        .installed
                        .as_ref()
                        .is_some_and(|c| c.managed == installed.managed)
                    {
                        match result {
                            Err(error) => {
                                runtime.error = Some(error);
                                runtime.ready = false;
                            }
                            Ok(()) if !installed.settings.auto => {
                                runtime.error = None;
                                runtime.ready = true;
                            }
                            Ok(()) => {}
                        }
                    }
                } else {
                    let mut runtime = RUNTIME.lock().await;
                    runtime.ready = false;
                    runtime.failures = 0;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                _ = CHECK_CHANGED.notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server(index: u128) -> Server {
        Server {
            id: uuid::Uuid::from_u128(index).to_string(),
            name: format!("Server {index}"),
            outbound: json!({"tag": format!("proxy-{index}"), "protocol": "socks", "settings": {"servers": [{"address": "127.0.0.1", "port": 1080}]}}),
        }
    }
    fn settings() -> Settings {
        Settings {
            target_tag: "proxy".into(),
            servers: vec![server(1), server(2), server(3)],
            selected_id: server(1).id,
            auto: true,
            ..Settings::default()
        }
    }

    #[test]
    fn millisecond_interval_accepts_one_second_and_preserves_legacy_seconds() {
        let mut value = serde_json::to_value(settings()).unwrap();
        value["interval_secs"] = 90.into();
        let legacy: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.check_interval_ms(), 90_000);
        assert!(validate_settings(&legacy).is_ok());

        value["interval_ms"] = 1000.into();
        let mut precise: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(precise.check_interval_ms(), 1000);
        assert!(validate_settings(&precise).is_ok());
        let stored = serde_json::to_string(&precise).unwrap();
        assert_eq!(
            serde_json::from_str::<Settings>(&stored).unwrap().check_interval_ms(),
            1000
        );
        precise.interval_ms = Some(999);
        assert!(validate_settings(&precise).is_err());
        precise.interval_ms = Some(3_600_000);
        assert!(validate_settings(&precise).is_ok());
        precise.interval_ms = Some(3_600_001);
        assert!(validate_settings(&precise).is_err());
    }
    fn sample(index: u128, latency_ms: Option<u64>) -> Probe {
        Probe {
            id: server(index).id,
            latency_ms,
            error: None,
        }
    }
    fn document(name: &str, value: Value) -> Document {
        Document {
            path: Path::new(XRAY_CONF_DIR).join(name),
            text: value.to_string(),
            value,
        }
    }

    #[test]
    fn standalone_activation_preserves_routing_inbounds_and_other_outbounds() {
        let doc = document(
            "04.json",
            json!({
                "inbounds": [{"tag": "tproxy", "port": 12345}],
                "outbounds": [{"tag": "proxy", "protocol": "socks"}, {"tag": "direct", "protocol": "freedom"}],
                "routing": {"rules": [{"outboundTag": "proxy", "network": "tcp"}]}
            }),
        );
        let change = activation_change(std::slice::from_ref(&doc), "proxy", &server(2)).unwrap();
        let after = parse_object(change.after.as_deref().unwrap()).unwrap();
        assert_eq!(after["inbounds"], doc.value["inbounds"]);
        assert_eq!(after["routing"], doc.value["routing"]);
        assert_eq!(after["outbounds"][1], doc.value["outbounds"][1]);
        assert_eq!(after["outbounds"][0]["tag"], "proxy");
        assert!(same_outbound(&after["outbounds"][0], &server(2).outbound));
        assert_eq!(change.before.as_deref(), Some(doc.text.as_str()));
    }

    #[test]
    fn standalone_activation_replaces_effective_duplicate_and_rejects_unused_target() {
        let docs = vec![
            document("01.json", json!({"outbounds": [{"tag": "proxy", "protocol": "socks"}]})),
            document(
                "02-tail.json",
                json!({"outbounds": [{"tag": "proxy", "protocol": "http"}, {"tag": "unused", "protocol": "socks"}]}),
            ),
        ];
        let change = activation_change(&docs, "proxy", &server(1)).unwrap();
        assert_eq!(change.path, docs[1].path);
        let after = proposed_documents(&docs, &[change]).unwrap();
        assert_eq!(after[0].text, docs[0].text);
        assert!(same_outbound(&merged_outbounds(&after)[0], &server(1).outbound));
        assert!(activation_change(&docs, "unused", &server(1)).is_err());
        assert!(activation_change(&docs, "missing", &server(1)).is_err());
    }

    #[test]
    fn active_server_comparison_ignores_only_tag() {
        let original = server(1).outbound;
        let mut changed = original.clone();
        changed["tag"] = "different".into();
        assert!(same_outbound(&original, &changed));
        changed["settings"]["servers"][0]["port"] = 443.into();
        assert!(!same_outbound(&original, &changed));
    }

    #[test]
    fn keeps_healthy_current_even_when_other_is_faster() {
        let mut failures = 2;
        assert_eq!(
            choose(&settings(), &[sample(1, Some(500)), sample(2, Some(10))], &mut failures),
            None
        );
        assert_eq!(failures, 0);
    }
    #[test]
    fn switches_only_after_consecutive_failures_to_fastest_alive() {
        let mut failures = 0;
        let probes = [sample(1, None), sample(2, Some(30)), sample(3, Some(10))];
        assert_eq!(choose(&settings(), &probes, &mut failures), None);
        assert_eq!(choose(&settings(), &probes, &mut failures), None);
        assert_eq!(choose(&settings(), &probes, &mut failures), Some(server(3).id));
    }
    #[test]
    fn recovery_resets_failure_streak() {
        let mut failures = 2;
        choose(&settings(), &[sample(1, Some(50))], &mut failures);
        assert_eq!(
            choose(&settings(), &[sample(1, None), sample(2, Some(5))], &mut failures),
            None
        );
        assert_eq!(failures, 1);
    }
    #[test]
    fn missing_samples_and_all_down_do_not_change_selection() {
        let mut failures = 3;
        assert_eq!(choose(&settings(), &[sample(2, Some(5))], &mut failures), None);
        assert_eq!(failures, 3);
        assert_eq!(
            choose(&settings(), &[sample(1, None), sample(2, None)], &mut failures),
            None
        );
    }
    #[test]
    fn stale_draft_does_not_undo_failover() {
        // Failover moved A -> B; a draft made while A was active still carries A.
        assert_eq!(explicit_selection("a", Some("a"), Some("b")), None);
        // The user picked C in the draft.
        assert_eq!(explicit_selection("c", Some("a"), Some("b")).as_deref(), Some("c"));
        // Older clients without the base keep the previous behaviour.
        assert_eq!(explicit_selection("a", None, Some("b")).as_deref(), Some("a"));
        assert_eq!(explicit_selection("b", Some("a"), Some("b")), None);
        assert_eq!(explicit_selection("a", Some("x"), None), None);
    }

    #[test]
    fn manual_mode_never_fails_over() {
        let mut settings = settings();
        settings.auto = false;
        let mut failures = 100;
        assert_eq!(
            choose(&settings, &[sample(1, None), sample(2, Some(0))], &mut failures),
            None
        );
        assert_eq!(failures, 0);
    }
    #[test]
    fn rejects_invalid_or_dependent_outbounds() {
        let mut settings = settings();
        assert!(validate_settings(&settings).is_ok());
        settings.servers[0].outbound["proxySettings"] = json!({"tag": "proxy-2"});
        assert!(validate_settings(&settings).is_err());
        settings = self::settings();
        settings.servers[0].outbound["streamSettings"] = json!({"sockopt": {"dialerProxy": "another"}});
        assert!(validate_settings(&settings).is_err());
        settings = self::settings();
        settings.servers[1].id = settings.servers[0].id.clone();
        assert!(validate_settings(&settings).is_err());
        settings = self::settings();
        settings.probe_url = "file:///etc/passwd".into();
        assert!(validate_settings(&settings).is_err());
    }
    #[test]
    fn preserves_effective_routing_api_and_default_outbound() {
        let docs = vec![
            document("01.json", json!({"outbounds":[{"tag":"direct", "protocol":"freedom"}]})),
            document(
                "02.json",
                json!({"outbounds":[{"tag":"proxy", "protocol":"socks"}], "routing":{"domainStrategy":"IPIfNonMatch", "rules":[{"outboundTag":"direct", "domain":["local"]}, {"outboundTag":"proxy", "domain":["example.com"]}], "balancers":[{"tag":"other", "selector":["direct"]}]}, "api":{"tag":"existing", "listen":"127.0.0.1:8080", "services":["StatsService"]}}),
            ),
        ];
        let (value, originals, address) = prepare(&settings(), &docs).unwrap();
        assert_eq!(address, "127.0.0.1:8080");
        assert_eq!(value["api"]["services"], json!(["StatsService", "RoutingService"]));
        assert_eq!(value["routing"]["domainStrategy"], "IPIfNonMatch");
        assert_eq!(value["routing"]["rules"][0]["outboundTag"], "direct");
        assert_eq!(value["routing"]["rules"][1]["balancerTag"], BALANCER);
        assert_eq!(value["routing"]["rules"][2]["network"], "tcp,udp");
        assert_eq!(value["routing"]["balancers"][0]["tag"], "other");
        assert_eq!(
            value["routing"]["balancers"][1]["selector"],
            json!([alias(&settings().selected_id)])
        );
        assert!(originals.is_empty(), "pool must not rewrite user routing/api files");
    }
    #[test]
    fn follows_xray_prepend_replace_and_tail_merge_order() {
        let docs = vec![
            document("01.json", json!({"outbounds":[{"tag":"a", "protocol":"socks"}]})),
            document("02.json", json!({"outbounds":[{"tag":"b"}]})),
            document(
                "03-tail.json",
                json!({"outbounds":[{"tag":"c"}, {"tag":"a", "protocol":"vless"}]}),
            ),
        ];
        let result = merged_outbounds(&docs);
        assert_eq!(
            result.iter().map(|v| v["tag"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["b", "a", "c"]
        );
        assert_eq!(result[1]["protocol"], "vless");
    }
    #[test]
    fn rejects_routing_scripts_external_api_and_unused_target() {
        let mut doc = document(
            "01.json",
            json!({"outbounds":[{"tag":"proxy", "protocol":"socks"}], "routing":{"script":"custom.lua"}}),
        );
        assert!(prepare(&settings(), &[doc.clone()]).is_err());
        doc.value["routing"] = json!({});
        doc.value["api"] = json!({"listen":"0.0.0.0:10085", "services":[]});
        assert!(prepare(&settings(), &[doc]).is_err());
        let doc = document(
            "01.json",
            json!({"outbounds":[{"tag":"direct", "protocol":"freedom"}, {"tag":"proxy", "protocol":"socks"}]}),
        );
        assert!(prepare(&settings(), &[doc]).is_err());
    }
    #[tokio::test]
    async fn transaction_rolls_back_and_does_not_clobber_external_edits() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("config.json");
        let journal = dir.join("journal.json");
        fs::write(&path, "old").await.unwrap();
        let changes = vec![FileChange {
            path: path.clone(),
            before: Some("old".into()),
            after: Some("new".into()),
        }];
        commit_files(&changes, &journal).await.unwrap();
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "new");
        rollback(&changes).await.unwrap();
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "old");
        fs::remove_file(&journal).await.unwrap();
        commit_files(&changes, &journal).await.unwrap();
        fs::write(&path, "external").await.unwrap();
        assert!(rollback(&changes).await.is_err());
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "external");
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn transaction_detects_stale_files_before_mutation() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("config.json");
        let journal = dir.join("journal.json");
        fs::write(&path, "external").await.unwrap();
        assert!(
            commit_files(
                &[FileChange {
                    path: path.clone(),
                    before: Some("old".into()),
                    after: None
                }],
                &journal
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "external");
        assert!(!journal.exists());
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn library_saves_and_updates_servers_without_enabling_pool() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("library.json");
        let mut servers = Vec::new();
        upsert_library(&path, &mut servers, server(1)).await.unwrap();
        upsert_library(&path, &mut servers, server(2)).await.unwrap();
        let mut edited = server(1);
        edited.name = "Edited".into();
        upsert_library(&path, &mut servers, edited).await.unwrap();
        let reloaded: Vec<Server> = serde_json::from_str(&fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded[0].name, "Edited");
        assert!(!dir.join("xray-servers.json").exists());
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn invalid_library_server_does_not_overwrite_saved_servers() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("library.json");
        let mut servers = Vec::new();
        upsert_library(&path, &mut servers, server(1)).await.unwrap();
        let before = fs::read_to_string(&path).await.unwrap();
        let mut invalid = server(2);
        invalid.outbound = json!({"protocol": "freedom"});
        assert!(upsert_library(&path, &mut servers, invalid).await.is_err());
        assert_eq!(fs::read_to_string(&path).await.unwrap(), before);
        assert!(
            upsert_library(&path.join("blocked"), &mut servers, server(2))
                .await
                .is_err()
        );
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn rolled_back_transaction_does_not_block_next_save() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("config.json");
        let journal = dir.join("journal.json");
        let store = dir.join("store.json");
        fs::write(&path, "old").await.unwrap();
        let changes = vec![
            FileChange {
                path: path.clone(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
            FileChange {
                path: store.clone(),
                before: None,
                after: Some(pretty(&settings()).unwrap()),
            },
        ];
        commit_files(&changes, &journal).await.unwrap();
        // File rollback completes even when restoring the running core cannot be confirmed.
        rollback_transaction(&changes, &journal).await.unwrap();
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "old");
        assert!(!store.exists());
        assert!(!journal.exists());
        commit_files(&changes, &journal).await.unwrap();
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "new");
        let saved: Settings = serde_json::from_str(&fs::read_to_string(&store).await.unwrap()).unwrap();
        assert!(same_settings(&saved, &settings()));
        finish_journal(&journal).await.unwrap();
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn recovery_rolls_back_partial_transaction_and_allows_retry() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        let config_dir = dir.join("configs");
        fs::create_dir_all(&config_dir).await.unwrap();
        let journal = dir.join("journal.json");
        let store = dir.join("store.json");
        let config = config_dir.join("routing.json");
        let managed = config_dir.join(MANAGED_NAME);
        let changes = vec![
            FileChange {
                path: config.clone(),
                before: Some("old".into()),
                after: Some("new".into()),
            },
            FileChange {
                path: managed.clone(),
                before: None,
                after: Some("managed".into()),
            },
            FileChange {
                path: store.clone(),
                before: None,
                after: Some("settings".into()),
            },
        ];
        // Simulate interruption after only the first two files were written.
        write_private(&journal, &pretty(&changes).unwrap()).await.unwrap();
        fs::write(&config, "new").await.unwrap();
        fs::write(&managed, "managed").await.unwrap();
        assert!(recover_files(&journal, &store, &config_dir).await.unwrap());
        assert_eq!(fs::read_to_string(&config).await.unwrap(), "old");
        assert!(!managed.exists());
        assert!(!store.exists());
        assert!(!journal.exists());
        assert!(!recover_files(&journal, &store, &config_dir).await.unwrap());
        commit_files(&changes, &journal).await.unwrap();
        assert_eq!(fs::read_to_string(&store).await.unwrap(), "settings");
        finish_journal(&journal).await.unwrap();
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn recovery_keeps_journal_when_files_were_edited_externally() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        let config_dir = dir.join("configs");
        fs::create_dir_all(&config_dir).await.unwrap();
        let journal = dir.join("journal.json");
        let store = dir.join("store.json");
        let config = config_dir.join("routing.json");
        let changes = vec![FileChange {
            path: config.clone(),
            before: Some("old".into()),
            after: Some("new".into()),
        }];
        fs::write(&config, "old").await.unwrap();
        commit_files(&changes, &journal).await.unwrap();
        fs::write(&config, "external").await.unwrap();
        assert!(recover_files(&journal, &store, &config_dir).await.is_err());
        assert_eq!(fs::read_to_string(&config).await.unwrap(), "external");
        assert!(journal.exists());
        assert!(commit_files(&changes, &journal).await.is_err());
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn recovery_rejects_paths_outside_pool_files() {
        let dir = std::env::temp_dir().join(format!("xkeen-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let journal = dir.join("journal.json");
        let store = dir.join("store.json");
        let external = dir.join("external.json");
        fs::write(&external, "new").await.unwrap();
        write_private(
            &journal,
            &pretty(&vec![FileChange {
                path: external.clone(),
                before: Some("old".into()),
                after: Some("new".into()),
            }])
            .unwrap(),
        )
        .await
        .unwrap();
        assert!(recover_files(&journal, &store, &dir.join("configs")).await.is_err());
        assert_eq!(fs::read_to_string(&external).await.unwrap(), "new");
        assert!(journal.exists());
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[test]
    fn limits_server_name_by_characters() {
        let mut settings = settings();
        settings.servers[0].name = "я".repeat(100);
        assert!(validate_settings(&settings).is_ok());
        settings.servers[0].name = "я".repeat(101);
        assert!(validate_settings(&settings).is_err());
    }
    #[test]
    fn layout_rejects_overrides_of_the_pool() {
        let managed = document(MANAGED_NAME, json!({"routing": {}, "api": {}}));
        let plain = document("04_outbounds.json", json!({"outbounds": []}));
        assert!(check_layout(&[plain.clone(), managed.clone()]).is_ok());
        let routing = document("05_routing.json", json!({"routing": {"rules": []}}));
        assert!(check_layout(&[routing, managed.clone()]).is_ok());
        let after = document("zzz.json", json!({"routing": {"rules": []}}));
        assert!(check_layout(&[plain, managed, after]).is_err());
    }
    #[test]
    fn restore_keeps_manual_edits_and_returns_taken_sections() {
        let original = FileChange {
            path: Path::new(XRAY_CONF_DIR).join("05_routing.json"),
            before: Some("{\n  // comment\n  \"routing\": {\"rules\": [1]},\n  \"log\": {}\n}".into()),
            after: Some("{\"log\": {}}".into()),
        };
        // Untouched since enabling: the exact original text (with comments) comes back.
        assert_eq!(
            restored_text(&original, Some("{\"log\": {}}")).unwrap(),
            original.before
        );
        // Already restored: nothing to do.
        assert_eq!(restored_text(&original, original.before.as_deref()).unwrap(), None);
        // Deleted: recreated.
        assert_eq!(restored_text(&original, None).unwrap(), original.before);
        // Edited later: edits stay, routing is put back.
        let merged = restored_text(&original, Some("{\"log\": {\"loglevel\": \"debug\"}}"))
            .unwrap()
            .unwrap();
        let merged: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(merged["log"]["loglevel"], "debug");
        assert_eq!(merged["routing"]["rules"], json!([1]));
        assert!(restored_text(&original, Some("not json")).is_err());
    }
}
