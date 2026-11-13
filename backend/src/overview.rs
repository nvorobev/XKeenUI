//! Data for the overview page that only the router knows: devices with their XKeen policy
//! membership and byte counters, and the speed of the internet connection (Keenetic RCI).

use crate::dns::{fetch_rci, find_batch_error, post_rci_batch};
use crate::logger::log;
use crate::types::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// XKeen finds its policy by this description (`name_policy` in its init script).
const XKEEN_POLICY: &str = "xkeen";

#[derive(Serialize, Debug, PartialEq)]
struct Policy {
    name: String,
    description: String,
}

#[derive(Serialize, Debug, PartialEq)]
struct Device {
    mac: String,
    name: String,
    ip: String,
    active: bool,
    registered: bool,
    in_xkeen: bool,
    /// What the device downloaded and uploaded. Keenetic counts `rxbytes`/`txbytes` from the
    /// device's side: a download on the device grows `rxbytes` (checked on a KN-1811).
    rx_bytes: u64,
    tx_bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
struct Wan {
    interface: String,
    /// Bits per second, as Keenetic reports them.
    rx_bps: u64,
    tx_bps: u64,
}

/// The policy whose description is "XKeen" (case-insensitive), like XKeen looks it up.
fn xkeen_policy(policies: &Value) -> Option<Policy> {
    policies.as_object()?.iter().find_map(|(name, policy)| {
        let description = policy.get("description")?.as_str()?;
        description.eq_ignore_ascii_case(XKEEN_POLICY).then(|| Policy {
            name: name.clone(),
            description: description.to_string(),
        })
    })
}

/// Interface of the policy's default route: the connection its devices leave through.
fn policy_wan(policies: &Value, policy: &str) -> Option<String> {
    policies
        .get(policy)?
        .get("route4")?
        .get("route")?
        .as_array()?
        .iter()
        .find(|route| route.get("destination").and_then(Value::as_str) == Some("0.0.0.0/0"))?
        .get("interface")?
        .as_str()
        .map(str::to_string)
}

fn devices(hosts: &Value, policy: Option<&str>) -> Vec<Device> {
    let text = |host: &Value, key: &str| host.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let flag = |host: &Value, key: &str| host.get(key).and_then(Value::as_bool).unwrap_or(false);
    let bytes = |host: &Value, key: &str| host.get(key).and_then(Value::as_u64).unwrap_or(0);
    let mut list: Vec<Device> = hosts
        .get("host")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|host| {
            let mac = text(host, "mac");
            if mac.is_empty() {
                return None;
            }
            let name = Some(text(host, "name"))
                .filter(|name| !name.is_empty() && *name != mac)
                .or_else(|| Some(text(host, "hostname")).filter(|name| !name.is_empty()))
                .unwrap_or_else(|| mac.clone());
            Some(Device {
                in_xkeen: policy.is_some_and(|policy| text(host, "policy") == policy),
                name,
                ip: text(host, "ip"),
                active: flag(host, "active"),
                registered: flag(host, "registered"),
                rx_bytes: bytes(host, "rxbytes"),
                tx_bytes: bytes(host, "txbytes"),
                mac,
            })
        })
        .collect();
    // Keenetic lists a device behind a repeater once per IP address, with the counters on
    // only one entry: merge them so each device has one row and steady byte counters.
    let mut merged: Vec<Device> = Vec::with_capacity(list.len());
    for device in list.drain(..) {
        match merged.iter_mut().find(|known| known.mac == device.mac) {
            Some(known) => {
                if device.rx_bytes + device.tx_bytes > known.rx_bytes + known.tx_bytes {
                    known.ip = device.ip;
                }
                known.rx_bytes += device.rx_bytes;
                known.tx_bytes += device.tx_bytes;
                known.active |= device.active;
                known.registered |= device.registered;
                known.in_xkeen |= device.in_xkeen;
            }
            None => merged.push(device),
        }
    }
    let mut list = merged;
    // Policy members first, then online devices, then by name.
    list.sort_by(|a, b| {
        b.in_xkeen
            .cmp(&a.in_xkeen)
            .then(b.active.cmp(&a.active))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    list
}

async fn wan_speed(state: &AppState, interface: &str) -> Option<Wan> {
    let stat = fetch_rci(state, &format!("interface/stat?name={interface}"))
        .await
        .ok()?;
    Some(Wan {
        interface: interface.to_string(),
        rx_bps: stat.get("rxspeed")?.as_u64()?,
        tx_bps: stat.get("txspeed")?.as_u64()?,
    })
}

pub async fn get_overview(State(state): State<AppState>) -> Json<Value> {
    let (policies, hosts) = tokio::join!(fetch_rci(&state, "ip/policy"), fetch_rci(&state, "ip/hotspot"));
    let hosts = match hosts {
        Ok(hosts) => hosts,
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    let policies = policies.unwrap_or(Value::Null);
    let policy = xkeen_policy(&policies);
    let wan = match policy.as_ref().and_then(|p| policy_wan(&policies, &p.name)) {
        Some(interface) => wan_speed(&state, &interface).await,
        None => None,
    };
    Json(json!({
        "success": true,
        "policy": policy,
        "wan": wan,
        "devices": devices(&hosts, policy.as_ref().map(|p| p.name.as_str())),
    }))
}

#[derive(Deserialize)]
pub struct DevicePolicyReq {
    in_xkeen: bool,
}

fn normalize_mac(mac: &str) -> Option<String> {
    let mac = mac.to_ascii_lowercase();
    let parts: Vec<&str> = mac.split(':').collect();
    (parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())))
    .then_some(mac)
}

/// Same commands as «Применение политик» in the Keenetic web interface.
fn policy_commands(mac: &str, policy: &str, in_xkeen: bool) -> Vec<Value> {
    let command = if in_xkeen {
        format!("ip hotspot host {mac} policy {policy}")
    } else {
        format!("no ip hotspot host {mac} policy")
    };
    vec![json!({"parse": command}), json!({"parse": "system configuration save"})]
}

pub async fn put_device_policy(
    State(state): State<AppState>, headers: HeaderMap, Path(mac): Path<String>, Json(req): Json<DevicePolicyReq>,
) -> Json<Value> {
    if let Err(error) = crate::auth::require_admin(&state, &headers) {
        return Json(json!({"success": false, "error": error}));
    }
    let Some(mac) = normalize_mac(&mac) else {
        return Json(json!({"success": false, "error": "Некорректный MAC-адрес"}));
    };
    let policy = match fetch_rci(&state, "ip/policy").await {
        Ok(policies) => xkeen_policy(&policies),
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    let Some(policy) = policy else {
        return Json(json!({"success": false, "error": "В Keenetic нет политики доступа с описанием «XKeen»"}));
    };
    let hosts = match fetch_rci(&state, "ip/hotspot").await {
        Ok(hosts) => hosts,
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    match devices(&hosts, Some(&policy.name)).into_iter().find(|d| d.mac == mac) {
        None => return Json(json!({"success": false, "error": "Устройство не найдено в списке роутера"})),
        Some(device) if !device.registered => {
            return Json(json!({
                "success": false,
                "error": "Сначала зарегистрируйте устройство в веб-интерфейсе Keenetic",
            }));
        }
        Some(_) => {}
    }
    let result = post_rci_batch(&state, &policy_commands(&mac, &policy.name, req.in_xkeen)).await;
    match result.and_then(|reply| find_batch_error(&reply).map_or(Ok(()), Err)) {
        Ok(()) => {
            let action = if req.in_xkeen {
                "добавлено в"
            } else {
                "исключено из"
            };
            log("INFO", format!("Устройство {mac} {action} политику {}", policy.name));
            get_overview(State(state)).await
        }
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policies() -> Value {
        json!({
            "Policy0": {"description": "Gaming", "route4": {"route": []}},
            "Policy1": {"description": "XKeen", "route4": {"route": [
                {"destination": "46.61.250.142/32", "interface": "PPPoE0"},
                {"destination": "0.0.0.0/0", "interface": "PPPoE0"}
            ]}}
        })
    }

    #[test]
    fn finds_xkeen_policy_and_its_wan() {
        let policies = policies();
        let policy = xkeen_policy(&policies).unwrap();
        assert_eq!(policy.name, "Policy1");
        assert_eq!(policy_wan(&policies, "Policy1").as_deref(), Some("PPPoE0"));
        assert_eq!(xkeen_policy(&json!({"Policy0": {"description": "Other"}})), None);
    }

    #[test]
    fn lists_devices_with_policy_membership() {
        let hosts = json!({"host": [
            {"mac": "aa:aa:aa:aa:aa:01", "name": "aa:aa:aa:aa:aa:01", "hostname": "tv", "ip": "192.168.1.5",
             "active": true, "registered": true, "policy": "", "rxbytes": 10, "txbytes": 900},
            {"mac": "aa:aa:aa:aa:aa:02", "name": "MacBook", "ip": "192.168.1.6",
             "active": false, "registered": true, "policy": "Policy1", "rxbytes": 1, "txbytes": 2},
            {"name": "broken"}
        ]});
        let list = devices(&hosts, Some("Policy1"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "MacBook");
        assert!(list[0].in_xkeen);
        assert_eq!(list[1].name, "tv");
        assert_eq!((list[1].rx_bytes, list[1].tx_bytes), (10, 900));
        assert!(devices(&hosts, None).iter().all(|d| !d.in_xkeen));
    }

    #[test]
    fn merges_entries_of_one_device_behind_a_repeater() {
        let hosts = json!({"host": [
            {"mac": "52:ff:20:05:4c:8e", "name": "52:ff:20:05:4c:8e", "ip": "192.168.1.7", "active": true,
             "registered": true, "policy": "", "rxbytes": 0, "txbytes": 0},
            {"mac": "52:ff:20:05:4c:8e", "name": "52:ff:20:05:4c:8e", "ip": "192.168.1.4", "active": true,
             "registered": true, "policy": "", "rxbytes": 3231439, "txbytes": 731699690},
            {"mac": "52:ff:20:05:4c:8e", "name": "52:ff:20:05:4c:8e", "ip": "192.168.1.5", "active": false,
             "registered": true, "policy": "", "rxbytes": 0, "txbytes": 0}
        ]});
        let list = devices(&hosts, Some("Policy1"));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].ip, "192.168.1.4");
        assert_eq!((list[0].rx_bytes, list[0].tx_bytes), (3231439, 731699690));
        assert!(list[0].active);
    }

    #[test]
    fn device_commands_take_only_valid_macs() {
        assert_eq!(normalize_mac("B6:DC:B6:13:AB:39").as_deref(), Some("b6:dc:b6:13:ab:39"));
        assert_eq!(normalize_mac("b6:dc:b6:13:ab:39 policy x"), None);
        assert_eq!(normalize_mac("b6:dc:b6:13:ab"), None);
        assert_eq!(
            policy_commands("b6:dc:b6:13:ab:39", "Policy1", true)[0],
            json!({"parse": "ip hotspot host b6:dc:b6:13:ab:39 policy Policy1"})
        );
        assert_eq!(
            policy_commands("b6:dc:b6:13:ab:39", "Policy1", false)[0],
            json!({"parse": "no ip hotspot host b6:dc:b6:13:ab:39 policy"})
        );
    }
}
