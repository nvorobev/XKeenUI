use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{ConnectInfo, Path as RoutePath, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::types::{APP_CONFIG, ApiResponse, AppState, AuthSettings, PanelUser};
use std::path::Path;

const SESSION_COOKIE: &str = "session_id";
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;

static BRUTE_CACHE: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
pub struct PasswordReq {
    #[serde(default = "admin_name")]
    username: String,
    password: String,
    #[serde(default)]
    remember: bool,
}

fn admin_name() -> String {
    "admin".into()
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn get_session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| pair.trim().strip_prefix("session_id="))
}

/// Sessions are stored as `uuid:expiry` (older ones as a bare `uuid`); the cookie carries
/// only the uuid. A cookie with `:` is never a session: it would match the stored form and
/// skip both the expiry check and the owner lookup.
fn is_session_valid(session_ids: &[String], cookie: &str) -> bool {
    if cookie.is_empty() || cookie.contains(':') {
        return false;
    }
    let ts = now_ts();
    session_ids.iter().any(|id| match id.split_once(':') {
        Some((uid, exp_str)) => uid == cookie && exp_str.parse::<u64>().unwrap_or(0) > ts,
        None => id == cookie,
    })
}

/// The account behind a valid session. Sessions from before multiple accounts existed
/// (bare uuid, no owner record) belonged to admin; any other unknown session gets no account.
fn session_owner(auth: &AuthSettings, cookie: &str) -> Option<String> {
    if let Some(user) = auth.session_users.get(cookie) {
        return Some(user.clone());
    }
    let legacy = !cookie.contains(':') && auth.session_ids.iter().any(|id| id == cookie);
    legacy.then(admin_name)
}

fn set_cookie_header(headers_in: &HeaderMap, value: String, max_age: u64) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let secure = if headers_in.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https") {
        "Secure; "
    } else {
        ""
    };
    let cookie = if max_age > 0 {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/; Max-Age={}",
            SESSION_COOKIE, value, secure, max_age
        )
    } else {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/",
            SESSION_COOKIE, value, secure
        )
    };
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.insert(header::SET_COOKIE, value);
    }
    headers
}

fn clear_cookie_header() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("session_id=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    headers
}

pub async fn get_login_info(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let s = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    let authenticated =
        get_session_cookie(&headers).is_some_and(|cookie| is_session_valid(&s.auth.session_ids, cookie));
    Json(serde_json::json!({
        "enabled": s.auth.enabled,
        "has_password": s.auth.password_hash.is_some(),
        "authenticated": authenticated,
        "username": get_session_cookie(&headers).filter(|_| authenticated).and_then(|cookie| session_owner(&s.auth, cookie))
    }))
}

