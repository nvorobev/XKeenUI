use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use nix::sys::resource::{Resource, setrlimit};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Gid, Pid, setgid, setsid};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use tokio::fs;
use tokio::process::Command;

const CORE_NAMES: [&str; 2] = ["xray", "mihomo"];

#[derive(Deserialize)]
pub struct ControlReq {
    action: String,
    #[serde(default)]
    core: String,
}

pub fn find_init_file(log_enabled: bool) -> Option<String> {
    let (mut path, mut source) = (None, "fallback");

    if let Ok(content) = std::fs::read_to_string("/opt/sbin/.xkeen/01_info/01_info_variable.sh") {
        let (mut dir, mut file) = (None, None);
        for line in content.lines() {
            let clean = line.split('#').next().unwrap_or("").trim();
            if let Some(v) = clean.strip_prefix("initd_dir=") {
                dir = Some(v.trim_matches(&['"', '\''][..]));
            } else if let Some(v) = clean.strip_prefix("initd_file=") {
                file = Some(v.trim_matches(&['"', '\''][..]));
            }
        }
        if let (Some(d), Some(f)) = (dir, file) {
            path = Some(f.replace("$initd_dir", d));
            source = "var";
        }
    }

    let final_path = path.or_else(|| {
        [S99XKEEN, S24XRAY]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .map(String::from)
    });

    if log_enabled && let Some(p) = &final_path {
        println!("{} [INFO] Defined initd_file ({}): {}", crate::logger::ts(), source, p);
    }

    final_path
}

async fn resolve_init_file(state: &AppState) -> Result<String, String> {
    if let Some(path) = state
        .init_file
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        && Path::new(&path).exists()
    {
        return Ok(path);
    }
    let new_path = tokio::task::spawn_blocking(|| find_init_file(false))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не найден init файл XKeen".to_string())?;
    println!("{} [INFO] Updated initd_file: {}", crate::logger::ts(), new_path);
    *state
        .init_file
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(new_path.clone());
    Ok(new_path)
}

pub async fn run_init_command(state: &AppState, args: &[&str]) -> Result<(), String> {
    let path = resolve_init_file(state).await?;
    let mut command = Command::new(&path);
    command.args(args);
    match run_service_command(&mut command).await {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{}: {}", path, status)),
        Err(error) => {
            *state
                .init_file
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            Err(format!("{}: {}", path, error))
        }
    }
}

async fn run_service_command(command: &mut Command) -> std::io::Result<std::process::ExitStatus> {
    command.stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(error_log_path())
    {
        if let Ok(stdout) = file.try_clone() {
            command.stdout(stdout);
        }
        command.stderr(file);
    }
    command.status().await
}

fn restart_command() -> Command {
    let mut command = Command::new("xkeen");
    // Modern XKeen self-detaches without a TTY. Await the actual restart before
    // committing or rolling back configuration changes.
    command.arg("-restart").env("XKEEN_FOREGROUND", "1");
    command
}

pub(crate) async fn restart_service(state: &AppState) -> Result<(), String> {
    match run_service_command(&mut restart_command()).await {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("xkeen -restart: {status}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => run_init_command(state, &["restart", "on"]).await,
        Err(error) => Err(format!("xkeen -restart: {error}")),
    }
}

fn get_core_info(name: &str) -> CoreInfo {
    match name {
        "mihomo" => CoreInfo {
            name: "mihomo".into(),
            conf_dir: MIHOMO_CONF_DIR.into(),
            is_json: false,
        },
        _ => CoreInfo {
            name: "xray".into(),
            conf_dir: XRAY_CONF_DIR.into(),
            is_json: true,
        },
    }
}

pub fn get_pid(name: &str) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let pid = path.file_name()?.to_str()?.parse::<i32>().ok()?;
            let comm = std::fs::read_to_string(path.join("comm")).ok()?;
            (comm.trim_end_matches('\n') == name).then_some(pid)
        })
        .collect()
}

fn running_cores() -> HashSet<&'static str> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("comm")).ok())
        .filter_map(|comm| CORE_NAMES.into_iter().find(|name| *name == comm.trim_end()))
        .collect()
}

