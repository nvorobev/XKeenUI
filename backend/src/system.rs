use crate::types::AppState;
use axum::extract::State;
use axum::response::Json;
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;

/// Linux USER_HZ: /proc/<pid>/stat starttime is in these ticks (100 on Keenetic/Entware kernels).
const CLOCK_TICKS: f64 = 100.0;

/// Router model/firmware never change at runtime: remember them after the first successful read.
static ROUTER_INFO: Mutex<Option<(String, String)>> = Mutex::new(None);
/// Previous /proc/stat sample (total, idle) for the CPU fallback when RCI is unavailable.
static CPU_SAMPLE: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn memory_value(data: &Value, key: &str) -> Option<u64> {
    data.get(key)?.as_u64().map(|value| value * 1024)
}

async fn rci(state: &AppState, path: &str) -> Option<Value> {
    let mut request = state
        .http_client
        .get(format!("http://127.0.0.1:79/rci/{path}"))
        .timeout(Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        request = request.header("X-Ndma-Tkn", token);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn proc_uptime() -> Option<f64> {
    read("/proc/uptime")?.split_whitespace().next()?.parse().ok()
}

pub(crate) fn core_started_at(name: &str) -> Option<i64> {
    // Health checks also launch short-lived Xray processes. The oldest running
    // process is the service, not one of those disposable probes/API clients.
    let started = crate::controller::get_pid(name)
        .into_iter()
        .filter_map(|pid| {
            let stat = read(&format!("/proc/{pid}/stat"))?;
            stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse::<f64>().ok()
        })
        .reduce(f64::min)?
        / CLOCK_TICKS;
    Some(chrono::Utc::now().timestamp() - (proc_uptime()? - started).max(0.0) as i64)
}

fn proc_memory() -> Option<(u64, u64)> {
    let text = read("/proc/meminfo")?;
    let field = |name: &str| {
        text.lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kb| kb * 1024)
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:").or_else(|| field("MemFree:"))?;
    Some((total.saturating_sub(available), total))
}

/// CPU load from the delta between two /proc/stat samples; `None` on the first call.
fn proc_cpu() -> Option<f64> {
    let line = read("/proc/stat")?.lines().next()?.to_string();
    let values: Vec<u64> = line.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    let total: u64 = values.iter().sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let mut sample = CPU_SAMPLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous = sample.replace((total, idle));
    let (prev_total, prev_idle) = previous?;
    let total_delta = total.checked_sub(prev_total).filter(|v| *v > 0)?;
    let busy_delta = total_delta.saturating_sub(idle.saturating_sub(prev_idle));
    Some((busy_delta as f64 * 100.0 / total_delta as f64).round())
}

/// Resident memory and uptime of the running core process.
fn core_process(name: &str) -> Value {
    let Some(pid) = crate::controller::get_pid(name).first().copied() else {
        return json!({ "name": name, "pid": null });
    };
    let rss = read(&format!("/proc/{pid}/status")).and_then(|text| {
        text.lines()
            .find(|line| line.starts_with("VmRSS:"))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb * 1024)
    });
    // Field 22 (starttime) comes after the parenthesised command name, which may contain spaces.
    let started = read(&format!("/proc/{pid}/stat")).and_then(|text| {
        let rest = text.rsplit_once(')')?.1;
        rest.split_whitespace().nth(19)?.parse::<f64>().ok()
    });
    let uptime = match (proc_uptime(), started) {
        (Some(now), Some(ticks)) => Some((now - ticks / CLOCK_TICKS).max(0.0).round() as u64),
        _ => None,
    };
    json!({ "name": name, "pid": pid, "rssBytes": rss, "uptimeSecs": uptime })
}

fn uptime_value(data: &Value) -> Option<u64> {
    let value = data.get("uptime")?;
    value.as_u64().or_else(|| value.as_str()?.trim().parse().ok())
}

/// Router and core metrics. RCI is preferred; /proc is the fallback, so the endpoint keeps
/// working without RCI access. Unknown values are `null`, never invented.
pub async fn get_system_stats(State(state): State<AppState>) -> Json<Value> {
    let core = state
        .core
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .name
        .clone();
    let system = rci(&state, "show/system").await;

    let cached = ROUTER_INFO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let router = match cached {
        Some(info) => Some(info),
        None => rci(&state, "show/version").await.map(|v| {
            let text = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            let info = (text("description"), text("title"));
            *ROUTER_INFO.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(info.clone());
            info
        }),
    };

    let local = tokio::task::spawn_blocking(move || (proc_memory(), proc_cpu(), proc_uptime(), core_process(&core)))
        .await
        .ok();
    let (proc_mem, proc_cpu_load, proc_up, core_info) = match local {
        Some(values) => values,
        None => (None, None, None, Value::Null),
    };

    let rci_memory = system.as_ref().and_then(|data| {
        let total = memory_value(data, "memtotal")?;
        let used = data
            .get("memory")
            .and_then(Value::as_str)
            .and_then(|value| value.split_once('/'))
            .and_then(|(used, _)| used.parse::<u64>().ok())
            .map(|value| value * 1024)?;
        Some((used, total))
    });
    let (memory_used, memory_total) = match rci_memory.or(proc_mem) {
        Some((used, total)) => (Some(used), Some(total)),
        None => (None, None),
    };
    let cpu = system
        .as_ref()
        .and_then(|data| data.get("cpuload").and_then(Value::as_f64))
        .or(proc_cpu_load);
    let uptime = system.as_ref().and_then(uptime_value).or(proc_up.map(|v| v as u64));
    let hostname = system
        .as_ref()
        .and_then(|data| data.get("hostname").and_then(Value::as_str))
        .map(str::to_owned);
    let (model, firmware) = router.unwrap_or_default();

    Json(json!({
        "success": memory_total.is_some() || cpu.is_some() || uptime.is_some(),
        "source": if system.is_some() { "rci" } else { "proc" },
        "memoryUsed": memory_used,
        "memoryTotal": memory_total,
        "cpuUsage": cpu,
        "uptime": uptime,
        "hostname": hostname,
        "model": (!model.is_empty()).then_some(model),
        "firmware": (!firmware.is_empty()).then_some(firmware),
        "core": core_info,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_accepts_numbers_and_strings() {
        assert_eq!(uptime_value(&json!({"uptime": 42})), Some(42));
        assert_eq!(uptime_value(&json!({"uptime": " 77 "})), Some(77));
        assert_eq!(uptime_value(&json!({})), None);
    }
}
