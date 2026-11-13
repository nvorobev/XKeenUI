use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../frontend/dist"]
struct StaticFiles;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    StaticFiles::get(&format!("{path}.gz"))
        .map(|f| build_res(path, f.data, true))
        .or_else(|| StaticFiles::get(path).map(|f| build_res(path, f.data, false)))
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

fn build_res(path: &str, data: impl Into<Body>, is_gz: bool) -> Response {
    let mut res = Response::new(data.into());
    let headers = res.headers_mut();
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if path == "index.html" {
            "no-store"
        } else {
            "public, max-age=31536000, immutable"
        }),
    );

    if is_gz {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }

    res
}