pub async fn soft_restart(core: &str) -> Result<(), String> {
    for pid in get_pid(core) {
        _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }

    let mut cmd = Command::new(core);
    match core {
        "mihomo" => {
            cmd.env("CLASH_HOME_DIR", MIHOMO_CONF_DIR);
        }
        _ => {
            cmd.arg("run");
            cmd.envs([
                ("XRAY_LOCATION_CONFDIR", XRAY_CONF_DIR),
                ("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR),
            ]);
        }
    }

    let lim = if cfg!(target_arch = "aarch64") { 40000 } else { 10000 };
    unsafe {
        cmd.pre_exec(move || {
            setsid()?;
            setgid(Gid::from_raw(11111))?;
            setrlimit(Resource::RLIMIT_NOFILE, lim, lim)?;
            Ok(())
        });
    }

    if let Ok(f) = std::fs::File::options()
        .append(true)
        .create(true)
        .open(error_log_path())
    {
        if let Ok(stdout) = f.try_clone() {
            cmd.stdout(stdout);
        }
        cmd.stderr(f);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    match child.try_wait() {
        Ok(Some(status)) if !status.success() => {
            return Err(format!("Не удалось перезапустить {}: {}", core, status));
        }
        _ => {
            tokio::spawn(async move {
                _ = child.wait().await;
            });
        }
    }

    Ok(())
}

pub async fn get_control(State(state): State<AppState>) -> impl IntoResponse {
    let running = tokio::task::spawn_blocking(running_cores).await.unwrap_or_default();
    let mut current_core = state
        .core
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();

    if !running.contains(current_core.name.as_str()) {
        let alt_core = if current_core.name == "mihomo" {
            "xray"
        } else {
            "mihomo"
        };

        current_core = if running.contains(alt_core) {
            get_core_info(alt_core)
        } else {
            let path = state
                .init_file
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let configuration = match path {
                Some(path) => fs::read_to_string(path).await.unwrap_or_default(),
                None => String::new(),
            };
            get_core_info(if configuration.contains("name_client=\"mihomo\"") {
                "mihomo"
            } else {
                "xray"
            })
        };
        *state.core.write().unwrap_or_else(std::sync::PoisonError::into_inner) = current_core.clone();
    }

    let mut available_cores = Vec::new();
    for name in CORE_NAMES {
        if fs::metadata(format!("/opt/sbin/{name}")).await.is_ok() {
            available_cores.push(name);
        }
    }
    let running_status = available_cores.iter().any(|name| running.contains(name));

    Json(
        serde_json::json!({ "success": true, "cores": available_cores, "currentCore": current_core.name, "running": running_status }),
    )
}

async fn check_core_config(core: &str) -> Result<(), String> {
    if core == "xray" {
        fs::create_dir_all(XRAY_CONF_DIR).await.ok();
        let has_json = std::fs::read_dir(XRAY_CONF_DIR)
            .map(|dir| dir.flatten().any(|e| e.path().extension().is_some_and(|x| x == "json")))
            .unwrap_or(false);
        if !has_json {
            return Err(
                "Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском".into(),
            );
        }
    }
    if !CORE_NAMES.contains(&core) {
        return Err("Неизвестное ядро".into());
    }
    let mut command = Command::new(core);
    if core == "xray" {
        command
            .args(["run", "-test", "-confdir", XRAY_CONF_DIR])
            .env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);
    } else {
        command.args(["-t", "-d", MIHOMO_CONF_DIR, "-f", &format!("{MIHOMO_CONF_DIR}/config.yaml")]);
    }
    command.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Таймаут проверки конфигурации")?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Err(format!(
            "{core} отклонил конфигурацию: {}",
            detail.chars().take(1200).collect::<String>()
        ));
    }
    Ok(())
}

pub async fn error_log_length() -> usize {
    fs::metadata(error_log_path())
        .await
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0)
}

