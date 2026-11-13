mod api_relay;
mod auth;
mod backuper;
mod config_history;
mod configs;
mod controller;
mod dns;
mod frontend_embedder;
mod fsutil;
mod geo;
mod healthchecker;
mod jsonc;
mod logger;
mod overview;
mod provider_inspector;
mod resolver;
mod route_test;
mod service_init;
mod settings;
mod system;
mod traffic_guard;
mod types;
mod updater;
mod version;
mod websocket;
mod xray_servers;
use crate::logger::{log, ts};
use crate::types::*;
use axum::http::StatusCode;
use axum::routing::{any, get, post, put};
use axum::{Router, middleware};

use clap::builder::styling::{AnsiColor, Styles};
use clap::{FromArgMatches, Parser, Subcommand};
use colored::Colorize;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::process::exit;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

const STYLES: Styles = Styles::styled()
    .header(AnsiColor::Yellow.on_default().bold())
    .usage(AnsiColor::Yellow.on_default().bold())
    .literal(AnsiColor::Cyan.on_default().bold())
    .placeholder(AnsiColor::Cyan.on_default());

#[derive(Parser)]
#[command(name = "xkeen-ui", before_help = "", about = "Веб-панель управления сервисом XKeen", disable_version_flag = true, disable_help_subcommand = true, styles = STYLES)]
struct Cli {
    #[arg(
        short = 'p',
        long = "port",
        default_value = "1000",
        help = "Запуск сервиса с указанием порта"
    )]
    port: String,

    #[arg(short = 'd', long = "debug", help = "Режим отладки")]
    debug: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Создать init скрипт
    CreateInit,
    /// Запустить сервис (требуется init скрипт)
    Start,
    /// Остановить сервис (требуется init скрипт)
    Stop,
    /// Перезапустить сервис (требуется init скрипт)
    Restart,
    /// Статус сервиса (требуется init скрипт)
    Status,
    /// Сбросить пароль: вход снова admin / admin; работающая панель перезапускается
    ResetPassword,
    /// Задать пароль admin и включить вход: из XKEEN_UI_PASSWORD или первой строки stdin
    SetPassword,
    /// Включить или выключить блокировку трафика мимо прокси
    TrafficGuard {
        #[arg(value_parser = ["on", "off"])]
        state: String,
    },
    /// Запустить установочный скрипт
    Setup,
    /// Отключить управление серверами Xray и вернуть исходные routing/api
    DisableXrayServers,
}

const XKEEN_UI_LOG_C: &[u8] = b"/opt/var/log/xkeen-ui.log\0";

fn cli_fail(message: String) -> ! {
    eprintln!("\n{} {}\n", " Ошибка:".red().bold(), message);
    exit(1);
}

