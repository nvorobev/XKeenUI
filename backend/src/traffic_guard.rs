//! Блокировка трафика мимо прокси: хук netfilter.d, который отбрасывает транзитный
//! трафик устройств из политики XKeen на проксируемых портах, если XKeen его не перехватил.

use crate::logger::log;
use crate::types::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

const SCRIPT: &str = include_str!("traffic_guard.sh");
const GUARD_HOOK: &str = "/opt/etc/ndm/netfilter.d/90-xkeen-ui-guard.sh";
const XKEEN_HOOK: &str = "/opt/etc/ndm/netfilter.d/proxy.sh";
const CHAIN: &str = "xkeen_ui_guard";
const SCRIPT_MODE: u32 = 0o755;
const CONFIG: &str = "/opt/etc/xkeen/traffic-guard.json";
const HEALTH: &str = "/tmp/xkeen-ui-guard-health";
static LOCK: Mutex<()> = Mutex::const_new(());
static CHANGED: Notify = Notify::const_new();
static HEALTH_STATUS: LazyLock<Mutex<Value>> =
    LazyLock::new(|| Mutex::new(json!({"blocked": true, "vpn": null, "error": "VPN ещё не проверен"})));

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuardMode {
    #[default]
    Proxy,
    Strict,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
struct GuardConfig {
    mode: GuardMode,
    /// Mihomo proxy/group name; Xray always follows the current selected server.
    target: String,
    policy_mark: Option<String>,
}

async fn config() -> Result<GuardConfig, String> {
    match tokio::fs::read(CONFIG).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Настройки защиты повреждены: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GuardConfig::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct GuardReq {
    enabled: bool,
    mode: Option<GuardMode>,
    target: Option<String>,
}

/// Значение переменной из хука XKeen: `name="..."` или `name=...` без кавычек.
fn read_var(hook: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    hook.lines().find_map(|line| {
        let value = line.trim_start().strip_prefix(&prefix)?.trim_end();
        Some(match value.strip_prefix('"') {
            Some(quoted) => quoted.split('"').next().unwrap_or_default().to_string(),
            None => value.to_string(),
        })
    })
}

/// Какие порты XKeen перехватывает, по-человечески.
fn describe_ports(hook: &str) -> String {
    match (read_var(hook, "port_donor"), read_var(hook, "port_exclude")) {
        (Some(donor), _) if !donor.is_empty() => donor.replace(',', ", "),
        (_, Some(exclude)) if !exclude.is_empty() => format!("все, кроме {}", exclude.replace(',', ", ")),
        _ => "все".into(),
    }
}

async fn run_script(args: &[&str]) -> Result<(), String> {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(SCRIPT)
        .arg("sh")
        .args(args)
        .env_remove("type")
        .env_remove("table")
        .kill_on_drop(true);
    let output = command.output();
    let output = tokio::time::timeout(Duration::from_secs(20), output)
        .await
        .map_err(|_| "Применение защиты не завершилось за 20 секунд".to_string())?
        .map_err(|e| format!("Не удалось запустить sh: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Скрипт завершился с кодом {}", output.status.code().unwrap_or(-1))
        } else {
            stderr
        })
    }
}

async fn is_active() -> bool {
    let mut command = Command::new("iptables");
    command.args(["-w", "-S", "FORWARD"]).kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(3), command.output()).await else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.ends_with(&format!("-j {CHAIN}")))
}

async fn status() -> Value {
    let hook = tokio::fs::read_to_string(XKEEN_HOOK).await.ok();
    let policy_mark = hook
        .as_deref()
        .and_then(|h| read_var(h, "policy_mark"))
        .filter(|m| !m.is_empty());
    let enabled = tokio::fs::try_exists(GUARD_HOOK).await.unwrap_or(false);
    let reason = match (&hook, &policy_mark) {
        (None, _) => Some("Не найден хук XKeen (proxy.sh): XKeen не установлен или не запускался"),
        (Some(_), None) => Some("XKeen работает без политики доступа: блокировка работает только с политикой"),
        _ => None,
    };
    json!({
        "success": true,
        "enabled": enabled,
        "active": enabled && is_active().await,
        "supported": reason.is_none(),
        "reason": reason,
        "policy_mark": policy_mark,
        "ports": hook.as_deref().map(describe_ports),
    })
}

pub async fn get_traffic_guard(State(state): State<AppState>) -> Json<Value> {
    Json(full_status(&state).await)
}

