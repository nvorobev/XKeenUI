use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{MatchedPath, State};
use axum::http::{HeaderName, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use std::pin::Pin;
use std::time::Duration;
use tokio::net::UnixStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Error as TError, Message as TMessage};
use tokio_tungstenite::{client_async, connect_async};

use crate::logger::log;
use crate::types::{ApiResponse, AppState, MIHOMO_CONF_DIR};

#[derive(Clone)]
pub(crate) enum ClashTarget {
    Tcp {
        host: String,
        port: String,
        secret: Option<String>,
    },
    Unix {
        path: String,
    },
}

pub async fn get_device_list(State(state): State<AppState>) -> impl IntoResponse {
    let mut req = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/device-list")
        .timeout(Duration::from_secs(5));
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }
    let response = match req.send().await {
        Ok(response) => response,
        Err(e) => return Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    };

    if !response.status().is_success() {
        return Json(serde_json::json!({
            "success": false,
            "error": format!("Ошибка RCI: {}", response.status()),
        }));
    }

    match response.json::<serde_json::Value>().await {
        Ok(data) => Json(serde_json::json!({
            "success": true,
            "host": data.get("host").cloned().unwrap_or_else(|| serde_json::json!([])),
        })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

fn raw_relay_path(matched_path: &str, request_path: &str) -> String {
    let prefix_len = matched_path.split("{*").next().unwrap_or("").len();
    request_path[prefix_len.min(request_path.len())..]
        .trim_start_matches('/')
        .to_string()
}

/// The config is editable by regular users. Even a controller accidentally pointed at
/// another local service must never turn this relay into access to RCI or panel APIs.
fn allowed_relay_path(path: &str) -> bool {
    let mut decoded = path.to_string();
    for _ in 0..4 {
        if decoded.split('/').any(|s| matches!(s, "." | ".."))
            || decoded.chars().any(char::is_control)
            || decoded.contains('\\')
        {
            return false;
        }
        let Ok(next) = urlencoding::decode(&decoded) else {
            return false;
        };
        if next == decoded {
            break;
        }
        decoded = next.into_owned();
    }
    if decoded.split('/').any(|s| matches!(s, "." | ".."))
        || decoded.chars().any(char::is_control)
        || decoded.contains('\\')
    {
        return false;
    }
    matches!(
        decoded.trim_start_matches('/').split('/').next().unwrap_or_default(),
        "configs"
            | "proxies"
            | "group"
            | "rules"
            | "connections"
            | "providers"
            | "cache"
            | "dns"
            | "logs"
            | "traffic"
            | "memory"
            | "version"
    )
}

pub async fn proxy_http(State(state): State<AppState>, matched_path: MatchedPath, req: Request<Body>) -> Response {
    let path = raw_relay_path(matched_path.as_str(), req.uri().path());
    if !allowed_relay_path(&path) {
        return make_error(StatusCode::FORBIDDEN, "Разрешены только пути API Mihomo".into());
    }
    let (parts, body) = req.into_parts();

    let target = match resolve_clash_target().await {
        Ok(t) => t,
        Err(e) => return make_error(StatusCode::BAD_GATEWAY, e),
    };

    const CLASH_BODY_LIMIT: usize = 16 * 1024 * 1024;
    let body_bytes = match to_bytes(body, CLASH_BODY_LIMIT).await {
        Ok(b) => b,
        Err(e) => return make_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };

    match target {
        ClashTarget::Tcp { host, port, secret } => {
            let url = build_url("http", &host, &port, &path, parts.uri.query());
            do_proxy_http(state.http_client.clone(), parts, body_bytes, url, secret).await
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("http", "127.0.0.1", "80", &path, parts.uri.query());
            let client = match reqwest::Client::builder()
                .unix_socket(socket_path)
                .user_agent("XKeen-UI")
                .timeout(Duration::from_secs(120))
                .build()
            {
                Ok(c) => c,
                Err(e) => return make_error(StatusCode::BAD_GATEWAY, e.to_string()),
            };
            do_proxy_http(client, parts, body_bytes, url, None).await
        }
    }
}

pub async fn proxy_ws(matched_path: MatchedPath, ws: WebSocketUpgrade, req: Request<Body>) -> impl IntoResponse {
    let path = raw_relay_path(matched_path.as_str(), req.uri().path());
    if !allowed_relay_path(&path) {
        return make_error(StatusCode::FORBIDDEN, "Разрешены только пути API Mihomo".into());
    }
    let target = match resolve_clash_target().await {
        Ok(t) => t,
        Err(e) => return make_error(StatusCode::BAD_REQUEST, e),
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = proxy_ws_inner(socket, path, target).await {
            eprintln!("Clash WS proxy error: {}", e);
        }
    })
}

async fn proxy_ws_inner(client_ws: WebSocket, path: String, target: ClashTarget) -> Result<(), String> {
    type UpstreamSink = Pin<Box<dyn Sink<TMessage, Error = TError> + Send>>;
    type UpstreamStream = Pin<Box<dyn Stream<Item = Result<TMessage, TError>> + Send>>;

    let (mut upstream_tx, mut upstream_rx): (UpstreamSink, UpstreamStream) = match target {
        ClashTarget::Tcp { host, port, secret } => {
            let mut url = build_url("ws", &host, &port, &path, None);
            if let Some(secret) = secret {
                url.push_str(&format!("?token={}", urlencoding::encode(&secret)));
            }
            let (ws, _) = timeout(Duration::from_secs(5), connect_async(url))
                .await
                .map_err(|_| "Upstream connect timeout".to_string())?
                .map_err(|e| e.to_string())?;
            let (tx, rx) = ws.split();
            (Box::pin(tx), Box::pin(rx))
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("ws", "127.0.0.1", "80", &path, None);
            let (ws, _) = timeout(Duration::from_secs(5), async {
                let stream = UnixStream::connect(socket_path).await?;
                client_async(url, stream)
                    .await
                    .map_err(|e| std::io::Error::other(e.to_string()))
            })
            .await
            .map_err(|_| "Upstream connect timeout".to_string())?
            .map_err(|e| e.to_string())?;
            let (tx, rx) = ws.split();
            (Box::pin(tx), Box::pin(rx))
        }
    };

    let (mut client_tx, mut client_rx) = client_ws.split();

    let client_to_upstream = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let t_msg = match msg {
                Message::Text(t) => TMessage::Text(t.to_string().into()),
                Message::Binary(b) => TMessage::Binary(b),
                Message::Ping(p) => TMessage::Ping(p),
                Message::Pong(p) => TMessage::Pong(p),
                Message::Close(_) => {
                    let _ = upstream_tx.send(TMessage::Close(None)).await;
                    break;
                }
            };
            if upstream_tx.send(t_msg).await.is_err() {
                break;
            }
        }
    };

    let upstream_to_client = async {
        while let Some(Ok(msg)) = upstream_rx.next().await {
            let a_msg = match msg {
                TMessage::Text(t) => Message::Text(t.to_string().into()),
                TMessage::Binary(b) => Message::Binary(b),
                TMessage::Ping(p) => Message::Ping(p),
                TMessage::Pong(p) => Message::Pong(p),
                TMessage::Close(_) => {
                    let _ = client_tx.send(Message::Close(None)).await;
                    break;
                }
                _ => continue,
            };
            if client_tx.send(a_msg).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
    }

    Ok(())
}