/// Edits the `auth` section of the settings file while the panel may be stopped, drops all
/// sessions and restarts a running panel so it picks the change up.
fn edit_auth_offline(done: &str, edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> ! {
    // A damaged settings file is left as is: rewriting it would drop every setting.
    let mut root = match std::fs::read_to_string(APP_CONFIG) {
        Ok(content) if content.trim().is_empty() => serde_json::Map::new(),
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(serde_json::Value::Object(root)) => root,
            _ => cli_fail(format!("{APP_CONFIG} повреждён, изменение отменено")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => cli_fail(format!("Не удалось прочитать {APP_CONFIG}: {e}")),
    };
    let auth = root.entry("auth").or_insert_with(|| serde_json::json!({}));
    if !auth.is_object() {
        *auth = serde_json::json!({});
    }
    if let Some(auth) = auth.as_object_mut() {
        edit(auth);
        auth.insert("session_ids".into(), serde_json::json!([]));
        auth.insert("session_users".into(), serde_json::json!({}));
    }
    let serialized =
        serde_json::to_string_pretty(&serde_json::Value::Object(root)).unwrap_or_else(|e| cli_fail(e.to_string()));
    if let Some(dir) = Path::new(APP_CONFIG).parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        cli_fail(format!("Не удалось создать {}: {e}", dir.display()));
    }
    if let Err(e) = fsutil::write_atomic_sync(Path::new(APP_CONFIG), serialized.as_bytes(), fsutil::PRIVATE_MODE) {
        cli_fail(format!("Не удалось записать {APP_CONFIG}: {e}"));
    }
    println!("\n{} {done}\n", " Успех:".green().bold());
    let current_pid = std::process::id() as i32;
    let running = controller::get_pid("xkeen-ui")
        .into_iter()
        .any(|pid| pid != current_pid);
    if running && Path::new(S99XKEEN_UI).exists() {
        exec_init("restart");
    }
    exit(0);
}

fn exec_init(cmd: &str) -> ! {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(S99XKEEN_UI).arg(cmd).exec();
    eprintln!("{} {}", " Ошибка выполнения команды:".red().bold(), err);
    exit(1);
}

fn open_process_log() -> io::Result<std::fs::File> {
    if let Some(dir) = Path::new(XKEEN_UI_LOG).parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(XKEEN_UI_LOG)
}

fn setup_process_logging() {
    if let Err(e) = open_process_log() {
        eprintln!("{} {}: {}", " Не удалось открыть лог".red().bold(), XKEEN_UI_LOG, e);
    }

    install_panic_logger();
    install_crash_signal_handlers();

    if !stdio_is_interactive()
        && let Err(e) = redirect_stdio_to_process_log()
    {
        eprintln!(
            "{} {}: {}",
            " Не удалось перенаправить вывод в".red().bold(),
            XKEEN_UI_LOG,
            e
        );
    }
}

fn stdio_is_interactive() -> bool {
    unsafe { nix::libc::isatty(nix::libc::STDOUT_FILENO) == 1 || nix::libc::isatty(nix::libc::STDERR_FILENO) == 1 }
}

fn redirect_stdio_to_process_log() -> io::Result<()> {
    let file = open_process_log()?;
    nix::unistd::dup2_stderr(&file).map_err(io::Error::from)?;
    nix::unistd::dup2_stdout(&file).map_err(io::Error::from)?;
    Ok(())
}

fn write_process_log(level: &str, msg: &str) {
    if let Ok(mut file) = open_process_log() {
        let _ = writeln!(file, "{} [{}] {}", ts(), level, msg);
    }
}

fn report_process_error(msg: &str) -> ! {
    eprintln!("{} [ERROR] {}", ts(), msg);
    if stdio_is_interactive() {
        write_process_log("ERROR", msg);
    }
    exit(1);
}

fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown".into());
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        if let Ok(mut file) = open_process_log() {
            let _ = writeln!(
                file,
                "{} [PANIC] thread={} location={} payload={}",
                ts(),
                thread_name,
                location,
                payload
            );
            let backtrace = std::backtrace::Backtrace::capture();
            if matches!(backtrace.status(), std::backtrace::BacktraceStatus::Captured) {
                let _ = writeln!(file, "Backtrace:\n{}", backtrace);
            }
        }

        default_hook(info);
    }));
}

fn install_crash_signal_handlers() {
    use nix::sys::signal::{SaFlags, SigAction, SigHandler, SigSet, Signal, sigaction};

    let action = SigAction::new(
        SigHandler::Handler(fatal_signal_handler),
        SaFlags::SA_RESETHAND,
        SigSet::empty(),
    );

    for signal in [
        Signal::SIGABRT,
        Signal::SIGBUS,
        Signal::SIGFPE,
        Signal::SIGILL,
        Signal::SIGSEGV,
        Signal::SIGTERM,
    ] {
        unsafe {
            let _ = sigaction(signal, &action);
        }
    }
}

extern "C" fn fatal_signal_handler(sig: i32) {
    let msg = fatal_signal_message(sig);
    unsafe {
        let fd = nix::libc::open(
            XKEEN_UI_LOG_C.as_ptr().cast(),
            nix::libc::O_WRONLY | nix::libc::O_CREAT | nix::libc::O_APPEND,
            0o644,
        );
        if fd >= 0 {
            let _ = nix::libc::write(fd, msg.as_ptr().cast(), msg.len());
            let _ = nix::libc::close(fd);
        }
        let _ = nix::libc::kill(nix::libc::getpid(), sig);
    }
}