pub async fn post_setup(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<PasswordReq>,
) -> impl IntoResponse {
    if state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .password_hash
        .is_some()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiResponse::<()> {
                success: false,
                error: Some("Password already set".into()),
                data: None,
            }),
        )
            .into_response();
    }

    if !req.username.trim().eq_ignore_ascii_case("admin") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Первой настраивается учётная запись admin"})),
        )
            .into_response();
    }
    let hash = match password_hash(req.password).await {
        Ok(hash) => hash,
        Err(error) => return auth_error(error),
    };
    let session_id = Uuid::new_v4().to_string();
    let ttl = 86400;
    let session_val = format!("{}:{}", session_id, now_ts() + ttl);

    if let Err(error) = mutate_auth(&state, |auth| {
        if auth.password_hash.is_some() {
            return Err("Пароль уже установлен".into());
        }
        auth.password_hash = Some(hash);
        auth.session_ids.push(session_val);
        auth.session_users.insert(session_id.clone(), admin_name());
        Ok(())
    })
    .await
    {
        return auth_error(error);
    }

    (
        set_cookie_header(&headers, session_id, 0),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_login(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    let ip = addr.ip().to_string();
    let username = req.username.trim().to_ascii_lowercase();
    // Per address and account: behind a proxy (KeenDNS) every client shares one address,
    // and wrong passwords for one account must not lock out the others.
    let attempts_key = format!("{ip}|{}", username.chars().take(64).collect::<String>());
    {
        let mut cache = BRUTE_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(LOCKOUT_SECS * 2));
        let entry = cache.entry(attempts_key.clone()).or_insert((0, Instant::now()));
        if entry.1.elapsed() > Duration::from_secs(LOCKOUT_SECS) {
            entry.0 = 0;
        }
        if entry.0 >= MAX_ATTEMPTS {
            println!("{} [WARN] Authorization blocked [{}]", crate::logger::ts(), ip);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ApiResponse::<()> {
                    success: false,
                    error: Some(format!(
                        "Слишком много попыток. Повторите через {} секунд",
                        LOCKOUT_SECS
                    )),
                    data: None,
                }),
            )
                .into_response();
        }
    }

    let (hash, known_user) = {
        let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        let user_hash = user_hash(&settings.auth, &username);
        (
            user_hash.or(settings.auth.password_hash.as_deref()).map(str::to_owned),
            user_hash.is_some(),
        )
    };
    let Some(hash) = hash else {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"success": false, "error": "Пароль не задан"})),
        )
            .into_response();
    };
    if req.password.is_empty() || req.password.len() > 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Пароль: от 1 до 1024 байт"})),
        )
            .into_response();
    }
    let verified_hash = hash.clone();

    let password = req.password;
    let is_valid = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false);

    if !is_valid || !known_user {
        let mut cache = BRUTE_CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = cache.entry(attempts_key.clone()).or_insert((0, Instant::now()));
        entry.0 += 1;
        entry.1 = Instant::now();
        println!(
            "{} [WARN] Incorrect password attempt [{}] ({}/{})",
            crate::logger::ts(),
            ip,
            entry.0,
            MAX_ATTEMPTS
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse::<()> {
                success: false,
                error: Some("Неверный логин или пароль".into()),
                data: None,
            }),
        )
            .into_response();
    }

    BRUTE_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&attempts_key);
    println!("{} [INFO] Successful auth {}", crate::logger::ts(), ip);

    let max_age = if req.remember { 2592000 } else { 0 };
    let backend_ttl = if req.remember { 2592000 } else { 86400 };

    let session_id = Uuid::new_v4().to_string();
    let session_val = format!("{}:{}", session_id, now_ts() + backend_ttl);

    if let Err(error) = mutate_auth(&state, |auth| {
        if user_hash(auth, &username) != Some(verified_hash.as_str()) {
            return Err("Учётная запись изменена; войдите повторно".into());
        }
        auth.session_ids.push(session_val);
        auth.session_users.insert(session_id.clone(), username);
        Ok(())
    })
    .await
    {
        return auth_error(error);
    }

    (
        set_cookie_header(&headers, session_id, max_age),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(cookie) = get_session_cookie(&headers) {
        let cookie = cookie.to_string();
        if let Err(error) = update_auth(&state, |auth| {
            auth.session_ids.retain(|id| !id.starts_with(&cookie) && id != &cookie);
            auth.session_users.remove(&cookie);
        })
        .await
        {
            return auth_error(error);
        }
    }
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_auth_reset(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(error) = require_admin(&state, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"success": false, "error": error})),
        )
            .into_response();
    }
    if let Err(error) = update_auth(&state, |auth| {
        auth.password_hash = None;
        auth.session_ids.clear();
        auth.session_users.clear();
    })
    .await
    {
        return auth_error(error);
    }
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

fn forbidden(message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({"success": false, "error": message})),
    )
        .into_response()
}

