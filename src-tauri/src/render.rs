use crate::{
    job_object::RenderJobObject, logging, logging::LogLevel, safe_identifier, write_atomic,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

pub const RENDER_PROGRESS_EVENT: &str = "render.progress";
pub const RENDER_CHANGED_EVENT: &str = "render.changed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartResponse {
    pub job_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderJobView {
    pub id: String,
    pub task_id: String,
    pub project_id: String,
    pub project_revision: i64,
    pub status: String,
    pub percent: f64,
    pub rendered_frames: i64,
    pub encoded_frames: i64,
    pub stage: String,
    pub output_path: Option<String>,
    pub bytes: Option<i64>,
    pub sha256: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgressPayload {
    pub event_id: String,
    pub job_id: String,
    pub percent: f64,
    pub rendered_frames: u64,
    pub encoded_frames: u64,
    pub stage: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderChangedPayload {
    event_id: String,
    entity_id: String,
    change: String,
    status: String,
    at: String,
}

struct ActiveRender {
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    canceled: Arc<AtomicBool>,
    job_object: RenderJobObject,
}

struct RenderEnvironment {
    root: PathBuf,
    node: PathBuf,
    tsx: PathBuf,
    worker: PathBuf,
    entry_point: PathBuf,
    browser_executable: Option<PathBuf>,
    ffmpeg_executable: Option<PathBuf>,
    ffprobe_executable: Option<PathBuf>,
    version: String,
}

pub struct RenderManager {
    database: Arc<Mutex<Connection>>,
    projects_root: PathBuf,
    environment: RenderEnvironment,
    active: Arc<Mutex<HashMap<String, ActiveRender>>>,
}

impl RenderManager {
    pub fn new(
        database: Arc<Mutex<Connection>>,
        projects_root: PathBuf,
        app: &AppHandle,
    ) -> Result<Arc<Self>, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let environment = RenderEnvironment::resolve(&app_data, &resource_dir)?;
        let manager = Arc::new(Self {
            database,
            projects_root,
            environment,
            active: Arc::new(Mutex::new(HashMap::new())),
        });
        manager.recover_interrupted_jobs()?;
        Ok(manager)
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        project_id: &str,
        composition_json: &str,
        project_revision: Option<i64>,
    ) -> Result<RenderStartResponse, String> {
        if !safe_identifier(project_id) {
            return Err("Invalid project id".to_string());
        }
        if composition_json.len() > 20 * 1024 * 1024 {
            return Err("Composition exceeds the 20 MB render limit".to_string());
        }
        let project_root = self.projects_root.join(project_id);
        if let Ok(project_json) = fs::read_to_string(project_root.join("project.json")) {
            let project: Value = serde_json::from_str(&project_json)
                .map_err(|error| format!("Project manifest is invalid: {error}"))?;
            if project
                .pointer("/qualityReport/status")
                .and_then(Value::as_str)
                == Some("fail")
            {
                return Err("Quality review failed; formal render is blocked".to_string());
            }
            let missing = crate::storage::scan_missing_assets(&self.projects_root, &project)?;
            if !missing.is_empty() {
                return Err(format!(
                    "Render is blocked because {} referenced assets are missing",
                    missing.len()
                ));
            }
        }
        {
            let active = self
                .active
                .lock()
                .map_err(|_| "Render process registry is unavailable".to_string())?;
            if !active.is_empty() {
                return Err("Another video render is already running".to_string());
            }
        }

        let composition: Value = serde_json::from_str(composition_json)
            .map_err(|error| format!("Invalid composition JSON: {error}"))?;
        let composition = hydrate_composition_assets(&project_root, project_id, composition)?;
        let duration_in_frames = composition
            .get("durationInFrames")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Composition is missing durationInFrames".to_string())?;
        let fps = composition
            .get("fps")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| "Composition is missing a valid fps".to_string())?;
        let expected_duration_ms = ((duration_in_frames as f64 / fps as f64) * 1000.0) as i64;

        let job_id = Uuid::new_v4().to_string();
        let task_id = Uuid::new_v4().to_string();
        let project_revision =
            project_revision.unwrap_or_else(|| Utc::now().timestamp_millis().abs());
        let job_directory = project_root.join("cache/render-jobs");
        let output_directory = project_root.join("renders");
        fs::create_dir_all(&job_directory).map_err(|error| error.to_string())?;
        fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;

        let manifest_path = job_directory.join(format!("{job_id}.json"));
        let output_path = output_directory.join(format!("{job_id}.mp4"));
        let partial_path = output_directory.join(format!("{job_id}.partial.mp4"));
        let runtime = json!({
            "browserExecutable": self.environment.browser_executable.as_ref().map(|path| path.to_string_lossy().to_string()),
            "ffmpegExecutable": self.environment.ffmpeg_executable.as_ref().map(|path| path.to_string_lossy().to_string()),
            "chromeMode": "headless-shell",
            "concurrency": 1,
            "timeoutMs": 10 * 60 * 1000
        });
        let manifest = json!({
            "schemaVersion": "1.0",
            "jobId": job_id,
            "projectId": project_id,
            "projectRevision": project_revision,
            "rendererVersion": self.environment.version,
            "entryPoint": self.environment.entry_point,
            "compositionId": "KnowledgeVideo",
            "output": {
                "path": partial_path,
                "codec": "h264",
                "videoBitrate": "8M"
            },
            "inputProps": { "composition": composition },
            "runtime": runtime
        });
        write_atomic(
            &manifest_path,
            &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )?;

        let now = Utc::now().to_rfc3339();
        {
            let mut database = self.lock_db()?;
            let transaction = database.transaction().map_err(|error| error.to_string())?;
            transaction
                .execute(
                    r#"
                    INSERT INTO tasks(
                        id, project_id, kind, status, priority, progress,
                        payload_ref, attempt, max_attempts, idempotency_key,
                        created_at, updated_at
                    ) VALUES (?1, ?2, 'render', 'running', 0, 0, ?3, 1, 1, ?4, ?5, ?5)
                    "#,
                    params![
                        task_id,
                        project_id,
                        manifest_path.to_string_lossy(),
                        format!("render/{job_id}"),
                        now
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    r#"
                    INSERT INTO render_jobs(
                        id, task_id, project_id, project_revision, spec_path,
                        output_path, partial_path, status, progress,
                        renderer_version, created_at, updated_at, started_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', 0, ?8, ?9, ?9, ?9)
                    "#,
                    params![
                        job_id,
                        task_id,
                        project_id,
                        project_revision,
                        manifest_path.to_string_lossy(),
                        output_path.to_string_lossy(),
                        partial_path.to_string_lossy(),
                        self.environment.version,
                        now
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }

        let mut command = Command::new(&self.environment.node);
        command
            .current_dir(&self.environment.root)
            .arg(&self.environment.tsx)
            .arg(&self.environment.worker)
            .arg(&manifest_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Unable to start renderer: {error}"))?;
        let job_object = match RenderJobObject::attach(&child) {
            Ok(job_object) => job_object,
            Err(error) => {
                logging::log_event(
                    LogLevel::Error,
                    "render",
                    "Unable to initialize render process tree",
                    Some(json!({ "jobId": job_id, "error": error })),
                );
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&manifest_path);
                let _ = self.finish_job(
                    &job_id,
                    &task_id,
                    "failed",
                    None,
                    None,
                    None,
                    None,
                    Some("RENDER_JOB_OBJECT_FAILED"),
                    Some(&error),
                );
                return Err(error);
            }
        };
        let pid = child.id() as i64;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Renderer stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Renderer stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Renderer stderr is unavailable".to_string())?;
        let child = Arc::new(Mutex::new(child));
        let canceled = Arc::new(AtomicBool::new(false));
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Render process registry is unavailable".to_string())?;
            active.insert(
                job_id.clone(),
                ActiveRender {
                    stdin: Mutex::new(Some(stdin)),
                    child: child.clone(),
                    canceled: canceled.clone(),
                    job_object: job_object.clone(),
                },
            );
        }
        self.update_job_started(&job_id, pid)?;
        logging::log_event(
            LogLevel::Info,
            "render",
            "Render job started",
            Some(json!({
                "jobId": job_id,
                "taskId": task_id,
                "projectId": project_id,
                "pid": pid,
                "rendererVersion": self.environment.version,
                "expectedDurationMs": expected_duration_ms
            })),
        );
        self.emit_progress(&app, &job_id, 0.0, 0, 0, "starting");
        self.emit_changed(&app, &job_id, "updated", "running");

        let manager = self.clone();
        let thread_job_id = job_id.clone();
        let thread_task_id = task_id.clone();
        let event_app = app.clone();
        thread::spawn(move || {
            manager.run_worker(
                event_app,
                thread_job_id,
                thread_task_id,
                output_path,
                partial_path,
                manifest_path,
                expected_duration_ms,
                child,
                canceled,
                job_object,
                stdout,
                stderr,
            );
        });

        Ok(RenderStartResponse { job_id, task_id })
    }

    pub fn get(&self, project_id: &str, job_id: &str) -> Result<RenderJobView, String> {
        if !safe_identifier(project_id) {
            return Err("Invalid project id".to_string());
        }
        let database = self.lock_db()?;
        load_job(&database, project_id, job_id)?
            .ok_or_else(|| format!("Render job not found: {job_id}"))
    }

    pub fn list(&self, project_id: &str, limit: usize) -> Result<Vec<RenderJobView>, String> {
        if !safe_identifier(project_id) {
            return Err("Invalid project id".to_string());
        }
        let database = self.lock_db()?;
        let mut statement = database
            .prepare(
                r#"
                SELECT id, task_id, project_id, project_revision, status, progress,
                       rendered_frames, encoded_frames, output_path, bytes, sha256,
                       duration_ms, error_message, created_at, updated_at
                FROM render_jobs
                WHERE project_id = ?1
                ORDER BY created_at DESC
                LIMIT ?2
                "#,
            )
            .map_err(|error| error.to_string())?;
        let jobs = statement
            .query_map(params![project_id, limit.clamp(1, 100) as i64], job_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(jobs)
    }

    pub fn cancel(&self, app: &AppHandle, project_id: &str, job_id: &str) -> Result<RenderJobView, String> {
        let job = self.get(project_id, job_id)?;
        if !matches!(job.status.as_str(), "queued" | "running" | "canceling") {
            return Ok(job);
        }
        self.update_job_status(job_id, "canceling", None)?;
        logging::log_event(
            LogLevel::Info,
            "render",
            "Render cancellation requested",
            Some(json!({ "jobId": job_id, "projectId": project_id })),
        );
        let (stdin, child, canceled, job_object) = {
            let active = self
                .active
                .lock()
                .map_err(|_| "Render process registry is unavailable".to_string())?;
            let process = active
                .get(job_id)
                .ok_or_else(|| "Render process is no longer running".to_string())?;
            process.canceled.store(true, Ordering::SeqCst);
            let stdin = {
                let mut stdin = process
                    .stdin
                    .lock()
                    .map_err(|_| "Renderer stdin is unavailable".to_string())?;
                stdin.take()
            };
            (
                stdin,
                process.child.clone(),
                process.canceled.clone(),
                process.job_object.clone(),
            )
        };
        if let Some(mut stdin) = stdin {
            stdin
                .write_all(b"cancel\n")
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("Unable to request render cancellation: {error}"))?;
        }
        let _ = canceled;
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(4));
            if let Ok(mut child) = child.lock() {
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = job_object.terminate();
                    let _ = child.kill();
                }
            }
        });
        self.emit_progress(app, job_id, job.percent, job.rendered_frames as u64, job.encoded_frames as u64, "canceling");
        self.get(project_id, job_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_worker(
        self: Arc<Self>,
        app: AppHandle,
        job_id: String,
        task_id: String,
        output_path: PathBuf,
        partial_path: PathBuf,
        manifest_path: PathBuf,
        expected_duration_ms: i64,
        child: Arc<Mutex<Child>>,
        canceled: Arc<AtomicBool>,
        _job_object: RenderJobObject,
        stdout: impl Read + Send + 'static,
        stderr: impl Read + Send + 'static,
    ) {
        let stderr_thread = thread::spawn(move || drain_stderr(stderr, 256 * 1024));
        let mut last_error = String::new();
        let mut completed_message = false;
        let mut last_db_update = Instant::now() - Duration::from_secs(1);
        let mut last_percent = -1.0_f64;

        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match payload.get("type").and_then(Value::as_str) {
                Some("progress") => {
                    let percent = payload
                        .get("percent")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        .clamp(0.0, 100.0);
                    let rendered_frames = payload
                        .get("renderedFrames")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let encoded_frames = payload
                        .get("encodedFrames")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let stage = payload
                        .get("stage")
                        .and_then(Value::as_str)
                        .unwrap_or("rendering")
                        .to_string();
                    if (percent - last_percent).abs() >= 0.5
                        || last_db_update.elapsed() >= Duration::from_millis(500)
                    {
                        let _ = self.update_job_progress(
                            &job_id,
                            percent,
                            rendered_frames,
                            encoded_frames,
                        );
                        self.emit_progress(
                            &app,
                            &job_id,
                            percent,
                            rendered_frames,
                            encoded_frames,
                            &stage,
                        );
                        last_percent = percent;
                        last_db_update = Instant::now();
                    }
                }
                Some("completed") => completed_message = true,
                Some("canceled") => {
                    canceled.store(true, Ordering::SeqCst);
                }
                Some("error") => {
                    last_error = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Renderer failed")
                        .to_string();
                }
                _ => {}
            }
        }

        let status = child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.success())
            .unwrap_or(false);
        let stderr_text = stderr_thread.join().unwrap_or_default();
        if !stderr_text.trim().is_empty() {
            logging::log_event(
                LogLevel::Warn,
                "render",
                "Renderer stderr",
                Some(json!({
                    "jobId": job_id,
                    "stderr": stderr_text
                })),
            );
        }

        if canceled.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&partial_path);
            let _ = fs::remove_file(&manifest_path);
            let _ = self.finish_job(
                &job_id,
                &task_id,
                "canceled",
                None,
                None,
                None,
                None,
                None,
                Some("Render was canceled"),
            );
            self.emit_progress(&app, &job_id, 0.0, 0, 0, "canceled");
            self.emit_changed(&app, &job_id, "updated", "canceled");
            logging::log_event(
                LogLevel::Info,
                "render",
                "Render job canceled",
                Some(json!({ "jobId": job_id })),
            );
            self.remove_active(&job_id);
            return;
        }

        if !status || !completed_message {
            let detail = if last_error.is_empty() {
                stderr_text
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            } else {
                last_error
            };
            let safe_detail = limited_error(&detail);
            logging::log_event(
                LogLevel::Error,
                "render",
                "Render job failed",
                Some(json!({
                    "jobId": job_id,
                    "exitSuccessful": status,
                    "completedProtocol": completed_message,
                    "error": safe_detail
                })),
            );
            let _ = fs::remove_file(&partial_path);
            let _ = self.finish_job(
                &job_id,
                &task_id,
                "failed",
                None,
                None,
                None,
                None,
                Some("RENDER_FAILED"),
                Some(&safe_detail),
            );
            self.emit_progress(&app, &job_id, 0.0, 0, 0, "failed");
            self.emit_changed(&app, &job_id, "updated", "failed");
            self.remove_active(&job_id);
            return;
        }

        let verified = (|| -> Result<(u64, String, i64), String> {
            let bytes = fs::metadata(&partial_path)
                .map_err(|error| format!("Rendered file is missing: {error}"))?
                .len();
            if bytes == 0 {
                return Err("Renderer produced an empty file".to_string());
            }
            let probed_duration = probe_duration(
                self.environment.ffprobe_executable.as_deref(),
                &partial_path,
            )?;
            if (probed_duration - expected_duration_ms).abs()
                > (expected_duration_ms / 10).max(3_000)
            {
                return Err(format!(
                    "Rendered duration {probed_duration} ms differs from expected {expected_duration_ms} ms"
                ));
            }
            let sha256 = file_sha256(&partial_path)?;
            fs::rename(&partial_path, &output_path)
                .map_err(|error| format!("Unable to commit rendered video: {error}"))?;
            Ok((bytes, sha256, probed_duration))
        })();

        let (bytes, sha256, duration_ms) = match verified {
            Ok(result) => result,
            Err(error) => {
                let safe_error = logging::redact_text(&error);
                logging::log_event(
                    LogLevel::Error,
                    "render",
                    "Render artifact validation failed",
                    Some(json!({ "jobId": job_id, "error": safe_error })),
                );
                let _ = fs::remove_file(&partial_path);
                let _ = self.finish_job(
                    &job_id,
                    &task_id,
                    "failed",
                    None,
                    None,
                    None,
                    None,
                    Some("RENDER_VALIDATION_FAILED"),
                    Some(&safe_error),
                );
                self.emit_progress(&app, &job_id, 0.0, 0, 0, "failed");
                self.emit_changed(&app, &job_id, "updated", "failed");
                self.remove_active(&job_id);
                return;
            }
        };

        let metadata_path = output_path.with_extension("json");
        let metadata = json!({
            "schemaVersion": "1.0",
            "jobId": job_id,
            "taskId": task_id,
            "outputPath": output_path,
            "bytes": bytes,
            "sha256": sha256,
            "durationMs": duration_ms,
            "rendererVersion": self.environment.version,
            "completedAt": Utc::now().to_rfc3339()
        });
        let _ = write_atomic(
            &metadata_path,
            &serde_json::to_vec_pretty(&metadata).unwrap_or_default(),
        );
        let relative_path = output_path
            .strip_prefix(&self.projects_root)
            .unwrap_or(&output_path)
            .to_string_lossy()
            .replace('\\', "/");
        let _ = self.finish_job(
            &job_id,
            &task_id,
            "succeeded",
            Some(&output_path.to_string_lossy()),
            Some(bytes as i64),
            Some(&sha256),
            Some(duration_ms),
            None,
            None,
        );
        let _ = self.record_artifact(&job_id, &relative_path, bytes, &sha256, duration_ms);
        self.emit_progress(&app, &job_id, 100.0, expected_duration_ms as u64, 0, "completed");
        self.emit_changed(&app, &job_id, "updated", "succeeded");
        logging::log_event(
            LogLevel::Info,
            "render",
            "Render job completed",
            Some(json!({
                "jobId": job_id,
                "bytes": bytes,
                "sha256": sha256,
                "durationMs": duration_ms,
                "output": relative_path
            })),
        );
        self.remove_active(&job_id);
    }

    fn recover_interrupted_jobs(&self) -> Result<(), String> {
        let database = self.lock_db()?;
        let now = Utc::now().to_rfc3339();
        database
            .execute(
                r#"
                UPDATE render_jobs
                SET status = 'interrupted', error_code = 'APP_RESTARTED',
                    error_message = '应用曾关闭，渲染任务已安全中断，可重新发起。',
                    updated_at = ?1, finished_at = ?1
                WHERE status IN ('queued', 'running', 'canceling')
                "#,
                params![now],
            )
            .map_err(|error| error.to_string())?;
        database
            .execute(
                r#"
                UPDATE tasks
                SET status = 'interrupted', error_code = 'APP_RESTARTED',
                    updated_at = ?1
                WHERE kind = 'render' AND status IN ('queued', 'running', 'canceling')
                "#,
                params![now],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn update_job_started(&self, job_id: &str, pid: i64) -> Result<(), String> {
        let database = self.lock_db()?;
        database
            .execute(
                "UPDATE render_jobs SET pid = ?1, updated_at = ?2 WHERE id = ?3",
                params![pid, Utc::now().to_rfc3339(), job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn update_job_status(
        &self,
        job_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let database = self.lock_db()?;
        database
            .execute(
                "UPDATE render_jobs SET status = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
                params![status, error, Utc::now().to_rfc3339(), job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn update_job_progress(
        &self,
        job_id: &str,
        percent: f64,
        rendered_frames: u64,
        encoded_frames: u64,
    ) -> Result<(), String> {
        let database = self.lock_db()?;
        database
            .execute(
                r#"
                UPDATE render_jobs
                SET progress = ?1, rendered_frames = ?2, encoded_frames = ?3,
                    status = 'running', updated_at = ?4
                WHERE id = ?5 AND status IN ('running', 'canceling')
                "#,
                params![
                    percent,
                    rendered_frames as i64,
                    encoded_frames as i64,
                    Utc::now().to_rfc3339(),
                    job_id
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_job(
        &self,
        job_id: &str,
        task_id: &str,
        status: &str,
        output_path: Option<&str>,
        bytes: Option<i64>,
        sha256: Option<&str>,
        duration_ms: Option<i64>,
        error_code: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let mut database = self.lock_db()?;
        let transaction = database.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute(
                r#"
                UPDATE render_jobs
                SET status = ?1, progress = CASE WHEN ?1 = 'succeeded' THEN 100 ELSE progress END,
                    output_path = COALESCE(?2, output_path), bytes = ?3, sha256 = ?4,
                    duration_ms = ?5, error_code = ?6, error_message = ?7,
                    updated_at = ?8, finished_at = ?8
                WHERE id = ?9
                "#,
                params![
                    status,
                    output_path,
                    bytes,
                    sha256,
                    duration_ms,
                    error_code,
                    error,
                    now,
                    job_id
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                r#"
                UPDATE tasks
                SET status = ?1, progress = CASE WHEN ?1 = 'succeeded' THEN 100 ELSE progress END,
                    result_ref = ?2, error_code = ?3, error_message = ?4, updated_at = ?5
                WHERE id = ?6
                "#,
                params![status, output_path, error_code, error, now, task_id],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn record_artifact(
        &self,
        job_id: &str,
        relative_path: &str,
        bytes: u64,
        sha256: &str,
        duration_ms: i64,
    ) -> Result<(), String> {
        let database = self.lock_db()?;
        database
            .execute(
                r#"
                INSERT INTO artifact_refs(
                    id, owner_type, owner_id, project_relative_path,
                    mime_type, sha256, bytes, created_at
                ) VALUES (?1, 'render', ?2, ?3, 'video/mp4', ?4, ?5, ?6)
                "#,
                params![
                    Uuid::new_v4().to_string(),
                    job_id,
                    relative_path,
                    sha256,
                    bytes as i64,
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|error| error.to_string())?;
        let _ = database.execute(
            "UPDATE render_jobs SET duration_ms = COALESCE(duration_ms, ?1) WHERE id = ?2",
            params![duration_ms, job_id],
        );
        Ok(())
    }

    fn remove_active(&self, job_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(job_id);
        }
    }

    fn emit_progress(
        &self,
        app: &AppHandle,
        job_id: &str,
        percent: f64,
        rendered_frames: u64,
        encoded_frames: u64,
        stage: &str,
    ) {
        let _ = app.emit(
            RENDER_PROGRESS_EVENT,
            RenderProgressPayload {
                event_id: Uuid::new_v4().to_string(),
                job_id: job_id.to_string(),
                percent,
                rendered_frames,
                encoded_frames,
                stage: stage.to_string(),
                at: Utc::now().to_rfc3339(),
            },
        );
    }

    fn emit_changed(&self, app: &AppHandle, job_id: &str, change: &str, status: &str) {
        let _ = app.emit(
            RENDER_CHANGED_EVENT,
            RenderChangedPayload {
                event_id: Uuid::new_v4().to_string(),
                entity_id: job_id.to_string(),
                change: change.to_string(),
                status: status.to_string(),
                at: Utc::now().to_rfc3339(),
            },
        );
    }

    fn lock_db(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())
    }
}

impl RenderEnvironment {
    fn resolve(app_data: &Path, resource_dir: &Path) -> Result<Self, String> {
        verify_runtime_manifest(resource_dir)?;
        let root = find_renderer_root(resource_dir)?;
        let node = find_node(resource_dir)?;
        let tsx = [
            root.join("node_modules/tsx/dist/cli.mjs"),
            root.join("resources/renderer/node_modules/tsx/dist/cli.mjs"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "tsx renderer dependency is missing".to_string())?;
        let worker = [
            root.join("scripts/render-worker.ts"),
            root.join("resources/renderer/render-worker.ts"),
            resource_dir.join("renderer/render-worker.ts"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "render-worker.ts is missing".to_string())?;
        let entry_point = [
            root.join("src/remotion/index.ts"),
            root.join("resources/renderer/renderer-entry.ts"),
            resource_dir.join("renderer/renderer-entry.ts"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "Remotion entry point is missing".to_string())?;
        let ffmpeg_executable = find_optional_tool(
            "KNOWMOTION_FFMPEG",
            &[
                root.join("node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe"),
                resource_dir.join("ffmpeg/ffmpeg.exe"),
                resource_dir.join("resources/ffmpeg/ffmpeg.exe"),
            ],
        );
        let ffprobe_executable = find_optional_tool(
            "KNOWMOTION_FFPROBE",
            &[
                root.join("node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"),
                resource_dir.join("ffmpeg/ffprobe.exe"),
                resource_dir.join("resources/ffmpeg/ffprobe.exe"),
            ],
        );
        let browser_executable = find_optional_tool(
            "KNOWMOTION_BROWSER",
            &[
                resource_dir.join("browser/chrome-headless-shell.exe"),
                resource_dir.join("resources/browser/chrome-headless-shell.exe"),
                app_data.join("render-runtime/browser/chrome-headless-shell.exe"),
            ],
        );
        let version = "remotion-4.0.543".to_string();
        Ok(Self {
            root,
            node,
            tsx,
            worker,
            entry_point,
            browser_executable,
            ffmpeg_executable,
            ffprobe_executable,
            version,
        })
    }
}

fn find_renderer_root(resource_dir: &Path) -> Result<PathBuf, String> {
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
    candidates.push(resource_dir.join("renderer"));
    candidates.push(resource_dir.join("resources/renderer"));
    candidates.push(resource_dir.to_path_buf());
    candidates
        .into_iter()
        .find(|candidate| {
            candidate.join("scripts/render-worker.ts").is_file()
                && candidate.join("node_modules/tsx/dist/cli.mjs").is_file()
        })
        .ok_or_else(|| {
            "Renderer source is unavailable. Set KNOWMOTION_RENDERER_ROOT to the bundled renderer directory."
                .to_string()
        })
}

fn find_node(resource_dir: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("KNOWMOTION_NODE") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            let candidate = parent.join("node.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for candidate in [
        resource_dir.join("node.exe"),
        resource_dir.join("runtime/node.exe"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let system_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    if system_node.is_file() {
        return Ok(system_node);
    }
    if Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
    {
        return Ok(PathBuf::from("node"));
    }
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
            if let Some(path) = versions.into_iter().next() {
                return Ok(path);
            }
        }
    }
    Err("Node.js executable is unavailable. Bundle node.exe or set KNOWMOTION_NODE.".to_string())
}

fn find_optional_tool(variable: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(value) = std::env::var(variable) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    candidates.iter().find(|path| path.is_file()).cloned()
}

fn verify_runtime_manifest(resource_dir: &Path) -> Result<(), String> {
    let candidates = [
        resource_dir.join("runtime-manifest.json"),
        resource_dir.join("resources/runtime-manifest.json"),
    ];
    let Some(path) = candidates.iter().find(|path| path.is_file()) else {
        return Ok(());
    };
    let manifest: Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("Unable to read runtime manifest: {error}"))?,
    )
    .map_err(|error| format!("Invalid runtime manifest: {error}"))?;
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "Runtime manifest has no files list".to_string())?;
    let executable_parent = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    for file in files {
        let relative = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "Runtime manifest entry has no path".to_string())?;
        let expected = file
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| "Runtime manifest entry has no SHA-256".to_string())?;
        let stripped = relative.strip_prefix("resources/").unwrap_or(relative);
        let name = Path::new(relative)
            .file_name()
            .ok_or_else(|| "Runtime manifest contains an invalid path".to_string())?;
        let mut candidates = vec![
            resource_dir.join(relative),
            resource_dir.join(stripped),
            resource_dir.join("resources").join(stripped),
        ];
        if let Some(parent) = &executable_parent {
            if relative.starts_with("binaries/") {
                candidates.push(parent.join("node.exe"));
            } else {
                candidates.push(parent.join(name));
            }
        }
        let resolved = candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| format!("Bundled runtime file is missing: {relative}"))?;
        let actual = crate::storage::file_sha256(&resolved)?;
        if actual != expected {
            return Err(format!(
                "Bundled runtime file failed integrity verification: {relative}"
            ));
        }
    }
    Ok(())
}

fn load_job(
    database: &Connection,
    project_id: &str,
    job_id: &str,
) -> Result<Option<RenderJobView>, String> {
    database
        .query_row(
            r#"
            SELECT id, task_id, project_id, project_revision, status, progress,
                   rendered_frames, encoded_frames, output_path, bytes, sha256,
                   duration_ms, error_message, created_at, updated_at
            FROM render_jobs WHERE id = ?1 AND project_id = ?2
            "#,
            params![job_id, project_id],
            job_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RenderJobView> {
    let status: String = row.get(4)?;
    let percent: f64 = row.get(5)?;
    let stage = match status.as_str() {
        "queued" => "queued",
        "running" => "rendering",
        "canceling" => "canceling",
        "succeeded" => "completed",
        "interrupted" => "interrupted",
        other => other,
    }
    .to_string();
    Ok(RenderJobView {
        id: row.get(0)?,
        task_id: row.get(1)?,
        project_id: row.get(2)?,
        project_revision: row.get(3)?,
        status,
        percent,
        rendered_frames: row.get(6)?,
        encoded_frames: row.get(7)?,
        stage,
        output_path: row.get(8)?,
        bytes: row.get(9)?,
        sha256: row.get(10)?,
        duration_ms: row.get(11)?,
        error: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn probe_duration(ffprobe: Option<&Path>, path: &Path) -> Result<i64, String> {
    let executable = ffprobe.ok_or_else(|| {
        "FFprobe is unavailable; refusing to commit an unverified render".to_string()
    })?;
    let output = Command::new(executable)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("Unable to execute FFprobe: {error}"))?;
    if !output.status.success() {
        return Err("FFprobe could not parse the rendered MP4".to_string());
    }
    let probe: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid FFprobe output: {error}"))?;
    let has_video = probe
        .get("streams")
        .and_then(Value::as_array)
        .is_some_and(|streams| {
            streams.iter().any(|stream| {
                stream.get("codec_type").and_then(Value::as_str) == Some("video")
            })
        });
    if !has_video {
        return Err("Rendered MP4 contains no video stream".to_string());
    }
    let duration = probe
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or_else(|| "FFprobe did not report a duration".to_string())?;
    Ok((duration * 1000.0).round() as i64)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn limited_error(value: &str) -> String {
    logging::redact_text(value).chars().take(4000).collect()
}

fn drain_stderr(mut reader: impl Read, max_bytes: usize) -> String {
    let mut tail = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                tail.extend_from_slice(&buffer[..read]);
                if tail.len() > max_bytes {
                    let drain = tail.len() - max_bytes;
                    tail.drain(..drain);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&tail).to_string()
}

fn hydrate_composition_assets(
    project_root: &Path,
    project_id: &str,
    mut composition: Value,
) -> Result<Value, String> {
    if let Some(assets) = composition.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            let Some(source) = asset.get("src").and_then(Value::as_str) else {
                continue;
            };
            if source.starts_with("data:") || source.starts_with("https://") {
                continue;
            }
            let relative = crate::storage::client_url_to_relative(project_id, source)
                .unwrap_or_else(|| source.to_string());
            if source.starts_with("http://") && !source.starts_with("http://kmasset.localhost/") {
                continue;
            }
            let Some(relative) = crate::storage::safe_relative_path(&relative) else {
                return Err("Composition contains an unsafe asset path".to_string());
            };
            let path = project_root.join(relative);
            let bytes = fs::read(&path)
                .map_err(|error| format!("Unable to load render asset: {error}"))?;
            let mime = match path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str()
            {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "svg" => "image/svg+xml",
                "wav" => "audio/wav",
                "mp3" => "audio/mpeg",
                "mp4" => "video/mp4",
                _ => "application/octet-stream",
            };
            asset["src"] = Value::String(format!(
                "data:{mime};base64,{}",
                BASE64.encode(bytes)
            ));
            if asset.get("mimeType").is_none() {
                asset["mimeType"] = Value::String(mime.to_string());
            }
        }
    }
    let size = serde_json::to_vec(&composition)
        .map_err(|error| error.to_string())?
        .len();
    if size > 120 * 1024 * 1024 {
        return Err("Hydrated render composition exceeds the 120 MB safety limit".to_string());
    }
    Ok(composition)
}

#[tauri::command]
pub fn render_start(
    app: AppHandle,
    manager: State<'_, Arc<RenderManager>>,
    project_id: String,
    composition_json: String,
    project_revision: Option<i64>,
) -> Result<RenderStartResponse, String> {
    manager
        .inner()
        .start(app, &project_id, &composition_json, project_revision)
}

#[tauri::command]
pub fn render_get(
    manager: State<'_, Arc<RenderManager>>,
    project_id: String,
    job_id: String,
) -> Result<RenderJobView, String> {
    manager.get(&project_id, &job_id)
}

#[tauri::command]
pub fn render_list(
    manager: State<'_, Arc<RenderManager>>,
    project_id: String,
    limit: Option<usize>,
) -> Result<Vec<RenderJobView>, String> {
    manager.list(&project_id, limit.unwrap_or(20))
}

#[tauri::command]
pub fn render_cancel(
    app: AppHandle,
    manager: State<'_, Arc<RenderManager>>,
    project_id: String,
    job_id: String,
) -> Result<RenderJobView, String> {
    manager.cancel(&app, &project_id, &job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_content() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("artifact");
        fs::write(&path, b"knowmotion").expect("artifact");
        assert_eq!(
            file_sha256(&path).expect("hash"),
            "f5d2a48734b4c72d549d03b3001e519fadb76409914b528ba30848a46968c197"
        );
    }
}