fn fatal_signal_message(sig: i32) -> &'static [u8] {
    match sig {
        x if x == nix::libc::SIGABRT => b"[FATAL] received SIGABRT\n",
        x if x == nix::libc::SIGBUS => b"[FATAL] received SIGBUS\n",
        x if x == nix::libc::SIGFPE => b"[FATAL] received SIGFPE\n",
        x if x == nix::libc::SIGILL => b"[FATAL] received SIGILL\n",
        x if x == nix::libc::SIGSEGV => b"[FATAL] received SIGSEGV\n",
        x if x == nix::libc::SIGTERM => b"[INFO] received SIGTERM (service stop)\n",
        _ => b"[FATAL] received fatal signal\n",
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "-v" || arg == "-V" || arg == "--version") {
        let xkeen_config_path = XKEEN_CONF;
        let rci_token = std::fs::read_to_string(xkeen_config_path)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .and_then(|json| json.get("xkeen")?.get("rci_token")?.as_str().map(String::from));

        // Router details are optional: without RCI (or off the router) only the version is printed.
        let router_info = async {
            let client = reqwest::Client::builder()
                .user_agent("XKeen-UI")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .ok()?;
            let mut request = client.get("http://127.0.0.1:79/rci/show/version");
            if let Some(ref token) = rci_token {
                request = request.header("X-Ndma-Tkn", token);
            }
            request.send().await.ok()?.json::<serde_json::Value>().await.ok()
        }
        .await;

        let device = router_info
            .as_ref()
            .and_then(|i| i["description"].as_str())
            .unwrap_or("");
        let os = router_info.as_ref().and_then(|i| i["title"].as_str()).unwrap_or("");

        println!("  {}", format!("XKeen UI {}", VERSION).cyan().bold());
        println!("  {} {}", "Target:".cyan().bold(), env!("BUILD_TARGET"));
        if !device.is_empty() {
            println!("  {} {}", "Device:".cyan().bold(), device);
        }
        if !os.is_empty() {
            println!("  {} {}", "Keenetic OS:".cyan().bold(), os);
        }
        exit(0);
    }

    let version: &'static str = Box::leak(format!("{} ({})", VERSION, get_arch()).into_boxed_str());
    let mut command = <Cli as clap::CommandFactory>::command().version(version);

    if std::env::args().any(|arg| arg == "-h" || arg == "--help") {
        command.print_help().unwrap();
        println!();
        exit(0);
    }
    let matches = command.get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());

    if let Some(command) = cli.command {
        match command {
            Command::Setup => {
                use std::os::unix::process::CommandExt;
                let err = std::process::Command::new("sh")
                    .args([
                        "-c",
                        &format!(
                            "curl -fsSL https://raw.githubusercontent.com/{}/main/setup.sh | sh",
                            UI_REPOSITORY
                        ),
                    ])
                    .exec();
                eprintln!(" {} {}", " Ошибка запуска setup:".red().bold(), err);
                exit(1);
            }
            Command::Start | Command::Stop | Command::Restart | Command::Status => {
                if matches!(command, Command::Start | Command::Restart)
                    && let Err(error) = service_init::ensure(Path::new(S99XKEEN_UI), cli.port.parse().unwrap_or(1000))
                {
                    eprintln!("Не удалось восстановить автозапуск: {error}");
                    exit(1);
                }
                if !Path::new(S99XKEEN_UI).exists() {
                    eprintln!(
                        "\n{} отсутствует init скрипт\n Создайте скрипт командой: {}\n",
                        " Ошибка:".red().bold(),
                        "xkeen-ui create-init".green().bold()
                    );
                    exit(1);
                }
                let cmd = match command {
                    Command::Start => "start",
                    Command::Stop => "stop",
                    Command::Restart => "restart",
                    Command::Status => "status",
                    _ => unreachable!(),
                };
                exec_init(cmd);
            }
            Command::DisableXrayServers => match xray_servers::disable_offline().await {
                Ok(false) => {
                    println!("\n Управление серверами Xray не включено\n");
                    exit(0);
                }
                Ok(true) => {
                    println!("\n{} исходные настройки Xray восстановлены\n", " Успех:".green().bold());
                    if !controller::get_pid("xray").is_empty() {
                        let restarted = controller::find_init_file(false).is_some_and(|init| {
                            std::process::Command::new(init)
                                .arg("restart")
                                .status()
                                .is_ok_and(|status| status.success())
                        });
                        if !restarted {
                            eprintln!(
                                "{} перезапустите XKeen вручную: xkeen -restart",
                                " Внимание:".yellow().bold()
                            );
                            exit(1);
                        }
                    }
                    exit(0);
                }
                Err(error) => {
                    eprintln!("\n{} {}\n", " Ошибка:".red().bold(), error);
                    exit(1);
                }
            },
            Command::CreateInit => {
                if let Err(e) = service_init::create(Path::new(S99XKEEN_UI), cli.port.parse().unwrap_or(1000)) {
                    eprintln!("{} {}: {}", " Не удалось создать".red().bold(), S99XKEEN_UI, e);
                    exit(1);
                }
                println!("\n{} создан {}\n", " Успех:".green().bold(), S99XKEEN_UI);
                exit(0);
            }
            Command::ResetPassword => {
                edit_auth_offline("пароль сброшен", |auth| {
                    auth.remove("password_hash");
                });
            }
            Command::SetPassword => {
                let password = match std::env::var("XKEEN_UI_PASSWORD") {
                    Ok(password) => password,
                    Err(_) => {
                        let mut line = String::new();
                        if let Err(e) = io::stdin().read_line(&mut line) {
                            cli_fail(format!("Не удалось прочитать пароль: {e}"));
                        }
                        line.trim_end_matches(['\r', '\n']).to_string()
                    }
                };
                if password.is_empty() || password.len() > 1024 {
                    cli_fail("Пароль: от 1 до 1024 байт".into());
                }
                let Some(hash) = auth::hash_password(&password) else {
                    cli_fail("Не удалось создать пароль".into());
                };
                edit_auth_offline(
                    "пароль admin задан, вход по паролю включён",
                    |auth| {
                        auth.insert("password_hash".into(), serde_json::json!(hash));
                        auth.insert("enabled".into(), serde_json::json!(true));
                    },
                );
            }
            Command::TrafficGuard { state } => {
                let enabled = state == "on";
                match traffic_guard::set_enabled(enabled).await {
                    Ok(()) => {
                        let text = if enabled {
                            "блокировка трафика мимо прокси включена"
                        } else {
                            "блокировка трафика мимо прокси выключена"
                        };
                        println!("\n{} {text}\n", " Успех:".green().bold());
                        exit(0);
                    }
                    Err(error) => cli_fail(error),
                }
            }
        }
    }

    setup_process_logging();
    write_process_log(
        "INFO",
        &format!(
            "Starting XKeen UI {} pid={} port={}",
            VERSION,
            std::process::id(),
            cli.port
        ),
    );
    if let Ok(port) = cli.port.parse::<u16>() {
        match tokio::task::spawn_blocking(move || service_init::ensure(Path::new(S99XKEEN_UI), port)).await {
            Ok(Ok(true)) => write_process_log("INFO", "Entware startup script created or repaired"),
            Ok(Ok(false)) => {}
            Ok(Err(error)) => write_process_log("ERROR", &format!("Autostart: {error}")),
            Err(error) => write_process_log("ERROR", &format!("Autostart task: {error}")),
        }
    }

    println!("XKeen UI {} ({})", VERSION, get_arch());

    refresh_xray_log_paths();
    let error_log = error_log_path();
    let access_log = access_log_path();

    for path in [&error_log, &access_log] {
        if let Some(p) = Path::new(path).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(path);
    }

    println!(
        "{} [INFO] Defined xray logs: access={}, error={}",
        ts(),
        access_log,
        error_log
    );

    let init_file = tokio::task::spawn_blocking(|| controller::find_init_file(true))
        .await
        .unwrap()
        .or_else(|| {
            log("ERROR", "Не удалось найти файл инициализации XKeen".into());
            None
        });

    let geo_cache = Arc::new(RwLock::new(std::collections::HashMap::new()));
    let gc_clone = geo_cache.clone();
    tokio::task::spawn_blocking(move || {
        let _ = crate::geo::list_geo_files(gc_clone);
    });

    let (log_tx, _) = broadcast::channel::<String>(16);
    let log_tx_arc = Arc::new(log_tx);

    let xkeen_config_path = XKEEN_CONF;
    let rci_token = std::fs::read_to_string(xkeen_config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.get("xkeen")?.get("rci_token")?.as_str().map(String::from));

    let update_session = UpdateSession::new();

    let state = AppState {
        core: Arc::new(RwLock::new(detect_core(init_file.as_deref()))),
        settings: Arc::new(RwLock::new(load_settings())),
        init_file: Arc::new(RwLock::new(init_file)),
        http_client: reqwest::Client::builder()
            .user_agent("XKeen-UI")
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .dns_resolver(Arc::new(resolver::HostResolver { session: None }))
            .build()
            .unwrap(),
        update_client: reqwest::Client::builder()
            .user_agent("XKeen-UI")
            .connect_timeout(std::time::Duration::from_secs(10))
            .dns_resolver(Arc::new(resolver::HostResolver {
                session: Some(update_session.clone()),
            }))
            .build()
            .unwrap(),
        update_checker: UpdateChecker::default(),
        update_session,
        geo_cache,
        log_tx: log_tx_arc,
        log_watcher: Arc::new(tokio::sync::Mutex::new(None)),
        app_config_lock: Arc::new(tokio::sync::Mutex::new(())),
        debug: cli.debug,
        rci_token,
    };

    if let Err(error) = auth::initialize(&state).await {
        report_process_error(&format!("Не удалось подготовить пользователей панели: {error}"));
    }

    if let Some(ref _token) = state.rci_token {
        log("INFO", "RCI токен успешно загружен".into());
    } else {
        match state
            .http_client
            .get("http://127.0.0.1:79/rci/show/version")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(resp) if resp.status() == StatusCode::FORBIDDEN => {
                log(
                    "ERROR",
                    "Ошибка доступа к RCI. Некоторый функционал может быть недоступен.".into(),
                );
            }
            _ => {}
        }
    }

    xray_servers::start(state.clone()).await;
    traffic_guard::refresh_installed().await;
    traffic_guard::start(state.clone());

    let secure_api = Router::new()
        .route(
            "/api/xray/servers",
            get(xray_servers::get_servers)
                .put(xray_servers::put_servers)
                .delete(xray_servers::delete_servers),
        )
        .route("/api/xray/servers/candidates", get(xray_servers::get_candidates))
        .route(
            "/api/xray/servers/library",
            put(xray_servers::put_library_server).delete(xray_servers::delete_library_server),
        )
        .route("/api/xray/servers/select", post(xray_servers::post_select))
        .route("/api/xray/servers/activate", post(xray_servers::post_activate))
        .route("/api/xray/servers/check", post(xray_servers::post_check))
        .route(
            "/api/control",
            get(controller::get_control).post(controller::post_control),
        )
        .route(
            "/api/configs",
            get(configs::get_configs)
                .put(configs::put_config)
                .post(configs::post_config)
                .delete(configs::delete_config)
                .patch(configs::patch_config),
        )
        .route(
            "/api/configs/history",
            get(config_history::get_config_history)
                .put(config_history::put_config_history)
                .delete(config_history::delete_config_history),
        )
        .route(
            "/api/configs/history/diff",
            post(config_history::post_config_history_diff),
        )
        .route(
            "/api/backup",
            get(backuper::get_backups)
                .put(backuper::put_backup)
                .post(backuper::post_backup)
                .patch(backuper::patch_backup)
                .delete(backuper::delete_backup),
        )
        .route(
            "/api/settings",
            get(settings::get_settings).patch(settings::patch_settings),
        )
        .route("/api/version", get(version::version_handler))
        .route("/api/version/check", get(version::check_updates_handler))
        .route("/api/system", get(system::get_system_stats))
        .route("/api/overview", get(overview::get_overview))
        .route("/api/overview/devices/{mac}", put(overview::put_device_policy))
        .route(
            "/api/traffic-guard",
            get(traffic_guard::get_traffic_guard).put(traffic_guard::put_traffic_guard),
        )
        .route(
            "/api/rule-providers",
            get(provider_inspector::get_rule_providers_content).put(provider_inspector::put_rule_providers_content),
        )
        .route(
            "/api/proxy-providers",
            get(provider_inspector::get_proxy_provider_content).put(provider_inspector::put_proxy_provider_content),
        )
        .route(
            "/api/route-test",
            get(route_test::get_route_test_meta).post(route_test::post_route_test),
        )
        .route(
            "/api/healthcheck",
            get(healthchecker::get_healthcheck).post(healthchecker::post_healthcheck),
        )
        .route("/api/healthcheck/all", post(healthchecker::post_healthcheck_all))
        .route("/api/device-list", get(api_relay::get_device_list))
        .route("/api/update", post(updater::post_update))
        .route("/api/update/control", post(updater::post_update_control))
        .route("/api/geo", get(geo::get_geo))
        .route("/api/geo/site", get(geo::get_geosite))
        .route("/api/geo/ip", get(geo::get_geoip))
        .route(
            "/api/dns",
            get(dns::get_dns).post(dns::post_dns).delete(dns::delete_dns),
        )
        .route("/api/users", get(auth::get_users).post(auth::post_user))
        .route(
            "/api/users/{username}",
            axum::routing::patch(auth::patch_user).delete(auth::delete_user),
        )
        .route("/api/auth/logout", post(auth::post_logout))
        .route("/api/auth/reset", post(auth::post_auth_reset))
        .route("/clash/{*path}", any(api_relay::proxy_http))
        .route("/clash-ws/{*path}", get(api_relay::proxy_ws))
        .route("/ws/log", get(websocket::log_ws_handler))
        .route("/ws/updater", get(websocket::update_ws_handler))
        .route_layer(middleware::from_fn({
            let state = state.clone();
            move |req, next| {
                let state = state.clone();
                async move { auth::auth_middleware(state, req, next).await }
            }
        }));

    let insecure_api = Router::new()
        .route("/api/auth/setup", post(auth::post_setup))
        .route("/api/auth/login", get(auth::get_login_info).post(auth::post_login));

    let app = Router::new()
        .merge(secure_api)
        .merge(insecure_api)
        .fallback(frontend_embedder::serve)
        .layer(middleware::from_fn({
            let state = state.clone();
            move |req, next| {
                let state = state.clone();
                async move { auth::request_guard(state, req, next).await }
            }
        }))
        .with_state(state);
    let addr: SocketAddr = format!("0.0.0.0:{}", cli.port)
        .parse()
        .unwrap_or_else(|e| report_process_error(&format!("Error listening on 0.0.0.0:{}: {}", cli.port, e)));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| report_process_error(&format!("Error listening on {}: {}", addr, e)));
    println!("{} [INFO] Listening on {}", ts(), addr);
    write_process_log("INFO", &format!("HTTP listener ready on {addr}"));
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap_or_else(|e| report_process_error(&format!("HTTP server error: {}", e)));
}

