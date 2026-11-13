use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeSet, HashSet};
use std::time::Duration;

#[derive(Deserialize)]
pub struct DnsEnableReq {
    pub config_content: String,
    #[serde(default = "default_true")]
    pub setup_filter: bool,
}

#[derive(Deserialize)]
pub struct DnsDeleteReq {}

fn default_true() -> bool {
    true
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsStatusFields {
    pub dns_override: bool,
    pub dns_mihomo: bool,
    pub has_provider_nameservers: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_listener: Option<String>,
}

fn check_dns_mihomo() -> bool {
    let Ok(content) = std::fs::read_to_string(MIHOMO_CONF) else {
        return false;
    };
    let Ok(documents) = yaml_rust2::YamlLoader::load_from_str(&content) else {
        return false;
    };
    documents.first().is_some_and(|document| {
        document["dns"]["enable"].as_bool().unwrap_or(false) && document["dns"]["listen"].as_str() == Some("0.0.0.0:53")
    })
}

fn parse_dns_status(output: &str, has_provider_nameservers: bool, port_listener: Option<String>) -> DnsStatusFields {
    DnsStatusFields {
        dns_override: output.contains("opkg dns-override"),
        dns_mihomo: check_dns_mihomo(),
        has_provider_nameservers,
        port_listener,
    }
}

fn has_dhcp_nameserver(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            if map
                .get("service")
                .and_then(|s| s.as_str())
                .is_some_and(|s| s.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("dhcp")))
            {
                return true;
            }
            map.values().any(has_dhcp_nameserver)
        }
        serde_json::Value::Array(items) => items.iter().any(has_dhcp_nameserver),
        _ => false,
    }
}

#[derive(serde::Serialize)]
pub struct DnsResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<DnsStatusFields>,
}

