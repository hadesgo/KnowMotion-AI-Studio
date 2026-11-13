mod agent;
mod media;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Instant,
};
use tauri::{Manager, State};

struct AppState {
    database: Mutex<Connection>,
    projects_root: PathBuf,
    database_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    storage_path: String,
    database_path: String,
    sqlite_ready: bool,
    project_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotionRenderResult {
    output_path: String,
    bytes: u64,
    elapsed_ms: u128,
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS app_state (
                namespace TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_path TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_projects_updated
                ON projects(updated_at DESC);
            "#,
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
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
) -> Result<String, String> {
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

    write_atomic(&project_root.join("project.json"), &json_text(project)?)?;

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
    let assets = project
        .get("assets")
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
        &project_root.join("assets/manifest.json"),
        &json_text(&assets)?,
    )?;
    write_atomic(
        &project_root.join("subtitles/captions.json"),
        &json_text(&subtitles)?,
    )?;

    Ok(project_root.to_string_lossy().to_string())
}

#[tauri::command]
fn load_studio_state(
    namespace: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
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
    if let Some(row) = rows.next().map_err(|error| error.to_string())? {
        Ok(Some(row.get(0).map_err(|error| error.to_string())?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn save_studio_state(
    namespace: String,
    state_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&state_json)
        .map_err(|error| format!("Invalid state JSON: {error}"))?;
    // Zustand persist wraps the partial state in { state, version }.
    let persisted_state = parsed.get("state").unwrap_or(&parsed);
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
            params![namespace, state_json, now],
        )
        .map_err(|error| error.to_string())?;

    if let Some(projects) = persisted_state.get("projects").and_then(Value::as_array) {
        for project in projects {
            let Some(id) = project.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !safe_identifier(id) {
                continue;
            }
            let title = project
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled project");
            let project_path = mirror_project_files(&state.projects_root, project)?;
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
            transaction
                .execute(
                    r#"
                    INSERT INTO providers(id, name, data_json, updated_at)
                    VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at
                    "#,
                    params![id, name, provider_json, now],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    transaction.commit().map_err(|error| error.to_string())
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
        sqlite_ready: true,
        project_count,
    })
}

fn renderer_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("KNOWMOTION_RENDERER_ROOT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(current) = std::env::current_dir() {
        candidates.extend(current.ancestors().map(Path::to_path_buf));
    }
    if let Ok(executable) = std::env::current_exe() {
        candidates.extend(
            executable
                .parent()
                .into_iter()
                .flat_map(Path::ancestors)
                .map(Path::to_path_buf),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| {
            candidate.join("package.json").is_file()
                && candidate.join("scripts/render-remotion.ts").is_file()
                && candidate.join("src/remotion/index.ts").is_file()
        })
        .ok_or_else(|| {
            "Remotion renderer source is unavailable in this build. Set KNOWMOTION_RENDERER_ROOT to the project root."
                .to_string()
        })
}

fn resolve_node_executable() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("KNOWMOTION_NODE") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let direct = PathBuf::from("node.exe");
    if Command::new(&direct).arg("--version").output().is_ok() {
        return Ok(direct);
    }
    let mut candidates = Vec::new();
    candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let installs = PathBuf::from(local_app_data).join("Author Software/nvm/installs");
        if let Ok(entries) = fs::read_dir(installs) {
            let mut versions = entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let candidate = entry.path().join("node.exe");
                    candidate.is_file().then_some(candidate)
                })
                .collect::<Vec<_>>();
            versions.sort();
            versions.reverse();
            candidates.extend(versions);
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "Node.js executable is unavailable. Set KNOWMOTION_NODE to a bundled Node runtime."
                .to_string()
        })
}

#[tauri::command]
async fn render_remotion_composition(
    app: tauri::AppHandle,
    project_id: String,
    composition_json: String,
) -> Result<RemotionRenderResult, String> {
    if !safe_identifier(&project_id) {
        return Err("Invalid project id".to_string());
    }
    if composition_json.len() > 20 * 1024 * 1024 {
        return Err("Composition exceeds the 20 MB render limit".to_string());
    }
    let project_root = renderer_root()?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let job_id = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let job_directory = app_data
        .join("projects")
        .join(&project_id)
        .join("cache/render-jobs");
    let output_directory = app_data.join("projects").join(&project_id).join("renders");
    fs::create_dir_all(&job_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;
    let composition_path = job_directory.join(format!("{job_id}.json"));
    let output_path = output_directory.join(format!("{job_id}.mp4"));
    write_atomic(&composition_path, composition_json.as_bytes())?;

    let renderer_script = project_root.join("node_modules/tsx/dist/cli.mjs");
    if !renderer_script.is_file() {
        return Err("tsx renderer dependency is missing".to_string());
    }
    let node_executable = resolve_node_executable()?;
    let project_root_for_command = project_root.clone();
    let composition_for_command = composition_path.clone();
    let output_for_command = output_path.clone();
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(node_executable);
        command
            .current_dir(&project_root_for_command)
            .arg(renderer_script)
            .arg("scripts/render-remotion.ts")
            .arg("--composition")
            .arg(composition_for_command)
            .arg("--out")
            .arg(output_for_command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.output().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;

    if !result.status.success() {
        return Err(format!(
            "Remotion renderer failed: {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .rev()
                .take(2000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    let bytes = fs::metadata(&output_path)
        .map_err(|error| error.to_string())?
        .len();
    if bytes == 0 {
        return Err("Remotion renderer produced an empty file".to_string());
    }
    Ok(RemotionRenderResult {
        output_path: output_path.to_string_lossy().to_string(),
        bytes,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let projects_root = app_data.join("projects");
            fs::create_dir_all(&projects_root).map_err(|error| error.to_string())?;
            let database_path = app_data.join("studio.sqlite3");
            let database = open_database(&database_path).map_err(|error| error.to_string())?;
            let agent_runtime =
                agent::runtime::AgentRuntime::new(&database_path, projects_root.clone())?;
            let media_service =
                media::MediaService::new(projects_root.clone(), app_data.join("cache/media"))?;
            app.manage(AppState {
                database: Mutex::new(database),
                projects_root,
                database_path,
            });
            app.manage(agent_runtime);
            app.manage(media_service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_studio_state,
            save_studio_state,
            remove_studio_state,
            export_project_json,
            desktop_status,
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
            render_remotion_composition
        ])
        .run(tauri::generate_context!())
        .expect("error while running KnowMotion AI Studio");
}