pub async fn wait_mihomo_ready(start_offset: usize) -> Result<(), String> {
    const MARKER: &[u8] = b"Initial configuration complete";
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        let content = fs::read(error_log_path()).await.unwrap_or_default();
        let fresh = content.get(start_offset..).unwrap_or(&content);
        if fresh
            .windows(MARKER.len())
            .any(|window| window.eq_ignore_ascii_case(MARKER))
        {
            return Ok(());
        }
        if tokio::task::spawn_blocking(|| get_pid("mihomo"))
            .await
            .unwrap_or_default()
            .is_empty()
        {
            return Err("Mihomo завершился при запуске".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    if tokio::task::spawn_blocking(|| get_pid("mihomo"))
        .await
        .unwrap_or_default()
        .is_empty()
    {
        return Err("Mihomo не сообщил о готовности за 15с".into());
    }
    log("WARN", "Маркер готовности не найден, но процесс жив".into());
    Ok(())
}

async fn switch_core(state: &AppState, core: &str) -> Result<(), String> {
    if !CORE_NAMES.contains(&core) {
        return Err("Неизвестное ядро".into());
    }
    let old = state
        .core
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .name
        .clone();
    if old == core {
        return Ok(());
    }
    // Validate while the previous core and its policy/firewall rules still work.
    check_core_config(core).await?;
    let init_file = resolve_init_file(state).await?;
    let original = fs::read_to_string(&init_file)
        .await
        .map_err(|error| error.to_string())?;
    let needle = format!("name_client=\"{old}\"");
    if !original.contains(&needle) {
        return Err("Init-скрипт не поддерживает переключение ядер".into());
    }
    let next = original.replace(&needle, &format!("name_client=\"{core}\""));
    let was_running = !get_pid(&old).is_empty();
    if let Err(error) = run_init_command(state, &["stop"]).await {
        if was_running && let Err(restore) = restart_service(state).await {
            return Err(format!("{error}; не удалось запустить прежнее ядро: {restore}"));
        }
        return Err(error);
    }
    let changed = async {
        crate::fsutil::write_atomic(&init_file, next, 0o755)
            .await
            .map_err(|error| error.to_string())?;
        *state.core.write().unwrap_or_else(std::sync::PoisonError::into_inner) = get_core_info(core);
        if core == "mihomo" {
            _ = fs::write(error_log_path(), b"").await;
        }
        let offset = error_log_length().await;
        run_init_command(state, &["start", "on"]).await?;
        if core == "mihomo" {
            wait_mihomo_ready(offset).await?;
        }
        if get_pid(core).is_empty() {
            return Err(format!("{core} завершился при запуске"));
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = changed {
        _ = run_init_command(state, &["stop"]).await;
        if let Err(restore) = crate::fsutil::write_atomic(&init_file, original, 0o755).await {
            return Err(format!("{error}; не удалось вернуть init-скрипт: {restore}"));
        }
        *state.core.write().unwrap_or_else(std::sync::PoisonError::into_inner) = get_core_info(&old);
        if was_running && let Err(restore) = restart_service(state).await {
            return Err(format!("{error}; не удалось запустить прежнее ядро: {restore}"));
        }
        return Err(format!("{error}; прежнее ядро восстановлено"));
    }
    Ok(())
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<ControlReq>) -> Json<ApiResponse<()>> {
    // A restart can disconnect the HTTP client while firewall rules are being
    // rebuilt. Complete it even after that connection goes away.
    match tokio::spawn(async move { control(state, req).await }).await {
        Ok(reply) => reply,
        Err(error) => Json(ApiResponse {
            success: false,
            error: Some(error.to_string()),
            data: None,
        }),
    }
}

async fn control(state: AppState, req: ControlReq) -> Json<ApiResponse<()>> {
    let _guard = crate::xray_servers::ACTION_LOCK.lock().await;
    match req.action.as_str() {
        "switchCore" => {
            if let Err(error) = switch_core(&state, &req.core).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(error),
                    data: None,
                });
            }
        }
        "softRestart" => {
            if let Err(e) = soft_restart("xray").await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        a if ["start", "stop", "hardRestart"].contains(&a) => {
            let arg = match a {
                "start" => "start",
                "stop" => "stop",
                _ => "restart",
            };

            let cur_name = state
                .core
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .name
                .clone();
            if (a == "start" || a == "hardRestart")
                && let Err(e) = check_core_config(&cur_name).await
            {
                log("ERROR", e);
                return Json(ApiResponse {
                    success: false,
                    error: Some(format!(
                        "Не удалось запустить {}{}",
                        cur_name[..1].to_uppercase(),
                        &cur_name[1..]
                    )),
                    data: None,
                });
            }
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                _ = fs::write(error_log_path(), b"").await;
            }

            let args: &[&str] = match a {
                "start" => &["start", "on"],
                "hardRestart" => &["restart", "on"],
                _ => &[arg],
            };

            let mihomo_boot =
                cur_name == "mihomo" && (a == "hardRestart" || (a == "start" && get_pid("mihomo").is_empty()));
            let boot_log_offset = if mihomo_boot { error_log_length().await } else { 0 };

            let result = if a == "hardRestart" {
                restart_service(&state).await
            } else {
                run_init_command(&state, args).await
            };
            if let Err(e) = result {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }

            if mihomo_boot && let Err(e) = wait_mihomo_ready(boot_log_offset).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        _ => {
            return Json(ApiResponse {
                success: false,
                error: Some("Bad action".into()),
                data: None,
            });
        }
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_uses_native_xkeen_in_foreground() {
        let command = restart_command();
        assert_eq!(command.as_std().get_program(), "xkeen");
        assert_eq!(command.as_std().get_args().collect::<Vec<_>>(), ["-restart"]);
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "XKEEN_FOREGROUND" && value == Some(std::ffi::OsStr::new("1")))
        );
    }
}