/// Host names that cannot be pointed at this router by someone else's DNS (rebinding).
fn is_local_host(host: &str) -> bool {
    let name = host
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()) && !host.ends_with(']'))
        .map_or(host, |(name, _)| name)
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    name.parse::<std::net::IpAddr>().is_ok()
        || name == "localhost"
        || !name.contains('.')
        || [".local", ".lan", ".home.arpa", ".internal"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

/// Rejects requests that other web sites make from the user's browser.
/// The panel and its API are always one origin and never need cross-origin calls.
/// Fetch Metadata (`Sec-Fetch-Site`) is used first because it survives reverse proxies such as
/// KeenDNS that rewrite `Host`; browsers without it fall back to comparing `Origin`.
fn is_cross_site(headers: &HeaderMap, method: &axum::http::Method) -> bool {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(site) = header("sec-fetch-site") {
        // Opening the panel from a link or bookmark is a navigation, not an API call.
        let navigation = header("sec-fetch-mode") == Some("navigate") && method == axum::http::Method::GET;
        return !matches!(site, "same-origin" | "none") && !navigation;
    }
    let Some(origin) = header("origin") else {
        return false;
    };
    let authority = origin.split_once("://").map(|(_, authority)| authority);
    authority.is_none()
        || ![header("host"), header("x-forwarded-host")]
            .into_iter()
            .flatten()
            .any(|host| Some(host) == authority)
}

pub async fn request_guard(state: AppState, request: Request, next: Next) -> Response {
    if is_cross_site(request.headers(), request.method()) {
        return forbidden("Запрос со стороннего сайта отклонён");
    }
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let auth_enabled = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .enabled;
    // DNS rebinding: without login, only names that cannot be someone else's domain.
    if !auth_enabled && !host.is_empty() && !is_local_host(host) {
        return forbidden("Доступ по доменному имени возможен только с включённым входом по паролю");
    }
    next.run(request).await
}

pub async fn auth_middleware(state: AppState, request: Request, next: Next) -> Response {
    let enabled = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .enabled;
    if !enabled {
        return next.run(request).await;
    }
    let session_ids = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .session_ids
        .clone();
    if session_ids.is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let is_valid = get_session_cookie(request.headers()).is_some_and(|c| is_session_valid(&session_ids, c));
    if !is_valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    next.run(request).await
}

pub(crate) fn hash_password(password: &str) -> Option<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .ok()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

fn auth_error(error: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiResponse::<()> {
            success: false,
            error: Some(format!("Не удалось сохранить настройки входа: {error}")),
            data: None,
        }),
    )
        .into_response()
}

async fn update_auth(state: &AppState, modify: impl FnOnce(&mut AuthSettings)) -> Result<(), String> {
    mutate_auth(state, |auth| {
        modify(auth);
        Ok(())
    })
    .await
}

async fn mutate_auth(
    state: &AppState, modify: impl FnOnce(&mut AuthSettings) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = state.app_config_lock.lock().await;
    let mut auth = state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .clone();
    modify(&mut auth)?;
    let ts = now_ts();
    auth.session_ids.retain(|id| {
        id.split_once(':')
            .is_none_or(|(_, exp)| exp.parse::<u64>().unwrap_or(0) > ts)
    });
    auth.session_users.retain(|session, _| {
        auth.session_ids
            .iter()
            .any(|id| id.split(':').next() == Some(session.as_str()))
    });
    save_auth_to_config(Path::new(APP_CONFIG), &auth).await?;
    state
        .settings
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth = auth;
    Ok(())
}

async fn save_auth_to_config(path: &Path, auth: &AuthSettings) -> Result<(), String> {
    let mut file_json = crate::settings::read_config(path).await?;
    file_json["auth"] = serde_json::to_value(auth).map_err(|e| e.to_string())?;
    crate::settings::write_config(path, &file_json).await
}

fn user_hash<'a>(auth: &'a AuthSettings, username: &str) -> Option<&'a str> {
    if username == "admin" {
        auth.password_hash.as_deref()
    } else {
        auth.users
            .iter()
            .find(|user| user.username == username)
            .map(|user| user.password_hash.as_str())
    }
}