async fn full_status(state: &AppState) -> Value {
    let mut result = status().await;
    match config().await {
        Ok(cfg) => {
            result["mode"] = json!(cfg.mode);
            result["target"] = json!(cfg.target);
        }
        Err(error) => result["error"] = json!(error),
    }
    result["health"] = HEALTH_STATUS.lock().await.clone();
    if !lease_fresh().await {
        result["health"]["blocked"] = json!(true);
    }
    if result["mode"] == "strict" {
        let mut command = Command::new("iptables");
        command.args(["-w", "-S", "INPUT"]).kill_on_drop(true);
        let output = command.output();
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(3), output).await {
            result["active"] = json!(
                result["enabled"] == true
                    && output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .any(|line| line.ends_with("-j xkeen_ui_lock"))
            );
        } else {
            result["active"] = json!(false);
        }
    }
    let core = state
        .core
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .name
        .clone();
    result["core"] = json!(core);
    if core == "mihomo"
        && let Ok(proxies) = mihomo_request(state, "proxies").await
    {
        let mut targets: Vec<String> = proxies["proxies"]
            .as_object()
            .into_iter()
            .flat_map(|p| p.iter())
            .filter(|(_, p)| !is_direct(p))
            .map(|(name, _)| name.clone())
            .collect();
        targets.sort();
        result["targets"] = json!(targets);
    }
    result
}

pub async fn put_traffic_guard(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<GuardReq>,
) -> Json<Value> {
    if let Err(error) = crate::auth::require_admin(&state, &headers) {
        return Json(json!({"success": false, "error": error}));
    }
    let _guard = LOCK.lock().await;
    let result = async {
        let mut cfg = match config().await {
            Ok(cfg) => cfg,
            Err(_) if !req.enabled => GuardConfig::default(),
            Err(error) => return Err(error),
        };
        if let Some(mode) = req.mode {
            cfg.mode = mode;
        }
        if let Some(target) = req.target {
            if target.len() > 512 || target.chars().any(char::is_control) {
                return Err("Некорректное имя VPN".to_string());
            }
            cfg.target = target;
        }
        // Close the gate before changing the monitored server or enabling strict mode.
        let _ = tokio::fs::remove_file(HEALTH).await;
        *HEALTH_STATUS.lock().await = json!({"blocked": true, "vpn": null, "error": "VPN ещё не проверен"});
        if req.enabled {
            let hook = tokio::fs::read_to_string(XKEEN_HOOK).await.map_err(|e| e.to_string())?;
            cfg.policy_mark = read_var(&hook, "policy_mark").filter(|m| !m.is_empty());
        }
        let previous = config().await.unwrap_or_default();
        let previous_bytes = serde_json::to_vec_pretty(&previous).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;
        crate::fsutil::write_atomic(CONFIG, bytes, crate::fsutil::PRIVATE_MODE)
            .await
            .map_err(|e| e.to_string())?;
        let applied = if req.enabled { enable().await } else { disable().await };
        if let Err(error) = applied {
            let _ = crate::fsutil::write_atomic(CONFIG, previous_bytes, crate::fsutil::PRIVATE_MODE).await;
            // Reapply the prior mode; health stays closed until a fresh successful probe.
            if Path::new(GUARD_HOOK).exists() {
                let _ = run_script(&[]).await;
            }
            return Err(error);
        }
        CHANGED.notify_one();
        Ok::<_, String>(())
    }
    .await;
    drop(_guard);
    match result {
        Ok(()) => Json(full_status(&state).await),
        Err(error) => {
            log("ERROR", format!("Блокировка трафика мимо прокси: {error}"));
            Json(json!({"success": false, "error": error}))
        }
    }
}

async fn enable() -> Result<(), String> {
    let current = status().await;
    if let Some(reason) = current["reason"].as_str() {
        return Err(reason.into());
    }
    install_hook(Path::new(GUARD_HOOK), || run_script(&[]), || run_script(&["remove"])).await?;
    log("INFO", "Включена блокировка трафика мимо прокси".into());
    Ok(())
}

