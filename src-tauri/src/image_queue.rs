use crate::{
    capabilities::{self, ImageGenerationRequest},
    logging,
    logging::LogLevel,
    safe_identifier,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

pub const IMAGE_JOB_EVENT: &str = "image.job.changed";
const QUEUE_CONCURRENCY: usize = 2;
const MAX_BATCH_SIZE: usize = 24;
const MAX_QUEUE_DEPTH: usize = 64;
const MAX_LIST_LIMIT: i64 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJobView {
    pub id: String,
    pub task_id: String,
    pub project_id: String,
    pub scene_id: String,
    pub status: String,
    pub provider_name: String,
    pub anchor_label: String,
    pub prompt_excerpt: String,
    pub count: i64,
    pub attempt: i64,
    pub max_attempts: i64,
    pub assets: Vec<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageJobEvent {
    event_id: String,
    change: String,
    job: ImageJobView,
    at: String,
}

struct ClaimedJob {
    id: String,
    task_id: String,
    request_json: String,
    attempt: i64,
    max_attempts: i64,
}

pub struct ImageQueue {
    database: Arc<Mutex<Connection>>,
    projects_root: PathBuf,
    app: AppHandle,
    permits: Arc<Semaphore>,
    canceled: Arc<Mutex<HashSet<String>>>,
}

impl ImageQueue {
    pub fn new(
        database: Arc<Mutex<Connection>>,
        projects_root: PathBuf,
        app: &AppHandle,
    ) -> Result<Arc<Self>, String> {
        let queue = Arc::new(Self {
            database,
            projects_root,
            app: app.clone(),
            permits: Arc::new(Semaphore::new(QUEUE_CONCURRENCY)),
            canceled: Arc::new(Mutex::new(HashSet::new())),
        });
        queue.recover_interrupted()?;
        let worker = queue.clone();
        tauri::async_runtime::spawn(async move { worker.run().await });
        Ok(queue)
    }

    /// 应用重启时，正在运行的任务无法确认结果，统一转为 interrupted 等待人工重试；
    /// 尚未开始的 pending 任务保留，继续排队。
    fn recover_interrupted(&self) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let database = self
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        database
            .execute(
                r#"
                UPDATE image_jobs
                   SET status = 'interrupted',
                       error_message = 'Application exited before the job finished',
                       finished_at = ?1,
                       updated_at = ?1
                 WHERE status = 'running'
                "#,
                params![now],
            )
            .map_err(|error| error.to_string())?;
        database
            .execute(
                r#"
                UPDATE tasks
                   SET status = 'interrupted', updated_at = ?1
                 WHERE kind = 'image' AND status = 'running'
                "#,
                params![now],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    async fn run(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_millis(600)).await;
            loop {
                let permit = match self.permits.clone().acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => return,
                };
                let claimed = match self.claim_next() {
                    Ok(Some(job)) => job,
                    Ok(None) => {
                        drop(permit);
                        break;
                    }
                    Err(error) => {
                        drop(permit);
                        logging::log_event(
                            LogLevel::Error,
                            "image.queue",
                            "Unable to claim an image job",
                            Some(json!({ "error": error })),
                        );
                        break;
                    }
                };
                let worker = self.clone();
                tauri::async_runtime::spawn(async move {
                    worker.execute(claimed).await;
                    drop(permit);
                });
            }
        }
    }

    fn claim_next(&self) -> Result<Option<ClaimedJob>, String> {
        let now = Utc::now().to_rfc3339();
        let mut database = self
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        let transaction = database.transaction().map_err(|error| error.to_string())?;
        let candidate = transaction
            .query_row(
                r#"
                SELECT id, task_id, request_json, attempt, max_attempts
                  FROM image_jobs
                 WHERE status = 'pending'
                 ORDER BY created_at ASC
                 LIMIT 1
                "#,
                [],
                |row| {
                    Ok(ClaimedJob {
                        id: row.get(0)?,
                        task_id: row.get(1)?,
                        request_json: row.get(2)?,
                        attempt: row.get(3)?,
                        max_attempts: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(job) = candidate else {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(None);
        };
        let updated = transaction
            .execute(
                r#"
                UPDATE image_jobs
                   SET status = 'running', attempt = attempt + 1,
                       started_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND status = 'pending'
                "#,
                params![job.id, now],
            )
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(None);
        }
        transaction
            .execute(
                "UPDATE tasks SET status = 'running', attempt = attempt + 1, updated_at = ?2 WHERE id = ?1",
                params![job.task_id, now],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.emit("started", &job.id);
        Ok(Some(ClaimedJob {
            attempt: job.attempt + 1,
            ..job
        }))
    }

    async fn execute(&self, job: ClaimedJob) {
        if self.is_canceled(&job.id) {
            self.finish_canceled(&job.id);
            return;
        }
        let request: ImageGenerationRequest = match serde_json::from_str(&job.request_json) {
            Ok(request) => request,
            Err(error) => {
                self.finish_failed(
                    &job.id,
                    &format!("Stored image request is invalid: {error}"),
                );
                return;
            }
        };
        let result =
            capabilities::execute_image_generation(&self.projects_root, &self.database, request)
                .await;
        match result {
            Ok(result) => {
                if self.is_canceled(&job.id) {
                    self.finish_canceled(&job.id);
                    logging::log_event(
                        LogLevel::Info,
                        "image.queue",
                        "Discarded a canceled image job result",
                        Some(json!({ "jobId": job.id })),
                    );
                    return;
                }
                let asset_ids = result
                    .assets
                    .iter()
                    .filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect::<Vec<_>>();
                let payload = json!({
                    "assets": result.assets,
                    "providerId": result.provider_id,
                    "model": result.model,
                    "elapsedMs": result.elapsed_ms,
                    "referenceMode": result.reference_mode,
                    "referenceCount": result.reference_count,
                    "seed": result.seed,
                });
                if let Err(error) = self.finish_completed(&job.id, &payload, &asset_ids) {
                    self.finish_failed(&job.id, &error);
                }
            }
            Err(error) => {
                if self.is_canceled(&job.id) {
                    self.finish_canceled(&job.id);
                    return;
                }
                let retryable = is_retryable(&error);
                if retryable && job.attempt < job.max_attempts {
                    self.requeue(&job.id, &error);
                } else {
                    self.finish_failed(&job.id, &error);
                }
            }
        }
    }

    fn finish_completed(
        &self,
        job_id: &str,
        payload: &Value,
        asset_ids: &[String],
    ) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let mut database = self
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        let transaction = database.transaction().map_err(|error| error.to_string())?;
        let task_id: String = transaction
            .query_row(
                "SELECT task_id FROM image_jobs WHERE id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                r#"
                UPDATE image_jobs
                   SET status = 'completed', progress = 1, result_json = ?2,
                       asset_ids_json = ?3, error_code = NULL, error_message = NULL,
                       finished_at = ?4, updated_at = ?4
                 WHERE id = ?1
                "#,
                params![
                    job_id,
                    serde_json::to_string(payload).map_err(|error| error.to_string())?,
                    serde_json::to_string(asset_ids).map_err(|error| error.to_string())?,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE tasks SET status = 'completed', progress = 1, updated_at = ?2 WHERE id = ?1",
                params![task_id, now],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        logging::log_event(
            LogLevel::Info,
            "image.queue",
            "Image job completed",
            Some(json!({ "jobId": job_id, "assets": asset_ids.len() })),
        );
        self.emit("completed", job_id);
        Ok(())
    }

    fn finish_failed(&self, job_id: &str, error: &str) {
        let now = Utc::now().to_rfc3339();
        let message = truncate(error, 2000);
        if let Ok(database) = self.database.lock() {
            let _ = database.execute(
                r#"
                UPDATE image_jobs
                   SET status = 'failed', error_code = 'IMAGE_JOB_FAILED',
                       error_message = ?2, finished_at = ?3, updated_at = ?3
                 WHERE id = ?1
                "#,
                params![job_id, message, now],
            );
            if let Ok(Some(task_id)) = database
                .query_row(
                    "SELECT task_id FROM image_jobs WHERE id = ?1",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                let _ = database.execute(
                    "UPDATE tasks SET status = 'failed', error_message = ?2, updated_at = ?3 WHERE id = ?1",
                    params![task_id, message, now],
                );
            }
        }
        logging::log_event(
            LogLevel::Warn,
            "image.queue",
            "Image job failed",
            Some(json!({ "jobId": job_id, "error": message })),
        );
        self.emit("failed", job_id);
    }

    fn finish_canceled(&self, job_id: &str) {
        self.canceled.lock().map(|mut set| set.remove(job_id)).ok();
        let now = Utc::now().to_rfc3339();
        if let Ok(database) = self.database.lock() {
            let _ = database.execute(
                r#"
                UPDATE image_jobs
                   SET status = 'canceled', finished_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND status != 'completed'
                "#,
                params![job_id, now],
            );
            if let Ok(Some(task_id)) = database
                .query_row(
                    "SELECT task_id FROM image_jobs WHERE id = ?1",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                let _ = database.execute(
                    "UPDATE tasks SET status = 'canceled', updated_at = ?2 WHERE id = ?1",
                    params![task_id, now],
                );
            }
        }
        self.emit("canceled", job_id);
    }

    fn requeue(&self, job_id: &str, error: &str) {
        let now = Utc::now().to_rfc3339();
        if let Ok(database) = self.database.lock() {
            let _ = database.execute(
                r#"
                UPDATE image_jobs
                   SET status = 'pending', started_at = NULL,
                       error_message = ?2, updated_at = ?3
                 WHERE id = ?1
                "#,
                params![job_id, truncate(error, 1000), now],
            );
            if let Ok(task_id) = database
                .query_row(
                    "SELECT task_id FROM image_jobs WHERE id = ?1",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map(|value| value.unwrap_or_default())
            {
                let _ = database.execute(
                    "UPDATE tasks SET status = 'pending', updated_at = ?2 WHERE id = ?1",
                    params![task_id, now],
                );
            }
        }
        logging::log_event(
            LogLevel::Info,
            "image.queue",
            "Image job scheduled for retry",
            Some(json!({ "jobId": job_id, "error": truncate(error, 500) })),
        );
        self.emit("queued", job_id);
    }

    fn is_canceled(&self, job_id: &str) -> bool {
        self.canceled
            .lock()
            .map(|set| set.contains(job_id))
            .unwrap_or(false)
    }

    fn emit(&self, change: &str, job_id: &str) {
        let job = match self.view(job_id) {
            Ok(Some(job)) => job,
            _ => return,
        };
        let payload = ImageJobEvent {
            event_id: Uuid::new_v4().to_string(),
            change: change.to_string(),
            job,
            at: Utc::now().to_rfc3339(),
        };
        if let Err(error) = self.app.emit(IMAGE_JOB_EVENT, payload) {
            logging::log_event(
                LogLevel::Warn,
                "image.queue",
                "Unable to emit image job event",
                Some(json!({ "jobId": job_id, "error": error.to_string() })),
            );
        }
    }

    pub fn view(&self, job_id: &str) -> Result<Option<ImageJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "Database lock is unavailable".to_string())?;
        database
            .query_row(
                r#"
                SELECT id, task_id, project_id, scene_id, status, provider_name,
                       anchor_label, request_json, result_json, attempt, max_attempts,
                       error_message, created_at, updated_at, started_at, finished_at
                  FROM image_jobs WHERE id = ?1
                "#,
                params![job_id],
                row_to_view,
            )
            .optional()
            .map_err(|error| error.to_string())
    }
}

fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageJobView> {
    let request_json: String = row.get(7)?;
    let result_json: Option<String> = row.get(8)?;
    let request: Value = serde_json::from_str(&request_json).unwrap_or(Value::Null);
    let result: Value = result_json
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    Ok(ImageJobView {
        id: row.get(0)?,
        task_id: row.get(1)?,
        project_id: row.get(2)?,
        scene_id: row.get(3)?,
        status: row.get(4)?,
        provider_name: row.get(5)?,
        anchor_label: row.get(6)?,
        prompt_excerpt: truncate(
            request
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            180,
        ),
        count: request.get("count").and_then(Value::as_i64).unwrap_or(1),
        attempt: row.get(9)?,
        max_attempts: row.get(10)?,
        assets: result
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        error: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        started_at: row.get(14)?,
        finished_at: row.get(15)?,
    })
}

fn is_retryable(error: &str) -> bool {
    let lowered = error.to_lowercase();
    [
        "timed out",
        "timeout",
        "429",
        "500",
        "502",
        "503",
        "504",
        "connection",
        "network",
        "temporarily",
        "unavailable",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>() + "…"
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[tauri::command]
pub async fn enqueue_image_jobs(
    state: State<'_, crate::AppState>,
    queue: State<'_, Arc<ImageQueue>>,
    requests: Vec<ImageGenerationRequest>,
) -> Result<Vec<ImageJobView>, String> {
    if requests.is_empty() {
        return Err("Batch request is empty".to_string());
    }
    if requests.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "A batch can contain at most {MAX_BATCH_SIZE} image jobs"
        ));
    }
    for request in &requests {
        if !safe_identifier(&request.project_id) || !safe_identifier(&request.scene_id) {
            return Err("Invalid project or scene id in batch request".to_string());
        }
        if request.prompt.trim().is_empty() {
            return Err("Every queued job needs a prompt".to_string());
        }
        if !request.provider.enabled {
            return Err("The selected image provider is disabled".to_string());
        }
        if !request
            .provider
            .capabilities
            .iter()
            .any(|capability| capability == "Image")
        {
            return Err("The selected provider does not declare Image capability".to_string());
        }
    }
    let project_ids = requests
        .iter()
        .map(|request| request.project_id.clone())
        .collect::<HashSet<_>>();
    if project_ids.len() != 1 {
        return Err("A batch must belong to a single project".to_string());
    }

    let mut database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let active: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM image_jobs WHERE status IN ('pending', 'running')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if active as usize + requests.len() > MAX_QUEUE_DEPTH {
        return Err(format!(
            "Image queue is full ({active} active jobs, limit {MAX_QUEUE_DEPTH})"
        ));
    }

    let now = now_iso();
    let mut created = Vec::new();
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    for request in &requests {
        let job_id = Uuid::new_v4().to_string();
        let task_id = Uuid::new_v4().to_string();
        let request_json = serde_json::to_string(request).map_err(|error| error.to_string())?;
        transaction
            .execute(
                r#"
                INSERT INTO image_jobs(
                    id, task_id, project_id, scene_id, status, progress,
                    provider_id, provider_name, anchor_label, request_json,
                    asset_ids_json, attempt, max_attempts, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?7, ?8, '[]', 0, 2, ?9, ?9)
                "#,
                params![
                    job_id,
                    task_id,
                    request.project_id,
                    request.scene_id,
                    request.provider.id,
                    request.provider.name,
                    request.anchor_label,
                    request_json,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                r#"
                INSERT INTO tasks(
                    id, project_id, kind, status, priority, progress,
                    payload_ref, attempt, max_attempts, idempotency_key,
                    created_at, updated_at
                ) VALUES (?1, ?2, 'image', 'pending', 0, 0, ?3, 0, 2, ?4, ?5, ?5)
                "#,
                params![
                    task_id,
                    request.project_id,
                    format!("image_jobs/{job_id}"),
                    format!("image/{job_id}"),
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        created.push(job_id);
    }
    transaction.commit().map_err(|error| error.to_string())?;
    drop(database);

    let mut views = Vec::new();
    for job_id in created {
        if let Some(view) = queue.view(&job_id)? {
            views.push(view);
        }
    }
    for job in &views {
        queue.emit("queued", &job.id);
    }
    logging::log_event(
        LogLevel::Info,
        "image.queue",
        "Image jobs enqueued",
        Some(json!({ "jobs": views.len(), "projectId": views.first().map(|job| &job.project_id) })),
    );
    Ok(views)
}

#[tauri::command]
pub fn list_image_jobs(
    state: State<'_, crate::AppState>,
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ImageJobView>, String> {
    let limit = limit.unwrap_or(60).clamp(1, MAX_LIST_LIMIT);
    let database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let mut statement = database
        .prepare(
            r#"
            SELECT id, task_id, project_id, scene_id, status, provider_name,
                   anchor_label, request_json, result_json, attempt, max_attempts,
                   error_message, created_at, updated_at, started_at, finished_at
              FROM image_jobs
             WHERE (?1 IS NULL OR project_id = ?1)
             ORDER BY created_at DESC
             LIMIT ?2
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id, limit], row_to_view)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_image_job(queue: State<'_, Arc<ImageQueue>>, job_id: String) -> Result<(), String> {
    if !safe_identifier(&job_id) {
        return Err("Invalid image job id".to_string());
    }
    let database = queue
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let status: Option<String> = database
        .query_row(
            "SELECT status FROM image_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(status) = status else {
        return Err("Image job was not found".to_string());
    };
    if matches!(status.as_str(), "completed" | "failed" | "canceled") {
        return Ok(());
    }
    if status == "running" {
        queue
            .canceled
            .lock()
            .map_err(|_| "Image queue lock is unavailable".to_string())?
            .insert(job_id.clone());
    }
    database
        .execute(
            r#"
            UPDATE image_jobs
               SET status = 'canceled', finished_at = ?2, updated_at = ?2
             WHERE id = ?1 AND status IN ('pending', 'running')
            "#,
            params![job_id, now_iso()],
        )
        .map_err(|error| error.to_string())?;
    drop(database);
    queue.emit("canceled", &job_id);
    Ok(())
}

#[tauri::command]
pub fn retry_image_job(queue: State<'_, Arc<ImageQueue>>, job_id: String) -> Result<(), String> {
    let database = queue
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let updated = database
        .execute(
            r#"
            UPDATE image_jobs
               SET status = 'pending', attempt = 0, progress = 0,
                   error_code = NULL, error_message = NULL,
                   started_at = NULL, finished_at = NULL, updated_at = ?2
             WHERE id = ?1 AND status IN ('failed', 'canceled', 'interrupted')
            "#,
            params![job_id, now_iso()],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Only failed, canceled or interrupted jobs can be retried".to_string());
    }
    if let Ok(task_id) = database
        .query_row(
            "SELECT task_id FROM image_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map(|value| value.unwrap_or_default())
    {
        let _ = database.execute(
            "UPDATE tasks SET status = 'pending', attempt = 0, error_message = NULL, updated_at = ?2 WHERE id = ?1",
            params![task_id, now_iso()],
        );
    }
    drop(database);
    queue
        .canceled
        .lock()
        .map(|mut set| set.remove(&job_id))
        .ok();
    queue.emit("queued", &job_id);
    Ok(())
}

#[tauri::command]
pub fn clear_image_jobs(
    state: State<'_, crate::AppState>,
    project_id: String,
) -> Result<usize, String> {
    if !safe_identifier(&project_id) {
        return Err("Invalid project id".to_string());
    }
    let mut database = state
        .database
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let task_ids = {
        let mut statement = transaction
            .prepare(
                r#"
                SELECT task_id FROM image_jobs
                 WHERE project_id = ?1
                   AND status IN ('completed', 'failed', 'canceled', 'interrupted')
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?
    };
    let removed = transaction
        .execute(
            r#"
            DELETE FROM image_jobs
             WHERE project_id = ?1
               AND status IN ('completed', 'failed', 'canceled', 'interrupted')
            "#,
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    for task_id in task_ids {
        let _ = transaction.execute("DELETE FROM tasks WHERE id = ?1", params![task_id]);
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_errors_cover_network_and_rate_limits() {
        assert!(is_retryable("Image provider returned 503: busy"));
        assert!(is_retryable("request timed out"));
        assert!(!is_retryable("Image prompt cannot be empty"));
        assert!(!is_retryable(
            "The selected provider does not declare Image capability"
        ));
    }

    #[test]
    fn truncate_keeps_character_boundaries() {
        assert_eq!(truncate("知识动画", 2), "知识…");
        assert_eq!(truncate("ok", 5), "ok");
    }
}
