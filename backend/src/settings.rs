use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use std::path::Path;

pub(crate) async fn read_config(path: &Path) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = match tokio::fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(error.to_string()),
    };
    if !value.is_object() {
        return Err("Файл настроек должен содержать JSON-объект".into());
    }
    Ok(value)
}

pub(crate) async fn write_config(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    crate::fsutil::write_atomic(path, serialized, crate::fsutil::PRIVATE_MODE)
        .await
        .map_err(|e| e.to_string())
}

/// Sections the panel UI edits. Others (e.g. `append_config_paths`, which widens the
/// file access of the config editor) change only in the settings file itself.
const PATCHABLE_SECTIONS: [&str; 7] = ["gui", "updater", "log", "auth", "clash_api", "ui", "config_history"];

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let s = state.settings.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    Json(
        serde_json::json!({ "success": true, "gui": s.gui, "updater": s.updater, "log": s.log, "clash_api": s.clash_api, "auth": { "enabled": s.auth.enabled }, "ui": s.ui, "config_history": s.config_history }),
    )
}

pub async fn patch_settings(
    State(state): State<AppState>, headers: axum::http::HeaderMap, Json(patch): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Some(key) = patch
        .as_object()
        .and_then(|values| values.keys().find(|key| !PATCHABLE_SECTIONS.contains(&key.as_str())))
    {
        return Json(
            serde_json::json!({"success": false, "error": format!("Раздел настроек «{key}» нельзя изменить через панель")}),
        );
    }
    if patch.get("auth").is_some()
        && let Err(error) = crate::auth::require_admin(&state, &headers)
    {
        return Json(serde_json::json!({"success": false, "error": error}));
    }
    if patch.get("auth").is_some_and(|auth| {
        auth.as_object()
            .is_none_or(|values| values.keys().any(|key| key != "enabled"))
    }) {
        return Json(
            serde_json::json!({"success": false, "error": "Учётные записи изменяются в разделе Пользователи"}),
        );
    }
    let _guard = state.app_config_lock.lock().await;
    let mut file_json = match read_config(Path::new(APP_CONFIG)).await {
        Ok(value) => value,
        Err(error) => return Json(serde_json::json!({"success": false, "error": error})),
    };

    let patch_sets_tz = patch.get("log").and_then(|l| l.get("timezone")).is_some();

    json_merge(&mut file_json, patch);

    if let serde_json::Value::Object(ref mut map) = file_json
        && let Some(legacy) = map.remove("timezoneOffset")
        && !patch_sets_tz
        && let Some(log) = map.entry("log").or_insert(serde_json::json!({})).as_object_mut()
    {
        log.insert("timezone".into(), legacy);
    }

    let mut settings: AppSettings = match serde_json::from_value(file_json.clone()) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({"success": false, "error": e.to_string()})),
    };

    if settings.log.timezone < -12 || settings.log.timezone > 14 {
        return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
    }
    if settings.config_history.max_snapshots > MAX_CONFIG_HISTORY_SNAPSHOTS {
        return Json(serde_json::json!({"success": false, "error": "Количество снимков должно быть от 0 до 100"}));
    }
    settings.clash_api.ping_url = settings.clash_api.ping_url.trim().to_string();
    if settings.clash_api.ping_url.is_empty() {
        return Json(serde_json::json!({"success": false, "error": "URL пинг-теста не может быть пустым"}));
    }
    if settings.clash_api.ping_timeout == 0 {
        return Json(serde_json::json!({"success": false, "error": "Таймаут пинг-теста должен быть больше 0"}));
    }
    for (name, url) in [("Xray", &settings.updater.xray_repo), ("Mihomo", &settings.updater.mihomo_repo)] {
        if url.trim().is_empty() {
            return Json(
                serde_json::json!({"success": false, "error": format!("URL репозитория {} не может быть пустым", name)}),
            );
        }
        if !crate::updater::valid_repo_url(url) {
            return Json(
                serde_json::json!({"success": false, "error": format!("Некорректный URL репозитория {}", name)}),
            );
        }
    }
    if settings.updater.auto_check_ui > MAX_CHECK_INTERVAL_HOURS
        || settings.updater.auto_check_core > MAX_CHECK_INTERVAL_HOURS
    {
        return Json(
            serde_json::json!({"success": false, "error": format!("Интервал автопроверки: 0–{} ч", MAX_CHECK_INTERVAL_HOURS)}),
        );
    }
    file_json["updater"]["auto_check_ui"] = settings.updater.auto_check_ui.into();
    file_json["updater"]["auto_check_core"] = settings.updater.auto_check_core.into();
    file_json["config_history"]["max_snapshots"] = settings.config_history.max_snapshots.into();
    settings.normalize_proxies();
    settings.ui.hidden_files = {
        let mut seen = std::collections::HashSet::new();
        settings
            .ui
            .hidden_files
            .iter()
            .map(|f| f.trim())
            .filter(|f| !f.is_empty() && seen.insert((*f).to_string()))
            .map(|f| f.to_string())
            .collect()
    };

    match write_config(Path::new(APP_CONFIG), &file_json).await {
        Ok(()) => {
            *state
                .settings
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
            Json(serde_json::json!({"success": true}))
        }
        Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
    }
}

fn json_merge(a: &mut serde_json::Value, b: serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                json_merge(a.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_settings_are_reported_without_replacing_the_file() {
        let dir = std::env::temp_dir().join(format!("xkeen-settings-{}", uuid::Uuid::new_v4()));
        let path = dir.join("settings.json");
        assert_eq!(read_config(&path).await.unwrap(), serde_json::json!({}));
        write_config(&path, &serde_json::json!({"auth": {"enabled": false}}))
            .await
            .unwrap();
        assert_eq!(read_config(&path).await.unwrap()["auth"]["enabled"], false);
        tokio::fs::write(&path, "[]").await.unwrap();
        assert!(read_config(&path).await.is_err());
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "[]");
        assert!(
            write_config(&path.join("blocked"), &serde_json::json!({}))
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