/// Writes the hook and applies it. On failure a protection that was already installed is
/// kept as it was (the script leaves its working rules in place and the previous hook file
/// returns); only a first-time enable is rolled back completely.
async fn install_hook<A, R>(hook: &Path, apply: impl FnOnce() -> A, remove: impl FnOnce() -> R) -> Result<(), String>
where
    A: Future<Output = Result<(), String>>,
    R: Future<Output = Result<(), String>>,
{
    let previous = tokio::fs::read_to_string(hook).await.ok();
    crate::fsutil::write_atomic(hook, SCRIPT, SCRIPT_MODE)
        .await
        .map_err(|e| format!("Не удалось записать {}: {e}", hook.display()))?;
    let Err(error) = apply().await else {
        return Ok(());
    };
    match previous {
        Some(old) => {
            if old != SCRIPT {
                let _ = crate::fsutil::write_atomic(hook, old, SCRIPT_MODE).await;
            }
            Err(format!(
                "Не удалось применить правила, действующая защита сохранена: {error}"
            ))
        }
        None => {
            let _ = tokio::fs::remove_file(hook).await;
            let _ = remove().await;
            Err(format!("Не удалось применить правила: {error}"))
        }
    }
}

async fn disable() -> Result<(), String> {
    match tokio::fs::remove_file(GUARD_HOOK).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Не удалось удалить {GUARD_HOOK}: {e}")),
    }
    run_script(&["remove"])
        .await
        .map_err(|e| format!("Не удалось снять правила: {e}"))?;
    log("INFO", "Выключена блокировка трафика мимо прокси".into());
    Ok(())
}

/// For the `xkeen-ui traffic-guard on|off` command (used by the installer).
pub async fn set_enabled(enabled: bool) -> Result<(), String> {
    if enabled { enable().await } else { disable().await }
}

/// После обновления панели заменяет установленный хук новой версией скрипта.
pub async fn refresh_installed() {
    let path = Path::new(GUARD_HOOK);
    let Ok(installed) = tokio::fs::read_to_string(path).await else {
        return;
    };
    if installed == SCRIPT {
        if let Err(error) = run_script(&[]).await {
            log("WARN", format!("Не удалось восстановить защиту: {error}"));
        }
        return;
    }
    if let Err(e) = crate::fsutil::write_atomic(path, SCRIPT, SCRIPT_MODE).await {
        log("WARN", format!("Не удалось обновить {GUARD_HOOK}: {e}"));
        return;
    }
    if let Err(e) = run_script(&[]).await {
        log(
            "WARN",
            format!("Не удалось применить обновлённую блокировку трафика: {e}"),
        );
    }
}

// Health checks run in the daemon, independent of the browser. The shell watchdog also
// expires an old success after daemon exit, restart, or a stuck probe.
pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut applied_config = None;
        loop {
            let cfg = config().await;
            if Path::new(GUARD_HOOK).exists() {
                if let Ok(ref cfg) = cfg
                    && applied_config.as_ref() != Some(cfg)
                {
                    let _guard = LOCK.lock().await;
                    let _ = tokio::fs::remove_file(HEALTH).await;
                    match run_script(&[]).await {
                        Ok(()) => applied_config = Some(cfg.clone()),
                        Err(error) => {
                            *HEALTH_STATUS.lock().await = json!({"blocked": true, "error": error, "vpn": null});
                        }
                    }
                }
            } else {
                applied_config = None;
            }
            if Path::new(GUARD_HOOK).exists() && cfg.as_ref().is_ok_and(|c| c.mode == GuardMode::Strict) {
                let cfg = cfg.unwrap_or_default();
                let result = tokio::time::timeout(Duration::from_secs(25), probe(&state, &cfg))
                    .await
                    .map_err(|_| "Истекло время проверки VPN".to_string())
                    .and_then(|r| r);
                let _guard = LOCK.lock().await;
                // A choice made while the probe was running invalidates its answer.
                if Path::new(GUARD_HOOK).exists() && config().await.is_ok_and(|current| current == cfg) {
                    let (vpn, error) = match result {
                        Ok(vpn) => {
                            let lease = async {
                                let uptime = tokio::fs::read_to_string("/proc/uptime")
                                    .await
                                    .map_err(|e| e.to_string())?;
                                let seconds: f64 = uptime
                                    .split_whitespace()
                                    .next()
                                    .unwrap_or("")
                                    .parse()
                                    .map_err(|_| "Не удалось прочитать время работы")?;
                                // A failed next probe closes immediately; this lease covers a stuck or killed daemon.
                                crate::fsutil::write_atomic(
                                    HEALTH,
                                    format!("{} {}\n", std::process::id(), seconds as u64 + 35),
                                    crate::fsutil::PRIVATE_MODE,
                                )
                                .await
                                .map_err(|e| e.to_string())
                            }
                            .await;
                            (Some(vpn), lease.err())
                        }
                        Err(error) => (None, Some(error)),
                    };
                    if error.is_some() {
                        let _ = tokio::fs::remove_file(HEALTH).await;
                    }
                    let applied = run_script(&["tick"]).await;
                    let error = error.or_else(|| applied.err());
                    if error.is_some() {
                        let _ = tokio::fs::remove_file(HEALTH).await;
                    }
                    *HEALTH_STATUS.lock().await = json!({"blocked": error.is_some(), "vpn": vpn, "error": error});
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                _ = CHANGED.notified() => {},
            }
        }
    });
}