fn revoke_user_sessions(auth: &mut AuthSettings, username: &str) {
    let revoked: Vec<_> = auth
        .session_ids
        .iter()
        .filter_map(|id| {
            let session = id.split(':').next().unwrap_or(id);
            let owner = auth.session_users.get(session).map(String::as_str).unwrap_or("admin");
            (owner == username).then(|| session.to_owned())
        })
        .collect();
    auth.session_ids.retain(|id| {
        !revoked
            .iter()
            .any(|session| id.split(':').next() == Some(session.as_str()))
    });
    auth.session_users.retain(|session, _| !revoked.contains(session));
}

pub async fn initialize(state: &AppState) -> Result<(), String> {
    if state
        .settings
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .auth
        .password_hash
        .is_some()
    {
        return Ok(());
    }
    let hash = tokio::task::spawn_blocking(|| hash_password("admin"))
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Не удалось создать пароль admin")?;
    mutate_auth(state, |auth| {
        if auth.password_hash.is_none() {
            auth.password_hash = Some(hash);
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
pub struct UserRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
pub struct UserChange {
    username: Option<String>,
    password: Option<String>,
}

fn normalize_username(username: &str) -> Result<String, String> {
    let username = username.trim().to_ascii_lowercase();
    if username.is_empty()
        || username.len() > 32
        || !username
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
    {
        return Err("Логин: 1–32 символа, латинские буквы, цифры, _, - или точка".into());
    }
    Ok(username)
}

async fn password_hash(password: String) -> Result<String, String> {
    if password.is_empty() || password.len() > 1024 {
        return Err("Пароль: от 1 до 1024 байт".into());
    }
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Не удалось создать пароль".into())
}

fn users_reply(result: Result<(), String>) -> Json<serde_json::Value> {
    match result {
        Ok(()) => Json(serde_json::json!({"success": true})),
        Err(error) => Json(serde_json::json!({"success": false, "error": error})),
    }
}

pub async fn get_users(State(state): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Who is shown as signed in; rights are checked separately by `acting_user`.
    let current = get_session_cookie(&headers)
        .and_then(|session| session_owner(&settings.auth, session))
        .unwrap_or_else(admin_name);
    let mut users = vec![serde_json::json!({"username": "admin", "protected": true})];
    users.extend(
        settings
            .auth
            .users
            .iter()
            .map(|user| serde_json::json!({"username": user.username, "protected": false})),
    );
    Json(serde_json::json!({"success": true, "users": users, "current_user": current}))
}

/// Who performs the request. Without login everyone acts as the administrator;
/// sessions created before named users existed belong to `admin`.
pub(crate) fn acting_user(state: &AppState, headers: &HeaderMap) -> String {
    let settings = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !settings.auth.enabled {
        return admin_name();
    }
    get_session_cookie(headers)
        .and_then(|session| session_owner(&settings.auth, session))
        .unwrap_or_default()
}

pub(crate) fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), String> {
    if acting_user(state, headers) == "admin" {
        Ok(())
    } else {
        Err("Это действие доступно только администратору (admin)".into())
    }
}

pub async fn post_user(
    State(state): State<AppState>, headers: HeaderMap, Json(request): Json<UserRequest>,
) -> Json<serde_json::Value> {
    users_reply(
        async {
            require_admin(&state, &headers)?;
            let username = normalize_username(&request.username)?;
            let hash = password_hash(request.password).await?;
            mutate_auth(&state, |auth| {
                if username == "admin" || auth.users.iter().any(|user| user.username == username) {
                    return Err("Такой пользователь уже существует".into());
                }
                if auth.users.len() >= 31 {
                    return Err("Допускается не больше 32 пользователей".into());
                }
                auth.users.push(PanelUser {
                    username,
                    password_hash: hash,
                });
                Ok(())
            })
            .await
        }
        .await,
    )
}

pub async fn patch_user(
    State(state): State<AppState>, headers: HeaderMap, RoutePath(username): RoutePath<String>,
    Json(request): Json<UserChange>,
) -> Json<serde_json::Value> {
    users_reply(
        async {
            let username = normalize_username(&username)?;
            if request.username.is_none() && request.password.is_none() {
                return Err("Не указаны изменения пользователя".into());
            }
            // Users may change only their own password; everything else is for admin.
            let actor = acting_user(&state, &headers);
            if actor != "admin" && (actor != username || request.username.is_some()) {
                return Err("Можно изменить только свой пароль; остальное доступно администратору (admin)".into());
            }
            let renamed = request.username.as_deref().map(normalize_username).transpose()?;
            if username == "admin" && renamed.as_deref().is_some_and(|name| name != "admin") {
                return Err("Пользователя admin нельзя переименовать".into());
            }
            let hash = match request.password {
                Some(password) => Some(password_hash(password).await?),
                None => None,
            };
            if username == "admin" && hash.is_none() {
                return Err("У admin можно изменить только пароль".into());
            }
            mutate_auth(&state, |auth| {
                if renamed.as_deref().is_some_and(|name| {
                    name != username && (name == "admin" || auth.users.iter().any(|user| user.username == name))
                }) {
                    return Err("Такой пользователь уже существует".into());
                }
                if username == "admin" {
                    if let Some(hash) = hash {
                        auth.password_hash = Some(hash);
                    }
                } else {
                    let user = auth
                        .users
                        .iter_mut()
                        .find(|user| user.username == username)
                        .ok_or("Пользователь не найден")?;
                    if let Some(name) = renamed {
                        user.username = name;
                    }
                    if let Some(hash) = hash {
                        user.password_hash = hash;
                    }
                }
                revoke_user_sessions(auth, &username);
                Ok(())
            })
            .await
        }
        .await,
    )
}

pub async fn delete_user(
    State(state): State<AppState>, headers: HeaderMap, RoutePath(username): RoutePath<String>,
) -> Json<serde_json::Value> {
    users_reply(
        async {
            require_admin(&state, &headers)?;
            let username = normalize_username(&username)?;
            if username == "admin" {
                return Err("Пользователя admin нельзя удалить".into());
            }
            mutate_auth(&state, |auth| {
                if !auth.users.iter().any(|user| user.username == username) {
                    return Err("Пользователь не найден".into());
                }
                auth.users.retain(|user| user.username != username);
                revoke_user_sessions(auth, &username);
                Ok(())
            })
            .await
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_site_requests_are_detected() {
        let get = axum::http::Method::GET;
        let post = axum::http::Method::POST;
        let headers = |pairs: &[(&'static str, &'static str)]| {
            let mut map = HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, HeaderValue::from_static(value));
            }
            map
        };
        assert!(!is_cross_site(&headers(&[("sec-fetch-site", "same-origin")]), &post));
        assert!(is_cross_site(&headers(&[("sec-fetch-site", "cross-site")]), &post));
        assert!(is_cross_site(&headers(&[("sec-fetch-site", "same-site")]), &post));
        assert!(!is_cross_site(
            &headers(&[("sec-fetch-site", "cross-site"), ("sec-fetch-mode", "navigate")]),
            &get
        ));
        assert!(!is_cross_site(
            &headers(&[("origin", "http://10.0.0.1:1000"), ("host", "10.0.0.1:1000")]),
            &post
        ));
        assert!(is_cross_site(
            &headers(&[("origin", "https://evil.example"), ("host", "10.0.0.1:1000")]),
            &post
        ));
        assert!(is_cross_site(
            &headers(&[("origin", "null"), ("host", "10.0.0.1:1000")]),
            &post
        ));
        assert!(!is_cross_site(&headers(&[]), &post));
    }

    #[test]
    fn stored_session_form_is_not_a_cookie() {
        let future = now_ts() + 3600;
        let ids = vec![format!("u1:{future}"), "legacy".to_string(), format!("old:{}", now_ts() - 1)];
        assert!(is_session_valid(&ids, "u1"));
        assert!(!is_session_valid(&ids, &format!("u1:{future}")));
        assert!(is_session_valid(&ids, "legacy"));
        assert!(!is_session_valid(&ids, "old"));
        assert!(!is_session_valid(&ids, ""));

        let mut auth = AuthSettings {
            session_ids: ids,
            ..AuthSettings::default()
        };
        auth.session_users.insert("u1".into(), "bob".into());
        assert_eq!(session_owner(&auth, "u1").as_deref(), Some("bob"));
        assert_eq!(session_owner(&auth, "legacy").as_deref(), Some("admin"));
        assert_eq!(session_owner(&auth, &format!("u1:{future}")), None);
        assert_eq!(session_owner(&auth, "unknown"), None);
    }

    #[test]
    fn local_hosts_are_recognized() {
        for host in [
            "192.168.1.1:1000",
            "[fe80::1]:1000",
            "localhost:1000",
            "router:1000",
            "my.keenetic.local",
            "10.0.0.1",
        ] {
            assert!(is_local_host(host), "{host}");
        }
        for host in ["evil.example.com", "evil.example.com:1000", "router.keenetic.pro:1000"] {
            assert!(!is_local_host(host), "{host}");
        }
    }

    #[test]
    fn usernames_are_canonical_and_bounded() {
        assert_eq!(normalize_username(" Alice-1 ").unwrap(), "alice-1");
        assert!(normalize_username("").is_err());
        assert!(normalize_username("bad/name").is_err());
        assert!(normalize_username(&"a".repeat(33)).is_err());
    }

    #[test]
    fn revoking_a_user_keeps_other_sessions_and_legacy_admin_sessions() {
        let mut auth = AuthSettings {
            session_ids: vec![
                "legacy:9999999999".into(),
                "alice-session:9999999999".into(),
                "bob-session:9999999999".into(),
            ],
            ..AuthSettings::default()
        };
        auth.session_users.insert("alice-session".into(), "alice".into());
        auth.session_users.insert("bob-session".into(), "bob".into());
        revoke_user_sessions(&mut auth, "alice");
        assert!(is_session_valid(&auth.session_ids, "legacy"));
        assert!(is_session_valid(&auth.session_ids, "bob-session"));
        assert!(!is_session_valid(&auth.session_ids, "alice-session"));
        assert!(!auth.session_users.contains_key("alice-session"));
        revoke_user_sessions(&mut auth, "admin");
        assert!(!is_session_valid(&auth.session_ids, "legacy"));
        assert!(is_session_valid(&auth.session_ids, "bob-session"));
    }

    #[tokio::test]
    async fn password_reset_is_persisted_without_losing_other_settings() {
        let dir = std::env::temp_dir().join(format!("xkeen-auth-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("settings.json");
        tokio::fs::write(
            &path,
            r#"{"gui":{"routing":true},"auth":{"enabled":true,"password_hash":"old","session_ids":["old-session"]}}"#,
        )
        .await
        .unwrap();
        let auth = AuthSettings {
            enabled: true,
            ..AuthSettings::default()
        };
        save_auth_to_config(&path, &auth).await.unwrap();
        let saved: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(saved["gui"]["routing"], true);
        assert_eq!(saved["auth"]["enabled"], true);
        assert!(saved["auth"]["password_hash"].is_null());
        assert_eq!(saved["auth"]["session_ids"], serde_json::json!([]));
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn auth_save_reports_storage_errors_and_preserves_invalid_config() {
        let dir = std::env::temp_dir().join(format!("xkeen-auth-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("settings.json");
        tokio::fs::write(&path, "invalid").await.unwrap();
        assert!(save_auth_to_config(&path, &AuthSettings::default()).await.is_err());
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "invalid");
        assert!(
            save_auth_to_config(&path.join("blocked.json"), &AuthSettings::default())
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
