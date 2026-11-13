mod agent;
mod capabilities;
mod database;
mod job_object;
mod logging;
mod media;
mod render;
mod storage;

use chrono::Utc;
use database::open_database;
use percent_encoding::percent_decode_str;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

struct AppState {
    database: Arc<Mutex<Connection>>,
    projects_root: PathBuf,
    database_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    storage_path: String,
    database_path: String,
    log_directory: String,
    logging_ready: bool,
    sqlite_ready: bool,
    project_count: i64,
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn json_text(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|error| error.to_string())
}

pub(crate) fn mirror_project_files(
    projects_root: &Path,
    project: &Value,
) -> Result<(String, Value), String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Project is missing an id".to_string())?;
    if !safe_identifier(id) {
        return Err("Project id contains unsupported characters".to_string());
    }
    let project_root = projects_root.join(id);
    let directories = [
        "script",
        "storyboard",
        "assets/images",
        "assets/videos",
        "assets/audio",
        "assets/fonts",
        "animation",
        "audio/narration",
        "audio/music",
        "audio/sfx",
        "subtitles",
        "renders",
        "revisions",
        "cache/temp",
    ];
    for directory in directories {
        fs::create_dir_all(project_root.join(directory)).map_err(|error| error.to_string())?;
    }

    let project = storage::normalize_project_assets(projects_root, project)?;
    write_atomic(&project_root.join("project.json"), &json_text(&project)?)?;

    let outline = project
        .get("outline")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let scenes = project
        .get("scenes")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let subtitles = project
        .get("subtitles")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let timeline = project
        .get("timeline")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    write_atomic(
        &project_root.join("script/outline.json"),
        &json_text(&outline)?,
    )?;
    write_atomic(
        &project_root.join("script/narration.json"),
        &json_text(&scenes)?,
    )?;
    write_atomic(
        &project_root.join("storyboard/scenes.json"),
        &json_text(&scenes)?,
    )?;
    write_atomic(
        &project_root.join("animation/timeline.json"),
        &json_text(&timeline)?,
    )?;
    write_atomic(
        &project_root.join("subtitles/captions.json"),
        &json_text(&subtitles)?,
    )?;

    Ok((project_root.to_string_lossy().to_string(), project))
}

fn project_to_webview(project: &mut Value, project_id: &str) {
    if let Some(assets) = project.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            let Some(source) = asset.get("src").and_then(Value::as_str) else {
                continue;
            };
            if source.starts_with("data:")
                || source.starts_with("http://")
                || source.starts_with("https://")
                || source.starts_with("blob:")
            {
                continue;
            }
            let relative = storage::client_url_to_relative(project_id, source)
                .unwrap_or_else(|| source.to_string());
            if let Some(relative) = storage::safe_relative_path(&relative) {
                asset["src"] =
                    Value::String(storage::public_asset_source(project_id, &relative));
            }
        }
    }
}

#[tauri::command]
fn load_studio_state(
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let state_json = {
        let database = state
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        let mut statement = database
            .prepare("SELECT state_json FROM app_state WHERE namespace = ?1")
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(params![namespace])
            .map_err(|error| error.to_string())?;
        rows.next()
            .map_err(|error| error.to_string())?
            .map(|row| row.get::<_, String>(0))
            .transpose()
            .map_err(|error| error.to_string())?
    };
    let Some(state_json) = state_json else {
        return Ok(None);
    };
    let mut parsed: Value = serde_json::from_str(&state_json)
        .map_err(|error| format!("Stored state is invalid: {error}"))?;
    let mut persisted = parsed
        .get("state")
        .cloned()
        .unwrap_or_else(|| parsed.clone());
    if let Some(projects) = persisted.get_mut("projects").and_then(Value::as_array_mut) {
        for project in projects {
            let Some(project_id) = project
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if !safe_identifier(&project_id) {
                continue;
            }
            let manifest_path = state
                .projects_root
                .join(&project_id)
                .join("project.json");
            if let Some(manifest) = fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            {
                *project = manifest;
            }
            project_to_webview(project, &project_id);
        }
    }
    if parsed.get("state").is_some() {
        parsed["state"] = persisted;
    } else {
        parsed = persisted;
    }
    Ok(Some(
        serde_json::to_string(&parsed).map_err(|error| error.to_string())?,
    ))
}