fn get_arch() -> String {
    let arch = if std::env::consts::ARCH == "mips" && cfg!(target_endian = "little") {
        "mipsle"
    } else {
        std::env::consts::ARCH
    };
    let libc = if cfg!(target_env = "musl") { "musl" } else { "gnu" };
    format!("{}/{}", arch, libc)
}

fn detect_core(init_file: Option<&str>) -> CoreInfo {
    let content = init_file
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    if content.contains("name_client=\"mihomo\"") {
        CoreInfo {
            name: "mihomo".into(),
            conf_dir: MIHOMO_CONF_DIR.into(),
            is_json: false,
        }
    } else {
        CoreInfo {
            name: "xray".into(),
            conf_dir: XRAY_CONF_DIR.into(),
            is_json: true,
        }
    }
}

fn load_settings() -> AppSettings {
    let (content, path) = match std::fs::read_to_string(APP_CONFIG) {
        Ok(c) => (c, APP_CONFIG),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Ok(c) = std::fs::read_to_string(APP_CONFIG_LEGACY) {
                if let Err(e) = std::fs::create_dir_all(XKEEN_CONF_DIR) {
                    log("WARN", format!("Не удалось создать {}: {}", XKEEN_CONF_DIR, e));
                }
                if std::fs::rename(APP_CONFIG_LEGACY, APP_CONFIG).is_ok() {
                    log(
                        "INFO",
                        format!("Успешная миграция конфига: {} -> {}", APP_CONFIG_LEGACY, APP_CONFIG),
                    );
                } else {
                    log("WARN", "Не удалось выполнить миграцию конфига".into());
                }
                (c, APP_CONFIG_LEGACY)
            } else {
                return AppSettings::default();
            }
        }
        Err(e) => {
            log("ERROR", format!("Ошибка чтения {}: {}", APP_CONFIG, e));
            return AppSettings::default();
        }
    };

    match serde_json::from_str::<AppSettings>(&content) {
        Ok(mut s) => {
            s.normalize_proxies();
            s
        }
        Err(e) => {
            log("ERROR", format!("Ошибка парсинга {}: {}", path, e));
            AppSettings::default()
        }
    }
}