fn should_forward_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    !matches!(
        n,
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-protocol"
            | "content-length"
            | "x-clash-port"
            | "x-clash-secret"
            | "x-clash-unix"
            | "authorization"
            // The panel session must not reach Mihomo (or whatever listens on its port).
            | "cookie"
            | "x-ndma-tkn"
    )
}

fn should_forward_response_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    !matches!(
        n,
        "connection"
            | "upgrade"
            | "sec-websocket-accept"
            | "sec-websocket-protocol"
            | "transfer-encoding"
            | "content-length"
    )
}

fn make_error(status: StatusCode, err: String) -> Response {
    (
        status,
        axum::Json(ApiResponse::<()> {
            success: false,
            error: Some(err),
            data: None,
        }),
    )
        .into_response()
}

async fn do_proxy_http(
    client: reqwest::Client, parts: http::request::Parts, body_bytes: axum::body::Bytes, url: String,
    secret: Option<String>,
) -> Response {
    let mut builder = client.request(parts.method.clone(), url);
    for (name, value) in parts.headers.iter() {
        if should_forward_header(name) {
            builder = builder.header(name, value);
        }
    }
    if let Some(secret) = secret {
        builder = builder.header("Authorization", format!("Bearer {}", secret));
    }

    match builder.body(body_bytes).send().await {
        Ok(upstream) => build_http_response(upstream).await,
        Err(e) => make_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn build_http_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = upstream.bytes().await.unwrap_or_default();

    if !status.is_success() {
        let body_text = String::from_utf8_lossy(&bytes);
        let detail = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| body_text.trim().to_string());

        let skip = detail.contains("Timeout") || detail.contains("An error occurred in the delay test");
        if !skip {
            log("ERROR", format!("Ошибка Mihomo: {}", detail));
        }
    }

    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter() {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Where the Clash API of the running Mihomo listens, taken from its own config on disk. The
/// browser never chooses the address: a client-supplied port could point the relay (and the
/// session it carries) at any local service, such as the router's RCI on :79.
pub(crate) async fn resolve_clash_target() -> Result<ClashTarget, String> {
    let main_config = format!("{MIHOMO_CONF_DIR}/config.yaml");
    let yaml = tokio::fs::read_to_string(&main_config)
        .await
        .map_err(|e| format!("Не удалось прочитать {main_config}: {e}"))?;
    clash_target_from_config(&yaml).await
}

async fn clash_target_from_config(yaml: &str) -> Result<ClashTarget, String> {
    let creds = crate::configs::parse_mihomo_api_creds(yaml);
    if let Some(path) = creds.unix_path {
        use std::os::unix::fs::FileTypeExt;
        return match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.file_type().is_socket() => Ok(ClashTarget::Unix { path }),
            Ok(_) => Err(format!("{path} не является сокетом")),
            Err(_) => Err("Unix сокет не найден на диске".into()),
        };
    }
    match creds.port {
        Some(port) => Ok(ClashTarget::Tcp {
            host: "127.0.0.1".to_string(),
            port: port.to_string(),
            secret: creds.secret,
        }),
        None => Err("В конфиге Mihomo не задан external-controller".into()),
    }
}

pub(crate) fn build_url(scheme: &str, host: &str, port: &str, path: &str, query: Option<&str>) -> String {
    let mut url = format!("{}://{}:{}/{}", scheme, host, port, path.trim_start_matches('/'));
    if let Some(q) = query {
        url.push('?');
        url.push_str(q);
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clash_target_comes_from_config() {
        let Ok(ClashTarget::Tcp { host, port, secret }) =
            clash_target_from_config("external-controller: 0.0.0.0:9090\nsecret: s3\n").await
        else {
            panic!("tcp target");
        };
        assert_eq!(
            (host.as_str(), port.as_str(), secret.as_deref()),
            ("127.0.0.1", "9090", Some("s3"))
        );
        for bad in ["", "external-controller: 0.0.0.0:0\n", "external-controller: nope\n"] {
            assert!(clash_target_from_config(bad).await.is_err(), "{bad}");
        }
        // A socket path that is not a socket is refused.
        assert!(
            clash_target_from_config("external-controller-unix: /etc/hosts\n")
                .await
                .is_err()
        );
    }

    #[test]
    fn relay_rejects_rci_and_path_traversal_even_with_an_editable_controller_config() {
        for path in [
            "rci/",
            "api/settings",
            "proxies/../rci/",
            "proxies/%2e%2e/rci/",
            "proxies/%252e%252e/rci/",
            "proxies/x%2f..%2f..%2frci/",
            "proxies/x\\..\\..\\rci/",
            "proxies/%5c..%5c..%5crci/",
        ] {
            assert!(!allowed_relay_path(path), "{path}");
        }
        for path in [
            "configs",
            "proxies/France%20%E2%9C%85/delay",
            "providers/proxies/test",
            "connections/id",
            "cache/dns/flush",
        ] {
            assert!(allowed_relay_path(path), "{path}");
        }
        assert!(!should_forward_header(&HeaderName::from_static("x-ndma-tkn")));
    }

    #[test]
    fn session_cookie_is_not_forwarded() {
        assert!(!should_forward_header(&HeaderName::from_static("cookie")));
        assert!(!should_forward_header(&HeaderName::from_static("authorization")));
        assert!(should_forward_header(&HeaderName::from_static("content-type")));
    }
}