async fn get_br0_ip() -> Result<String, String> {
    let output = tokio::process::Command::new("ip")
        .args(["-4", "a", "s", "br0"])
        .output()
        .await
        .map_err(|e| format!("Ошибка выполнения ip: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("inet ")
            && let Some(ip) = rest.split('/').next()
        {
            return Ok(ip.to_string());
        }
    }
    Err("Не удалось получить IP адрес br0".into())
}

pub(crate) async fn fetch_rci(state: &AppState, endpoint: &str) -> Result<serde_json::Value, String> {
    let mut req = state
        .http_client
        .get(format!("http://127.0.0.1:79/rci/show/{endpoint}"))
        .timeout(Duration::from_secs(5));
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Ошибка запроса RCI ({endpoint}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("RCI ({endpoint}) вернул {}", response.status()));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Ошибка парсинга RCI ({endpoint}): {e}"))
}

async fn fetch_running_config(state: &AppState) -> Result<String, String> {
    let data = fetch_rci(state, "running-config").await?;
    let lines = data
        .get("message")
        .and_then(|m| m.as_array())
        .ok_or_else(|| "В ответе RCI отсутствует массив 'message'".to_string())?;

    let config_str = lines
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<&str>>()
        .join("\n");

    Ok(config_str)
}

pub(crate) async fn post_rci_batch(
    state: &AppState, commands: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    let mut req = state
        .http_client
        .post("http://127.0.0.1:79/rci/")
        .json(commands)
        .timeout(Duration::from_secs(10));

    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req.send().await.map_err(|e| format!("Ошибка POST RCI batch: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let err = response.text().await.unwrap_or_default();
        return Err(format!("RCI batch вернул {status}, ответ: {err}"));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Ошибка парсинга RCI batch: {e}"))
}

pub(crate) fn find_batch_error(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(items) = map.get("status").and_then(|s| s.as_array()) {
                for item in items {
                    if item.get("status").and_then(|s| s.as_str()) == Some("error") {
                        let msg = item
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("неизвестная ошибка RCI");
                        let extra = format!(
                            "{} {}",
                            item.get("ident").and_then(|v| v.as_str()).unwrap_or(""),
                            item.get("code").and_then(|v| v.as_str()).unwrap_or("")
                        )
                        .trim()
                        .to_string();
                        if extra.is_empty() {
                            return Some(msg.to_string());
                        }
                        return Some(format!("{msg} ({extra})"));
                    }
                }
            }
            for v in map.values() {
                if let Some(e) = find_batch_error(v) {
                    return Some(e);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(e) = find_batch_error(item) {
                    return Some(e);
                }
            }
            None
        }
        _ => None,
    }
}

fn check_batch_response(resp: &serde_json::Value, steps: &[&str], ignore: &[(usize, &str)]) -> Result<(), String> {
    let items = resp
        .as_array()
        .ok_or_else(|| "Некорректный ответ RCI batch".to_string())?;
    for (i, item) in items.iter().enumerate() {
        let step = steps.get(i).copied().unwrap_or("?");
        if let Some(err) = find_batch_error(item) {
            if let Some((_, component)) = ignore.iter().find(|(idx, _)| *idx == i) {
                log(
                    "WARN",
                    format!("Не удалось очистить {component} (компонент не установлен?)"),
                );
                continue;
            }
            log("ERROR", format!("DNS: '{step}' — ошибка: {err}"));
            return Err(format!("{step}: {err}"));
        }
    }
    Ok(())
}

fn port_53_inodes(table: &str, protocol: &str) -> Vec<u64> {
    let only_listening = protocol.starts_with("tcp");
    table
        .lines()
        .skip(1)
        .map(|line| line.split_whitespace().collect::<Vec<_>>())
        .filter(|fields| {
            fields.len() >= 10
                && fields[1].ends_with(":0035")
                && if only_listening {
                    fields[3] == "0A"
                } else {
                    fields[2].ends_with(":0000")
                }
        })
        .filter_map(|fields| fields[9].parse::<u64>().ok())
        .filter(|inode| *inode != 0)
        .collect()
}

fn port_53_listener() -> Option<String> {
    let mut sockets = HashSet::new();
    for protocol in ["tcp", "udp", "tcp6", "udp6"] {
        let table = std::fs::read_to_string(format!("/proc/net/{protocol}")).unwrap_or_default();
        sockets.extend(
            port_53_inodes(&table, protocol)
                .into_iter()
                .map(|inode| format!("socket:[{inode}]")),
        );
    }
    if sockets.is_empty() {
        return None;
    }

    let mut names = BTreeSet::new();
    for process in std::fs::read_dir("/proc").ok()?.flatten() {
        let Ok(descriptors) = std::fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        let is_listener = descriptors.flatten().any(|descriptor| {
            std::fs::read_link(descriptor.path()).is_ok_and(|link| sockets.contains(link.to_string_lossy().as_ref()))
        });
        if is_listener {
            let name = std::fs::read_to_string(process.path().join("comm")).unwrap_or_default();
            names.insert(name.trim().to_string());
        }
    }
    if names.is_empty() {
        names.insert("unknown".to_string());
    }
    Some(names.into_iter().collect::<Vec<_>>().join(", "))
}

pub async fn get_dns(State(state): State<AppState>) -> impl IntoResponse {
    let (running, name_servers) = tokio::join!(fetch_running_config(&state), fetch_rci(&state, "ip/name-server"));
    match running {
        Ok(output) => {
            let has_provider_nameservers = match &name_servers {
                Ok(data) => has_dhcp_nameserver(data),
                Err(e) => {
                    log("WARN", format!("Не удалось получить ip name-server: {e}"));
                    true
                }
            };
            let mut port_listener = tokio::task::spawn_blocking(port_53_listener).await.ok().flatten();
            for delay_ms in [1000, 2000] {
                if port_listener.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                port_listener = tokio::task::spawn_blocking(port_53_listener).await.ok().flatten();
            }
            Json(DnsResponse {
                success: true,
                error: None,
                status: Some(parse_dns_status(&output, has_provider_nameservers, port_listener)),
            })
        }
        Err(e) => Json(DnsResponse {
            success: false,
            error: Some(e),
            status: None,
        }),
    }
}

/// Router DNS settings that enabling DNS management replaces, kept to put them back.
#[derive(serde::Serialize, Deserialize, Debug, Default, PartialEq, Clone)]
struct DnsSnapshot {
    /// Arguments of `ip name-server …` lines.
    name_servers: Vec<String>,
    /// `tls upstream …` / `https upstream …` lines of the `dns-proxy` section.
    upstreams: Vec<String>,
    dns_override: bool,
    /// Whether the enable also replaced the upstreams and name servers (`setup_filter`).
    #[serde(default)]
    filter_applied: bool,
}

/// Where the settings from before the first enable are kept until DNS management is disabled.
const DNS_SNAPSHOT: &str = "/opt/etc/xkeen/xkeen-ui-dns.json";

fn dns_snapshot(running_config: &str) -> DnsSnapshot {
    let mut snapshot = DnsSnapshot::default();
    let mut in_dns_proxy = false;
    for line in running_config.lines() {
        if !line.starts_with(' ') {
            in_dns_proxy = line.trim_end() == "dns-proxy";
        }
        let trimmed = line.trim();
        if let Some(rest) = line.strip_prefix("ip name-server ") {
            snapshot.name_servers.push(rest.trim().to_string());
        } else if line.trim_end() == "opkg dns-override" {
            snapshot.dns_override = true;
        } else if in_dns_proxy && (trimmed.starts_with("tls upstream ") || trimmed.starts_with("https upstream ")) {
            snapshot.upstreams.push(trimmed.to_string());
        }
    }
    snapshot
}

/// Commands that bring the router DNS settings back to `snapshot`.
fn restore_commands(snapshot: &DnsSnapshot) -> Vec<serde_json::Value> {
    let mut commands = Vec::new();
    if !snapshot.dns_override {
        commands.push(json!({"opkg": {"dns-override": {"no": true}}}));
    }
    // Upstreams and name servers changed only when the enable set up the filter.
    if snapshot.filter_applied {
        commands.push(json!({"ip": {"name-server": [{"no": true}]}}));
        for server in &snapshot.name_servers {
            commands.push(json!({"parse": format!("ip name-server {server}")}));
        }
        for upstream in &snapshot.upstreams {
            commands.push(json!({"parse": format!("dns-proxy {upstream}")}));
        }
    }
    commands.push(json!({"system": {"configuration": {"save": {}}}}));
    commands
}

/// What to keep after an enable: the first snapshot wins, but an enable that sets up the
/// filter for the first time adds the upstreams and name servers it is about to replace
/// (an earlier enable without the filter left them as they originally were).
fn merge_snapshot(stored: Option<DnsSnapshot>, current: DnsSnapshot) -> Option<DnsSnapshot> {
    match stored {
        None => Some(current),
        Some(stored) if !stored.filter_applied && current.filter_applied => Some(DnsSnapshot {
            dns_override: stored.dns_override,
            ..current
        }),
        Some(_) => None,
    }
}

async fn restore_router_dns(state: &AppState, snapshot: &DnsSnapshot) -> Result<(), String> {
    let reply = post_rci_batch(state, &restore_commands(snapshot)).await?;
    match find_batch_error(&reply) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub async fn post_dns(State(state): State<AppState>, Json(req): Json<DnsEnableReq>) -> impl IntoResponse {
    let br0_ip = match get_br0_ip().await {
        Ok(ip) => ip,
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    };

    let mut steps: Vec<(&str, serde_json::Value)> = vec![];
    let mut ignore: Vec<(usize, &str)> = vec![];

    if req.setup_filter {
        ignore.push((steps.len(), "DoH"));
        steps.push((
            "Отключение HTTPS DNS-прокси",
            json!({"dns-proxy": {"https": {"upstream": [{"no": true}]}}}),
        ));
        ignore.push((steps.len(), "DoT"));
        steps.push((
            "Отключение TLS DNS-прокси",
            json!({"dns-proxy": {"tls": {"upstream": [{"no": true}]}}}),
        ));
        steps.push((
            "Сброс системных DNS-серверов",
            json!({"ip": {"name-server": [{"no": true}]}}),
        ));
        steps.push((
            "Установка name-server на br0",
            json!({"ip": {"name-server": [{"address": br0_ip}]}}),
        ));
    }
    steps.push(("Включение opkg dns-override", json!({"opkg": {"dns-override": {}}})));
    steps.push((
        "Сохранение конфигурации",
        json!({"system": {"configuration": {"save": {}}}}),
    ));

    let step_names: Vec<&str> = steps.iter().map(|(s, _)| *s).collect();
    let payload: Vec<serde_json::Value> = steps.into_iter().map(|(_, v)| v).collect();

    // What the router had before, to put back if anything below fails (and on disable).
    let snapshot = match fetch_running_config(&state).await {
        Ok(config) => DnsSnapshot {
            filter_applied: req.setup_filter,
            ..dns_snapshot(&config)
        },
        Err(e) => {
            let error = format!("Не удалось прочитать настройки DNS роутера: {e}");
            log("ERROR", error.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(error),
                status: None,
            });
        }
    };

    // Keep the settings from before the first enable (a repeated enable must not overwrite
    // them) before touching anything: without this copy a later disable could not restore them.
    let stored_snapshot = tokio::fs::read(DNS_SNAPSHOT).await.ok();
    let stored = stored_snapshot
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<DnsSnapshot>(bytes).ok());
    if let Some(to_store) = merge_snapshot(stored, snapshot.clone()) {
        let written = match serde_json::to_vec_pretty(&to_store) {
            Ok(text) => crate::fsutil::write_atomic(DNS_SNAPSHOT, text, crate::fsutil::PRIVATE_MODE)
                .await
                .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = written {
            let error = format!("Не удалось сохранить прежние настройки DNS ({e}). Настройки роутера не изменены");
            log("ERROR", error.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(error),
                status: None,
            });
        }
    }
    // Puts the snapshot file back as it was before this enable.
    let restore_snapshot_file = || async {
        let _ = match &stored_snapshot {
            Some(bytes) => crate::fsutil::write_atomic(DNS_SNAPSHOT, bytes, crate::fsutil::PRIVATE_MODE).await,
            None => tokio::fs::remove_file(DNS_SNAPSHOT).await,
        };
    };

    // The router hands DNS to Mihomo only once Mihomo's config is in place: a failed write
    // must not leave the router without name resolution.
    let previous = tokio::fs::read(MIHOMO_CONF).await.ok();
    if let Err(e) = crate::fsutil::write_atomic(MIHOMO_CONF, &req.config_content, crate::fsutil::DEFAULT_MODE).await {
        let error = format!("Не удалось записать {MIHOMO_CONF}: {e}. Настройки DNS роутера не изменены");
        log("ERROR", error.clone());
        restore_snapshot_file().await;
        return Json(DnsResponse {
            success: false,
            error: Some(error),
            status: None,
        });
    }
    let applied = match post_rci_batch(&state, &payload).await {
        Ok(resp) => check_batch_response(&resp, &step_names, &ignore),
        Err(e) => Err(e),
    };
    if let Err(e) = applied {
        log("ERROR", e.clone());
        // Part of the batch may have gone through: put the router settings back.
        match restore_router_dns(&state, &snapshot).await {
            Ok(()) => restore_snapshot_file().await,
            // The copy stays: a later disable can still bring the settings back.
            Err(restore_error) => log(
                "ERROR",
                format!("Не удалось вернуть прежние настройки DNS роутера: {restore_error}"),
            ),
        }
        let restored = match previous {
            Some(content) => crate::fsutil::write_atomic(MIHOMO_CONF, content, crate::fsutil::DEFAULT_MODE).await,
            None => tokio::fs::remove_file(MIHOMO_CONF).await,
        };
        if let Err(restore_error) = restored {
            log(
                "ERROR",
                format!("Не удалось вернуть прежний {MIHOMO_CONF}: {restore_error}"),
            );
        }
        return Json(DnsResponse {
            success: false,
            error: Some(e),
            status: None,
        });
    }

    tokio::time::sleep(Duration::from_millis(500)).await;

    let message = if req.setup_filter {
        format!("Управление DNS включено, name-server установлен: {br0_ip}:53")
    } else {
        "Управление DNS включено".into()
    };
    log("INFO", message);
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

pub async fn delete_dns(State(state): State<AppState>, Json(_req): Json<DnsDeleteReq>) -> impl IntoResponse {
    // Settings saved before the first enable come back exactly as they were.
    let saved = tokio::fs::read(DNS_SNAPSHOT)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DnsSnapshot>(&bytes).ok());
    if let Some(snapshot) = saved {
        return match restore_router_dns(&state, &snapshot).await {
            Ok(()) => {
                let _ = tokio::fs::remove_file(DNS_SNAPSHOT).await;
                log(
                    "INFO",
                    "Управление DNS отключено, прежние настройки DNS роутера возвращены".into(),
                );
                Json(DnsResponse {
                    success: true,
                    error: None,
                    status: None,
                })
            }
            Err(e) => {
                log("ERROR", e.clone());
                Json(DnsResponse {
                    success: false,
                    error: Some(e),
                    status: None,
                })
            }
        };
    }
    let has_br0 = match fetch_running_config(&state).await {
        Ok(output) => {
            let br0_ip = get_br0_ip().await.unwrap_or_default();
            output.contains(&format!("ip name-server {br0_ip}"))
        }
        Err(_) => false,
    };

    let mut steps: Vec<(&str, serde_json::Value)> = vec![(
        "Отключение opkg dns-override",
        json!({"opkg": {"dns-override": {"no": true}}}),
    )];
    if has_br0 {
        steps.push((
            "Сброс системных DNS-серверов",
            json!({"ip": {"name-server": [{"no": true}]}}),
        ));
        steps.push((
            "Установка name-server на 77.88.8.8",
            json!({"ip": {"name-server": [{"address": "77.88.8.8"}]}}),
        ));
    }
    steps.push((
        "Сохранение конфигурации",
        json!({"system": {"configuration": {"save": {}}}}),
    ));

    let step_names: Vec<&str> = steps.iter().map(|(s, _)| *s).collect();
    let payload: Vec<serde_json::Value> = steps.into_iter().map(|(_, v)| v).collect();
    match post_rci_batch(&state, &payload).await {
        Ok(resp) => {
            if let Err(e) = check_batch_response(&resp, &step_names, &[]) {
                return Json(DnsResponse {
                    success: false,
                    error: Some(e),
                    status: None,
                });
            }
        }
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    }

    let message = if has_br0 {
        "Управление DNS отключено, name-server установлен: 77.88.8.8:53"
    } else {
        "Управление DNS отключено"
    };
    log("INFO", message.into());
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn batch_payload_enable_with_filter_shape() {
        let br0_ip = "192.168.1.1";
        let payload = [
            json!({"dns-proxy": {"https": {"upstream": [{"no": true}]}}}),
            json!({"dns-proxy": {"tls": {"upstream": [{"no": true}]}}}),
            json!({"ip": {"name-server": [{"no": true}]}}),
            json!({"ip": {"name-server": [{"address": br0_ip}]}}),
            json!({"opkg": {"dns-override": {}}}),
            json!({"system": {"configuration": {"save": {}}}}),
        ];
        assert_eq!(payload.len(), 6);
        assert_eq!(payload[3]["ip"]["name-server"][0]["address"], json!(br0_ip));
        assert_eq!(payload[5]["system"]["configuration"]["save"], json!({}));
    }

    #[test]
    fn finds_nested_batch_error() {
        let ok = json!([{}, {"status": [{"status": "message", "message": "saving (http/rci)."}]}]);
        assert!(find_batch_error(&ok[0]).is_none());
        assert!(find_batch_error(&ok[1]).is_none());

        let nested = json!({"system": {"configuration": {"save": {"status": [{"status": "error", "code": "1", "ident": "X", "message": "boom"}]}}}});
        assert_eq!(find_batch_error(&nested), Some("boom (X 1)".to_string()));
    }

    #[test]
    fn check_ignores_optional_components() {
        let steps = ["DoH", "DoT", "save"];
        let one_error = json!([
            {"status": [{"status": "error", "message": "no such command"}]},
            {},
            {},
        ]);
        assert!(check_batch_response(&one_error, &steps, &[]).is_err());
        assert!(check_batch_response(&one_error, &steps, &[(0, "DoH")]).is_ok());

        let two_errors = json!([
            {"status": [{"status": "error", "message": "absent"}]},
            {"status": [{"status": "error", "message": "absent"}]},
            {},
        ]);
        assert!(check_batch_response(&two_errors, &steps, &[(0, "DoH")]).is_err());
        assert!(check_batch_response(&two_errors, &steps, &[(0, "DoH"), (1, "DoT")]).is_ok());
    }

    #[test]
    fn handles_real_missing_component_response() {
        let resp = json!([
            {"ip": {"name-server": [{"status": [{"status": "message", "code": "22544390", "ident": "Dns::Manager", "message": "static IPv4 name server list cleared."}]}]}},
            {"dns-proxy": {"tlss": {"upstream": [{}], "status": [{"status": "error", "code": "1179781", "ident": "Core::Configurator", "message": "not found: \"dns-proxy/tlss/upstream\" [admin]."}]}}},
            {"dns-proxy": {"https": {"upstream": [{"status": [{"status": "message", "code": "22610920", "ident": "Dns::Secure::ManagerDoh", "message": "DNS-over-HTTPS name servers cleared."}]}]}}},
            {"system": {"configuration": {"save": {"status": [{"status": "message", "code": "8912996", "ident": "Core::System::StartupConfig", "message": "saving (http/rci)."}]}}}}
        ]);
        let steps = ["name-server", "tls-upstream", "https-upstream", "save"];

        assert!(check_batch_response(&resp, &steps, &[(1, "DoT")]).is_ok());

        let err = check_batch_response(&resp, &steps, &[]).unwrap_err();
        assert!(err.contains("tls-upstream"), "unexpected: {err}");
        assert!(err.contains("not found"), "unexpected: {err}");
    }

    const TABLE_HEADER: &str =
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const UNCONNECTED_REMOTE: &str = "00000000:0000";

    fn table_row(local: &str, remote: &str, state: &str, inode: u64) -> String {
        format!(
            "   0: {local} {remote} {state} 00000000:00000000 00:00000000 00000000     0        0 {inode} 1 0000000000000000 100 0 0 10 0\n"
        )
    }

    #[test]
    fn parses_tcp_listening_port_53() {
        let table = [
            TABLE_HEADER.to_string(),
            table_row("00000000:0035", UNCONNECTED_REMOTE, "0A", 12345),
            table_row("0100007F:0035", UNCONNECTED_REMOTE, "0A", 0),
            table_row("0100007F:01BB", UNCONNECTED_REMOTE, "0A", 99999),
            table_row("0100007F:0035", UNCONNECTED_REMOTE, "01", 555),
        ]
        .concat();
        assert_eq!(port_53_inodes(&table, "tcp"), vec![12345]);
    }

    #[test]
    fn parses_udp_only_unconnected() {
        let table = [
            TABLE_HEADER.to_string(),
            table_row("00000000:0035", UNCONNECTED_REMOTE, "07", 777),
            table_row("0100007F:0035", "0100007F:DDB0", "01", 888),
        ]
        .concat();
        assert_eq!(port_53_inodes(&table, "udp6"), vec![777]);
    }

    #[test]
    fn detects_dhcp_nameservers() {
        let resp = json!([{"show": {"ip": {"name-server": {"server": [
            {"address": "192.168.1.1", "domain": "", "global": 0, "service": "Dns::Manager", "interface": ""},
            {"address": "62.112.106.130", "domain": "", "global": 65280, "service": "Dhcp::Client-GigabitEthernet1", "interface": "GigabitEthernet1"},
            {"address": "62.112.113.170", "domain": "", "global": 65280, "service": "Dhcp::Client-GigabitEthernet1", "interface": "GigabitEthernet1"},
        ]}}}}]);
        assert!(has_dhcp_nameserver(&resp));

        let static_only = json!([{"show": {"ip": {"name-server": {"server": [
            {"address": "192.168.1.1", "domain": "", "global": 0, "service": "Dns::Manager", "interface": ""},
            {"address": "77.88.8.8", "domain": "", "global": 0, "service": "Dns::Manager", "interface": ""},
        ]}}}}]);
        assert!(!has_dhcp_nameserver(&static_only));

        assert!(!has_dhcp_nameserver(&json!([])));
        assert!(!has_dhcp_nameserver(&json!({})));
        assert!(!has_dhcp_nameserver(&json!([{"show": {"ip": {}}}])));
        assert!(!has_dhcp_nameserver(&json!([{"service": 42}])));
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    const CONFIG: &str = "ip name-server 192.168.1.1:53\nopkg dns-override\ndns-proxy\n    rebind-protect auto\n    tls upstream 9.9.9.9\n    https upstream https://1.1.1.1/dns-query dnsm\n!\ninterface Home\n    https upstream not-dns\n!\n";

    #[test]
    fn snapshot_reads_router_dns_settings() {
        let snapshot = dns_snapshot(CONFIG);
        assert_eq!(snapshot.name_servers, ["192.168.1.1:53"]);
        assert!(snapshot.dns_override);
        assert_eq!(
            snapshot.upstreams,
            ["tls upstream 9.9.9.9", "https upstream https://1.1.1.1/dns-query dnsm"]
        );
    }

    #[test]
    fn restore_puts_settings_back() {
        let snapshot = DnsSnapshot {
            filter_applied: true,
            ..dns_snapshot(CONFIG)
        };
        let commands = restore_commands(&snapshot);
        assert_eq!(commands[0], json!({"ip": {"name-server": [{"no": true}]}}));
        assert!(commands.contains(&json!({"parse": "ip name-server 192.168.1.1:53"})));
        assert!(commands.contains(&json!({"parse": "dns-proxy tls upstream 9.9.9.9"})));
        assert!(commands.contains(&json!({"parse": "dns-proxy https upstream https://1.1.1.1/dns-query dnsm"})));
        assert_eq!(
            commands.last(),
            Some(&json!({"system": {"configuration": {"save": {}}}}))
        );
        // Without dns-override before, it is switched off again.
        let plain = restore_commands(&DnsSnapshot::default());
        assert_eq!(plain[0], json!({"opkg": {"dns-override": {"no": true}}}));
        // Without the filter only dns-override changed: upstreams and name servers stay untouched.
        let no_filter = restore_commands(&dns_snapshot(CONFIG));
        // Enable without the filter, then with it: the original upstreams join the snapshot.
        let first = DnsSnapshot {
            dns_override: false,
            ..DnsSnapshot::default()
        };
        let second = DnsSnapshot {
            filter_applied: true,
            dns_override: true,
            ..dns_snapshot(CONFIG)
        };
        let merged = merge_snapshot(Some(first), second).unwrap();
        assert!(!merged.dns_override && merged.filter_applied && merged.upstreams.len() == 2);
        assert_eq!(merge_snapshot(Some(merged), DnsSnapshot::default()), None);
        assert!(
            no_filter
                .iter()
                .all(|c| c.get("parse").is_none() && c.get("ip").is_none())
        );
    }
}