#[tauri::command]
fn save_studio_state(
    namespace: String,
    state_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut parsed: Value = serde_json::from_str(&state_json)
        .map_err(|error| format!("Invalid state JSON: {error}"))?;
    let mut persisted_state = parsed
        .get("state")
        .cloned()
        .unwrap_or_else(|| parsed.clone());
    let mut normalized_projects = Vec::new();
    if let Some(projects) = persisted_state
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
    {
        for mut project in projects {
            let Some(id) = project
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if !safe_identifier(&id) {
                continue;
            }
            let (_, normalized) =
                mirror_project_files(&state.projects_root, &project)?;
            project = normalized;
            normalized_projects.push(project);
        }
        persisted_state["projects"] = Value::Array(normalized_projects.clone());
    }
    if parsed.get("state").is_some() {
        parsed["state"] = persisted_state.clone();
    } else {
        parsed = persisted_state.clone();
    }
    let normalized_state_json =
        serde_json::to_string(&parsed).map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;

    transaction
        .execute(
            r#"
            INSERT INTO app_state(namespace, state_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(namespace) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            "#,
            params![namespace, normalized_state_json, now],
        )
        .map_err(|error| error.to_string())?;

    let mut live_project_ids = std::collections::HashSet::new();
    for project in &normalized_projects {
            let Some(id) = project.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !safe_identifier(id) {
                continue;
            }
            live_project_ids.insert(id.to_string());
            let title = project
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled project");
            let project_path = state.projects_root.join(id).to_string_lossy().to_string();
            let updated_at = project
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or(&now);
            let project_json = serde_json::to_string(project).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    r#"
                    INSERT INTO projects(id, title, project_path, data_json, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        project_path = excluded.project_path,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at
                    "#,
                    params![id, title, project_path, project_json, updated_at],
                )
                .map_err(|error| error.to_string())?;
    }

    if let Some(providers) = persisted_state.get("providers").and_then(Value::as_array) {
        for provider in providers {
            let Some(id) = provider.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = provider
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Provider");
            let provider_json =
                serde_json::to_string(provider).map_err(|error| error.to_string())?;
            let protocol = provider
                .get("protocol")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let base_url = provider
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let capabilities = serde_json::to_string(
                &provider
                    .get("capabilities")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            )
            .map_err(|error| error.to_string())?;
            let health = provider
                .get("health")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            transaction
                .execute(
                    r#"
                    INSERT INTO providers(
                        id, name, data_json, updated_at, protocol, base_url,
                        capabilities_json, health
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at,
                        protocol = excluded.protocol,
                        base_url = excluded.base_url,
                        capabilities_json = excluded.capabilities_json,
                        health = excluded.health
                    "#,
                    params![
                        id,
                        name,
                        provider_json,
                        now,
                        protocol,
                        base_url,
                        capabilities,
                        health
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    let stored_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM projects")
            .map_err(|error| error.to_string())?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        ids
    };
    transaction.commit().map_err(|error| error.to_string())?;
    drop(database);

    for stale_id in stored_ids
        .into_iter()
        .filter(|id| !live_project_ids.contains(id))
    {
        match storage::archive_project(&state.projects_root, &stale_id) {
            Ok(_) => {
                let database = state
                    .database
                    .lock()
                    .map_err(|_| "Database lock is unavailable".to_string())?;
                database
                    .execute("DELETE FROM projects WHERE id = ?1", params![stale_id])
                    .map_err(|error| error.to_string())?;
                database
                    .execute(
                        "DELETE FROM knowledge_chunks WHERE project_id = ?1",
                        params![stale_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            Err(error) => {
                let database = state
                    .database
                    .lock()
                    .map_err(|_| "Database lock is unavailable".to_string())?;
                let _ = database.execute(
                    "UPDATE projects SET status = 'archive_failed' WHERE id = ?1",
                    params![stale_id],
                );
                return Err(error);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn remove_studio_state(namespace: String, state: State<'_, AppState>) -> Result<(), String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    database
        .execute(
            "DELETE FROM app_state WHERE namespace = ?1",
            params![namespace],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_project_json(app: tauri::AppHandle, project_json: String) -> Result<String, String> {
    let project: Value = serde_json::from_str(&project_json)
        .map_err(|error| format!("Invalid project JSON: {error}"))?;
    let title = project
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("KnowMotion Project");
    let sanitized: String = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else if character.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let filename = format!(
        "{}-{}.knowmotion.json",
        if sanitized.is_empty() {
            "project"
        } else {
            sanitized.as_str()
        },
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let output = downloads.join(filename);
    write_atomic(&output, project_json.as_bytes())?;
    Ok(output.to_string_lossy().to_string())
}

#[tauri::command]
fn export_project_package(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<String, String> {
    if !safe_identifier(&project_id) {
        return Err("Invalid project id".to_string());
    }
    let project_root = state.projects_root.join(&project_id);
    let project: Value = serde_json::from_str(
        &fs::read_to_string(project_root.join("project.json"))
            .map_err(|error| format!("Project manifest is unavailable: {error}"))?,
    )
    .map_err(|error| format!("Project manifest is invalid: {error}"))?;
    let title = project
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("KnowMotion Project");
    let sanitized = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else if character.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>();
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let output = downloads.join(format!(
        "{}-{}.knowmotion.zip",
        if sanitized.is_empty() {
            "project"
        } else {
            &sanitized
        },
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    storage::create_project_zip(&state.projects_root, &project_id, &output)?;
    Ok(output.to_string_lossy().to_string())
}

#[tauri::command]
fn import_project_package(
    state: State<'_, AppState>,
    package_path: String,
) -> Result<Value, String> {
    let (project_id, mut project) =
        storage::import_project_zip(&state.projects_root, Path::new(&package_path))?;
    project_to_webview(&mut project, &project_id);
    Ok(project)
}

#[tauri::command]
fn scan_project_missing_assets(
    state: State<'_, AppState>,
    project_json: String,
) -> Result<Vec<storage::MissingAsset>, String> {
    let project: Value = serde_json::from_str(&project_json)
        .map_err(|error| format!("Invalid project JSON: {error}"))?;
    storage::scan_missing_assets(&state.projects_root, &project)
}

fn serve_project_asset(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let bad_request = |message: &str| {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::BAD_REQUEST)
            .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.as_bytes().to_vec())
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };
    let path = request.uri().path().trim_start_matches('/');
    let Some((project_id, relative)) = path.split_once('/') else {
        return bad_request("Invalid project asset path");
    };
    if !safe_identifier(project_id) {
        return bad_request("Invalid project id");
    }
    let decoded = percent_decode_str(relative).decode_utf8_lossy();
    let Some(relative) = storage::safe_relative_path(&decoded) else {
        return bad_request("Invalid asset path");
    };
    if !relative.starts_with("assets/") {
        return bad_request("Only registered project assets are served");
    }
    let state = context.app_handle().state::<AppState>();
    let project_root = state.projects_root.join(project_id);
    let requested = project_root.join(&relative);
    let Ok(root) = project_root.canonicalize() else {
        return bad_request("Project directory is unavailable");
    };
    let Ok(requested) = requested.canonicalize() else {
        return tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(b"Asset not found".to_vec())
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
    };
    if !requested.starts_with(&root) || !requested.is_file() {
        return bad_request("Asset path escapes the project directory");
    }
    let Ok(bytes) = fs::read(&requested) else {
        return bad_request("Asset could not be read");
    };
    let mime = match requested
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    };
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(tauri::http::header::CONTENT_TYPE, mime)
        .header(
            tauri::http::header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(bytes)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[tauri::command]
fn desktop_status(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let project_count: i64 = database
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap_or(0);
    Ok(DesktopStatus {
        storage_path: state.projects_root.to_string_lossy().to_string(),
        database_path: state.database_path.to_string_lossy().to_string(),
        log_directory: logging::directory()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        logging_ready: logging::healthy(),
        sqlite_ready: true,
        project_count,
    })
}

#[tauri::command]
fn write_webview_log(
    level: String,
    target: String,
    message: String,
    fields_json: Option<String>,
) -> Result<(), String> {
    if message.len() > 128 * 1024 || fields_json.as_ref().is_some_and(|value| value.len() > 128 * 1024)
    {
        return Err("WebView log payload exceeds the 128 KB limit".to_string());
    }
    let level =
        logging::LogLevel::parse(&level).ok_or_else(|| "Unknown log level".to_string())?;
    let fields = fields_json
        .map(|value| {
            serde_json::from_str::<Value>(&value)
                .map_err(|error| format!("Invalid WebView log fields: {error}"))
        })
        .transpose()?;
    logging::log_event(level, &target, &message, fields);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("kmasset", |context, request| {
            serve_project_asset(context, request)
        })
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            logging::init(&app_data.join("logs")).map_err(|error| error.to_string())?;
            logging::install_panic_hook();
            logging::log_event(
                logging::LogLevel::Info,
                "app",
                "Desktop application starting",
                Some(serde_json::json!({
                    "version": app.package_info().version.to_string(),
                    "appData": app_data.to_string_lossy()
                })),
            );
            let projects_root = app_data.join("projects");
            fs::create_dir_all(&projects_root).map_err(|error| error.to_string())?;
            let database_path = app_data.join("studio.sqlite3");
            let database = Arc::new(Mutex::new(
                open_database(&database_path).map_err(|error| error.to_string())?,
            ));
            let agent_runtime =
                agent::runtime::AgentRuntime::new(&database_path, projects_root.clone())?;
            let media_service =
                media::MediaService::new(projects_root.clone(), app_data.join("cache/media"))?;
            let render_manager = render::RenderManager::new(
                database.clone(),
                projects_root.clone(),
                app.handle(),
            )?;
            app.manage(AppState {
                database,
                projects_root,
                database_path,
            });
            app.manage(agent_runtime);
            app.manage(media_service);
            app.manage(render_manager);
            logging::log_event(
                logging::LogLevel::Info,
                "app",
                "Desktop services initialized",
                Some(serde_json::json!({ "databaseReady": true })),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_studio_state,
            save_studio_state,
            remove_studio_state,
            export_project_json,
            export_project_package,
            import_project_package,
            scan_project_missing_assets,
            desktop_status,
            write_webview_log,
            capabilities::generate_project_images,
            capabilities::generate_project_cloud_narration,
            capabilities::transcribe_project_audio,
            capabilities::embed_project_knowledge,
            capabilities::search_project_knowledge,
            capabilities::fetch_research_source,
            agent::agent_workflow_definition,
            agent::workflow_start,
            agent::workflow_get,
            agent::workflow_list,
            agent::workflow_pause,
            agent::workflow_resume,
            agent::workflow_retry,
            agent::workflow_rerun_step,
            agent::workflow_approve,
            agent::workflow_undo_revision,
            agent::provider_save_secret,
            agent::provider_clear_secret,
            agent::provider_test,
            media::generate_project_narration,
            media::generate_background_music,
            render::render_start,
            render::render_get,
            render::render_list,
            render::render_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building KnowMotion AI Studio");
    app.run(|_, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            logging::info("app", "Desktop application exiting");
            logging::shutdown();
        }
    });
}