async fn lease_fresh() -> bool {
    let Ok(text) = tokio::fs::read_to_string(HEALTH).await else {
        return false;
    };
    let mut fields = text.split_whitespace();
    let pid = fields.next().and_then(|p| p.parse::<u32>().ok());
    let until = fields.next().and_then(|p| p.parse::<f64>().ok());
    let uptime = tokio::fs::read_to_string("/proc/uptime")
        .await
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()));
    pid == Some(std::process::id()) && matches!((until, uptime), (Some(until), Some(now)) if now < until)
}

fn is_direct(proxy: &Value) -> bool {
    matches!(
        proxy["type"].as_str().unwrap_or_default().to_ascii_lowercase().as_str(),
        "direct" | "reject" | "rejectdrop" | "pass"
    )
}

fn mihomo_leaf(proxies: &Value, target: &str) -> Result<String, String> {
    let mut name = target.to_string();
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(name.clone()) {
            return Err("Цикл в группе VPN".into());
        }
        let proxy = proxies.get(&name).ok_or("Выбранный VPN не найден")?;
        if is_direct(proxy) {
            return Err("Выбран прямой или блокирующий выход вместо VPN".into());
        }
        match proxy["now"].as_str() {
            Some(next) => name = next.to_string(),
            None if proxy["all"].is_array() => return Err("У группы VPN нет активного сервера".into()),
            None => return Ok(name),
        }
    }
}

