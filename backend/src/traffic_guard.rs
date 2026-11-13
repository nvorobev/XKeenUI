//! Блокировка трафика мимо прокси: хук netfilter.d, который отбрасывает транзитный
//! трафик устройств из политики XKeen на проксируемых портах, если XKeen его не перехватил.

use crate::logger::log;
use crate::types::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;

const SCRIPT: &str = include_str!("traffic_guard.sh");
const GUARD_HOOK: &str = "/opt/etc/ndm/netfilter.d/90-xkeen-ui-guard.sh";
const XKEEN_HOOK: &str = "/opt/etc/ndm/netfilter.d/proxy.sh";
const CHAIN: &str = "xkeen_ui_guard";
const SCRIPT_MODE: u32 = 0o755;

#[derive(Deserialize)]
pub struct GuardReq {
    enabled: bool,
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
    let output = Command::new("sh")
        .arg("-c")
        .arg(SCRIPT)
        .arg("sh")
        .args(args)
        .env_remove("type")
        .env_remove("table")
        .output()
        .await
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
    let Ok(output) = Command::new("iptables").args(["-w", "-S", "FORWARD"]).output().await else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
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

pub async fn get_traffic_guard() -> Json<Value> {
    Json(status().await)
}

pub async fn put_traffic_guard(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<GuardReq>,
) -> Json<Value> {
    if let Err(error) = crate::auth::require_admin(&state, &headers) {
        return Json(json!({"success": false, "error": error}));
    }
    let result = if req.enabled { enable().await } else { disable().await };
    match result {
        Ok(()) => Json(status().await),
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

#[cfg(test)]
mod tests {
    use super::*;

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