async fn mihomo_request(state: &AppState, path: &str) -> Result<Value, String> {
    use crate::api_relay::{self, ClashTarget};
    let (client, url, secret) = match api_relay::resolve_clash_target().await? {
        ClashTarget::Tcp { host, port, secret } => (
            state.http_client.clone(),
            api_relay::build_url("http", &host, &port, path, None),
            secret,
        ),
        ClashTarget::Unix { path: socket } => (
            reqwest::Client::builder()
                .unix_socket(socket)
                .build()
                .map_err(|e| e.to_string())?,
            format!("http://localhost/{path}"),
            None,
        ),
    };
    let mut request = client.get(url).timeout(Duration::from_secs(10));
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn probe(state: &AppState, cfg: &GuardConfig) -> Result<String, String> {
    let core = state
        .core
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .name
        .clone();
    if (core == "xray" && crate::xray_servers::main_pids().is_empty()) || crate::controller::get_pid(&core).is_empty() {
        return Err("XKeen не запущен".into());
    }
    let (url, budget) = {
        let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            settings.clash_api.ping_url.clone(),
            u64::from(settings.clash_api.ping_timeout).clamp(500, 5000),
        )
    };
    if core == "xray" {
        let (name, mut outbound) = crate::xray_servers::guard_outbound().await?;
        let before = outbound.clone();
        outbound["tag"] = json!("traffic-guard-vpn");
        let samples = crate::healthchecker::probe_servers(state, &[outbound], &url, budget).await?;
        samples.into_iter().next().ok_or("Нет результата проверки VPN")?.1?;
        if crate::xray_servers::guard_outbound().await?.1 != before {
            return Err("Активный VPN изменился, нужна новая проверка".into());
        }
        if state
            .core
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .name
            != core
            || crate::xray_servers::main_pids().is_empty()
        {
            return Err("Ядро изменилось или остановлено".into());
        }
        Ok(name)
    } else if core == "mihomo" {
        if cfg.target.is_empty() {
            return Err("Выберите VPN для проверки в настройках защиты".into());
        }
        let proxies = mihomo_request(state, "proxies").await?;
        let leaf = mihomo_leaf(&proxies["proxies"], &cfg.target)?;
        let path = format!(
            "proxies/{}/delay?url={}&timeout={budget}",
            urlencoding::encode(&leaf),
            urlencoding::encode(&url)
        );
        let delay = mihomo_request(state, &path).await?;
        if delay["delay"].as_u64().is_none_or(|ms| ms == 0) {
            return Err("VPN недоступен".into());
        }
        let fresh = mihomo_request(state, "proxies").await?;
        if mihomo_leaf(&fresh["proxies"], &cfg.target)? != leaf {
            return Err("Активный VPN изменился, нужна новая проверка".into());
        }
        Ok(leaf)
    } else {
        Err("Ядро не поддерживается".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_guard_requests_keep_legacy_mode_and_unknown_modes_are_rejected() {
        let req: GuardReq = serde_json::from_value(json!({"enabled": true})).unwrap();
        assert!(req.mode.is_none());
        assert_eq!(GuardConfig::default().mode, GuardMode::Proxy);
        assert!(serde_json::from_value::<GuardReq>(json!({"enabled": true, "mode": "other"})).is_err());
    }

    #[test]
    fn selected_mihomo_group_must_resolve_to_a_real_vpn_not_direct_or_a_cycle() {
        let proxies = json!({
            "VPN": {"type": "Selector", "now": "fallback"},
            "fallback": {"type": "Fallback", "now": "A"},
            "A": {"type": "Vless"},
            "DIRECT": {"type": "Direct"},
            "bad": {"type": "Selector", "now": "DIRECT"},
            "cycle": {"type": "Selector", "now": "cycle"},
            "empty": {"type": "Selector", "all": []}
        });
        assert_eq!(mihomo_leaf(&proxies, "VPN").unwrap(), "A");
        for name in ["DIRECT", "bad", "cycle", "empty", "missing"] {
            assert!(mihomo_leaf(&proxies, name).is_err(), "{name}");
        }
    }

    const HOOK: &str = "#!/bin/sh\n\nport_donor=\"80,443\"\nport_exclude=\"\"\npolicy_mark=\"0xffffaaa\"\n";

    #[test]
    fn reads_xkeen_hook_variables() {
        assert_eq!(read_var(HOOK, "policy_mark").as_deref(), Some("0xffffaaa"));
        assert_eq!(read_var(HOOK, "port_exclude").as_deref(), Some(""));
        assert_eq!(read_var(HOOK, "missing"), None);
        assert_eq!(
            read_var("ip6tables_supported=false\n", "ip6tables_supported").as_deref(),
            Some("false")
        );
        assert_eq!(
            read_var("policy_mark=0xffffaaa  \n", "policy_mark").as_deref(),
            Some("0xffffaaa")
        );
    }

    #[test]
    fn describes_proxied_ports() {
        assert_eq!(describe_ports(HOOK), "80, 443");
        let exclude = HOOK
            .replace("port_donor=\"80,443\"", "port_donor=\"\"")
            .replace("port_exclude=\"\"", "port_exclude=\"22\"");
        assert_eq!(describe_ports(&exclude), "все, кроме 22");
        assert_eq!(describe_ports("policy_mark=\"0x1\""), "все");
    }

    fn temp_hook() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("90-xkeen-ui-guard.sh")
    }

    #[tokio::test]
    async fn failed_reapply_keeps_the_working_protection() {
        let hook = temp_hook();
        std::fs::write(&hook, "previous hook").unwrap();
        let removed = std::sync::atomic::AtomicBool::new(false);
        let result = install_hook(
            &hook,
            || async { Err("iptables: bad rule".to_string()) },
            || async {
                removed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.unwrap_err().contains("действующая защита сохранена"));
        assert_eq!(std::fs::read_to_string(&hook).unwrap(), "previous hook");
        assert!(!removed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn failed_first_enable_is_rolled_back() {
        let hook = temp_hook();
        let removed = std::sync::atomic::AtomicBool::new(false);
        let result = install_hook(
            &hook,
            || async { Err("iptables: bad rule".to_string()) },
            || async {
                removed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert!(!hook.exists());
        assert!(removed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            install_hook(&hook, || async { Ok(()) }, || async { Ok(()) })
                .await
                .is_ok()
        );
        assert_eq!(std::fs::read_to_string(&hook).unwrap(), SCRIPT);
    }
}
