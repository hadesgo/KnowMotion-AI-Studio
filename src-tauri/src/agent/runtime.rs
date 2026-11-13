use super::agents::AgentRegistry;
use super::model::{
    AgentInput, AgentModelRoute, ProjectToolCall, ProviderConfig, WorkflowEventPayload,
    WorkflowRunView, WorkflowStartRequest, WorkflowStepView, AGENT_KEYS, WORKFLOW_KEY,
    WORKFLOW_VERSION,
};
use super::provider::resolve_provider;
use super::tools::{apply_agent_changes, list_revisions, undo_revision};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const WORKFLOW_EVENT: &str = "agent-workflow-changed";

pub struct AgentRuntime {
    database: Arc<Mutex<Connection>>,
    projects_root: PathBuf,
    registry: AgentRegistry,
    active_runs: Mutex<HashSet<String>>,
}

impl AgentRuntime {
    pub fn new(database_path: &Path, projects_root: PathBuf) -> Result<Arc<Self>, String> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(&projects_root).map_err(|error| error.to_string())?;
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        initialize_database(&connection)?;
        recover_interrupted_runs(&connection)?;
        Ok(Arc::new(Self {
            database: Arc::new(Mutex::new(connection)),
            projects_root,
            registry: AgentRegistry::new(),
            active_runs: Mutex::new(HashSet::new()),
        }))
    }

    pub fn create_run(
        self: &Arc<Self>,
        app: AppHandle,
        request: WorkflowStartRequest,
    ) -> Result<WorkflowRunView, String> {
        let project_id = request
            .project
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Workflow requires a project with an id".to_string())?
            .to_string();
        if !request.project.is_object() {
            return Err("Workflow project must be a JSON object".to_string());
        }
        let target_agent = request.target_agent.clone();
        if let Some(agent) = target_agent.as_deref() {
            if !AGENT_KEYS.contains(&agent) {
                return Err(format!("Unknown target agent: {agent}"));
            }
        }

        let now = Utc::now().to_rfc3339();
        let run_id = Uuid::new_v4().to_string();
        let providers_json =
            serde_json::to_string(&request.providers).map_err(|error| error.to_string())?;
        let routes_json =
            serde_json::to_string(&request.agent_routes).map_err(|error| error.to_string())?;
        let project_json =
            serde_json::to_string(&request.project).map_err(|error| error.to_string())?;
        let workflow_key = if target_agent.is_some() {
            format!("{WORKFLOW_KEY}.edit")
        } else {
            WORKFLOW_KEY.to_string()
        };
        let max_attempts = request.max_attempts.unwrap_or(2).clamp(1, 5);

        {
            let mut db = self.lock_db()?;
            let transaction = db.transaction().map_err(|error| error.to_string())?;
            transaction
                .execute(
                    r#"
                    INSERT INTO workflow_runs(
                        id, project_id, workflow_key, workflow_version, status,
                        current_step_key, instruction, project_json, providers_json,
                        agent_routes_json, max_attempts, created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                    "#,
                    params![
                        run_id,
                        project_id,
                        workflow_key,
                        WORKFLOW_VERSION,
                        request.instruction,
                        project_json,
                        providers_json,
                        routes_json,
                        max_attempts,
                        now
                    ],
                )
                .map_err(|error| error.to_string())?;

            let descriptors: Vec<_> = if let Some(target) = target_agent.as_deref() {
                vec![self
                    .registry
                    .descriptor(target)
                    .ok_or_else(|| format!("Unknown target agent: {target}"))?
                    .clone()]
            } else {
                self.registry.descriptors().to_vec()
            };
            let direct_dependencies = Vec::<String>::new();
            for (position, descriptor) in descriptors.iter().enumerate() {
                transaction
                    .execute(
                        r#"
                        INSERT INTO workflow_steps(
                            id, run_id, step_key, agent_key, title, description,
                            position, status, attempt, max_attempts, dependencies_json,
                            requires_approval, approval_label, approval_status, updated_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, ?8, ?9, ?10, ?11, 'pending', ?12)
                        "#,
                        params![
                            Uuid::new_v4().to_string(),
                            run_id,
                            descriptor.key,
                            descriptor.key,
                            descriptor.title,
                            descriptor.description,
                            position as i64,
                            max_attempts,
                            serde_json::to_string(if target_agent.is_some() {
                                &direct_dependencies
                            } else {
                                &descriptor.dependencies
                            })
                            .map_err(|error| error.to_string())?,
                            if descriptor.requires_approval { 1 } else { 0 },
                            descriptor.approval_label,
                            now
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
            transaction.commit().map_err(|error| error.to_string())?;
        }

        self.emit_event(
            &app,
            &run_id,
            None,
            "workflow_created",
            if target_agent.is_some() {
                "自然语言增量修改已进入队列"
            } else {
                "完整 Agent 工作流已创建"
            },
            "pending",
        );
        let view = self.get_run(&run_id)?;
        self.spawn_advance(app, run_id);
        Ok(view)
    }

    pub fn get_run(&self, run_id: &str) -> Result<WorkflowRunView, String> {
        let db = self.lock_db()?;
        let run = db
            .query_row(
                r#"
                SELECT id, project_id, workflow_key, status, current_step_key,
                       instruction, error_message, project_json, created_at, updated_at
                FROM workflow_runs WHERE id = ?1
                "#,
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Workflow run not found".to_string())?;
        let project = run
            .7
            .as_deref()
            .and_then(|value| serde_json::from_str::<Value>(value).ok());
        let steps = load_steps(&db, run_id)?;
        let revisions = list_revisions(&db, run_id)?;
        Ok(WorkflowRunView {
            id: run.0,
            project_id: run.1,
            workflow_key: run.2,
            status: run.3,
            current_step_key: run.4,
            instruction: run.5,
            error: run.6,
            created_at: run.8,
            updated_at: run.9,
            project,
            steps,
            revisions,
        })
    }

    pub fn list_runs(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkflowRunView>, String> {
        let ids = {
            let db = self.lock_db()?;
            let mut statement = db
                .prepare(
                    "SELECT id FROM workflow_runs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![project_id, limit.clamp(1, 50) as i64], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        ids.into_iter()
            .map(|id| self.get_run(&id))
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn pause(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: &str,
    ) -> Result<WorkflowRunView, String> {
        {
            let db = self.lock_db()?;
            db.execute(
                r#"
                UPDATE workflow_runs
                SET status = 'paused', updated_at = ?1
                WHERE id = ?2 AND status IN ('running', 'pending')
                "#,
                params![Utc::now().to_rfc3339(), run_id],
            )
            .map_err(|error| error.to_string())?;
        }
        self.emit_event(
            &app,
            run_id,
            None,
            "workflow_paused",
            "工作流将在当前 Agent 完成后暂停",
            "paused",
        );
        self.get_run(run_id)
    }

    pub fn resume(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: &str,
    ) -> Result<WorkflowRunView, String> {
        {
            let db = self.lock_db()?;
            db.execute(
                r#"
                UPDATE workflow_runs
                SET status = 'running', error_code = NULL, error_message = NULL, updated_at = ?1
                WHERE id = ?2 AND status = 'paused'
                "#,
                params![Utc::now().to_rfc3339(), run_id],
            )
            .map_err(|error| error.to_string())?;
        }
        self.emit_event(
            &app,
            run_id,
            None,
            "workflow_resumed",
            "工作流已恢复",
            "running",
        );
        self.spawn_advance(app, run_id.to_string());
        self.get_run(run_id)
    }

    pub fn retry(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: &str,
    ) -> Result<WorkflowRunView, String> {
        let step_key = {
            let db = self.lock_db()?;
            db.query_row(
                r#"
                SELECT step_key FROM workflow_steps
                WHERE run_id = ?1 AND status IN ('failed', 'changes_requested')
                ORDER BY position DESC LIMIT 1
                "#,
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "This run has no failed step to retry".to_string())?
        };
        self.rerun_step(app, run_id, &step_key)
    }

    pub fn rerun_step(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: &str,
        step_key: &str,
    ) -> Result<WorkflowRunView, String> {
        let now = Utc::now().to_rfc3339();
        {
            let mut db = self.lock_db()?;
            let before_project: Option<String> = db
                .query_row(
                    "SELECT before_project_json FROM workflow_steps WHERE run_id = ?1 AND step_key = ?2",
                    params![run_id, step_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .flatten();
            let position: i64 = db
                .query_row(
                    "SELECT position FROM workflow_steps WHERE run_id = ?1 AND step_key = ?2",
                    params![run_id, step_key],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Step not found: {error}"))?;
            let transaction = db.transaction().map_err(|error| error.to_string())?;
            if let Some(project) = before_project {
                transaction
                    .execute(
                        "UPDATE workflow_runs SET project_json = ?1 WHERE id = ?2",
                        params![project, run_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            transaction
                .execute(
                    r#"
                    UPDATE workflow_steps
                    SET status = 'pending', approval_status = 'pending', error_code = NULL,
                        error_message = NULL, output_json = NULL, warnings_json = NULL,
                        started_at = NULL, finished_at = NULL, updated_at = ?1
                    WHERE run_id = ?2 AND position >= ?3
                    "#,
                    params![now, run_id, position],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    r#"
                    UPDATE workflow_runs
                    SET status = 'pending', current_step_key = NULL,
                        error_code = NULL, error_message = NULL, updated_at = ?1
                    WHERE id = ?2
                    "#,
                    params![now, run_id],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
        self.emit_event(
            &app,
            run_id,
            Some(step_key),
            "step_rerun",
            "已从该 Agent 开始局部重跑",
            "pending",
        );
        self.spawn_advance(app, run_id.to_string());
        self.get_run(run_id)
    }

    pub fn approve(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: &str,
        step_key: &str,
        decision: &str,
        note: Option<String>,
    ) -> Result<WorkflowRunView, String> {
        if !matches!(decision, "approve" | "request_changes") {
            return Err("Approval decision must be approve or request_changes".to_string());
        }
        let now = Utc::now().to_rfc3339();
        {
            let db = self.lock_db()?;
            let current_status: String = db
                .query_row(
                    "SELECT status FROM workflow_steps WHERE run_id = ?1 AND step_key = ?2",
                    params![run_id, step_key],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Step not found: {error}"))?;
            if current_status != "waiting_approval" {
                return Err("Step is not waiting for approval".to_string());
            }
            if decision == "approve" {
                db.execute(
                    r#"
                    UPDATE workflow_steps
                    SET status = 'completed', approval_status = 'approved',
                        finished_at = COALESCE(finished_at, ?1), updated_at = ?1
                    WHERE run_id = ?2 AND step_key = ?3
                    "#,
                    params![now, run_id, step_key],
                )
                .map_err(|error| error.to_string())?;
                db.execute(
                    "UPDATE workflow_runs SET status = 'pending', current_step_key = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now, run_id],
                )
                .map_err(|error| error.to_string())?;
            } else {
                db.execute(
                    r#"
                    UPDATE workflow_steps
                    SET status = 'changes_requested', approval_status = 'changes_requested',
                        error_message = ?1, updated_at = ?2
                    WHERE run_id = ?3 AND step_key = ?4
                    "#,
                    params![
                        note.unwrap_or_else(|| "请修改后重新运行该 Agent".to_string()),
                        now,
                        run_id,
                        step_key
                    ],
                )
                .map_err(|error| error.to_string())?;
                db.execute(
                    "UPDATE workflow_runs SET status = 'paused', current_step_key = ?1, updated_at = ?2 WHERE id = ?3",
                    params![step_key, now, run_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        self.emit_event(
            &app,
            run_id,
            Some(step_key),
            if decision == "approve" {
                "step_approved"
            } else {
                "changes_requested"
            },
            if decision == "approve" {
                "审批通过，流程继续"
            } else {
                "已要求修改，等待局部重跑"
            },
            if decision == "approve" {
                "pending"
            } else {
                "paused"
            },
        );
        if decision == "approve" {
            self.spawn_advance(app, run_id.to_string());
        }
        self.get_run(run_id)
    }

    pub fn undo(
        &self,
        app: AppHandle,
        run_id: &str,
        revision_id: &str,
    ) -> Result<WorkflowRunView, String> {
        {
            let mut db = self.lock_db()?;
            undo_revision(&mut db, &self.projects_root, revision_id)?;
        }
        self.emit_event(
            &app,
            run_id,
            None,
            "revision_undone",
            "已恢复修订前的项目快照",
            "paused",
        );
        self.get_run(run_id)
    }

    fn spawn_advance(self: &Arc<Self>, app: AppHandle, run_id: String) {
        {
            let mut active = self
                .active_runs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !active.insert(run_id.clone()) {
                return;
            }
        }
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let error = runtime.advance(app.clone(), run_id.clone()).await.err();
            if let Some(error) = &error {
                let _ = runtime.mark_run_failed(&run_id, error);
                runtime.emit_event(&app, &run_id, None, "workflow_failed", error, "failed");
            }
            if let Ok(mut active) = runtime.active_runs.lock() {
                active.remove(&run_id);
            }
        });
    }

    async fn advance(&self, app: AppHandle, run_id: String) -> Result<(), String> {
        loop {
            let run_status = {
                let db = self.lock_db()?;
                db.query_row(
                    "SELECT status FROM workflow_runs WHERE id = ?1",
                    params![run_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())?
            };
            if matches!(
                run_status.as_str(),
                "paused" | "waiting_approval" | "completed" | "failed"
            ) {
                return Ok(());
            }
            {
                let db = self.lock_db()?;
                db.execute(
                    "UPDATE workflow_runs SET status = 'running', updated_at = ?1 WHERE id = ?2",
                    params![Utc::now().to_rfc3339(), run_id],
                )
                .map_err(|error| error.to_string())?;
            }

            let next = self.claim_next_step(&run_id)?;
            let Some(step) = next else {
                self.finish_if_complete(&app, &run_id)?;
                return Ok(());
            };
            self.emit_event(
                &app,
                &run_id,
                Some(&step.step_key),
                "step_started",
                &format!("{} 正在执行", step.title),
                "running",
            );

            let result = self.execute_step(&app, &run_id, &step).await;
            match result {
                Ok(requires_approval) => {
                    if requires_approval {
                        return Ok(());
                    }
                }
                Err(error) => {
                    self.mark_step_failed(&run_id, &step, &error)?;
                    self.emit_event(
                        &app,
                        &run_id,
                        Some(&step.step_key),
                        "step_failed",
                        &error,
                        "failed",
                    );
                    return Err(error);
                }
            }
        }
    }

    async fn execute_step(
        &self,
        app: &AppHandle,
        run_id: &str,
        step: &StepRow,
    ) -> Result<bool, String> {
        let (project_json, providers_json, routes_json) = {
            let db = self.lock_db()?;
            db.query_row(
                "SELECT project_json, providers_json, agent_routes_json FROM workflow_runs WHERE id = ?1",
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
        };
        let project: Value =
            serde_json::from_str(&project_json).map_err(|error| error.to_string())?;
        let providers: Vec<ProviderConfig> =
            serde_json::from_str(&providers_json).map_err(|error| error.to_string())?;
        let routes: BTreeMap<String, AgentModelRoute> =
            serde_json::from_str(&routes_json).map_err(|error| error.to_string())?;
        let provider_config = routes
            .get(&step.agent_key)
            .and_then(|route| {
                providers
                    .iter()
                    .find(|provider| provider.id == route.provider_id)
            })
            .or_else(|| {
                providers.iter().find(|provider| {
                    provider.enabled
                        && provider
                            .capabilities
                            .iter()
                            .any(|capability| capability == "LLM")
                })
            })
            .cloned()
            .ok_or_else(|| "No enabled LLM Provider is configured for this run".to_string())?;
        let model = routes
            .get(&step.agent_key)
            .and_then(|route| route.model.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| provider_config.model.clone());
        let provider = resolve_provider(&provider_config, Some(model.clone())).await?;

        let dependency_outputs = self.dependency_outputs(run_id, &step.dependencies)?;
        let instruction = {
            let db = self.lock_db()?;
            db.query_row(
                "SELECT instruction FROM workflow_runs WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| error.to_string())?
        };
        let target_scene_ids = extract_target_scene_ids(Some(&project), instruction.as_deref());
        let agent_input = AgentInput {
            project: project.clone(),
            instruction,
            dependency_outputs,
            target_scene_ids: target_scene_ids.clone(),
            agent_key: step.agent_key.clone(),
        };
        let input_json = serde_json::to_string(&agent_input).map_err(|error| error.to_string())?;
        let input_hash = format!("{:x}", Sha256::digest(input_json.as_bytes()));
        {
            let db = self.lock_db()?;
            db.execute(
                r#"
                UPDATE workflow_steps
                SET provider_id = ?1, model = ?2, input_json = ?3, input_hash = ?4,
                    started_at = ?5, updated_at = ?5
                WHERE run_id = ?6 AND step_key = ?7
                "#,
                params![
                    provider_config.id,
                    model,
                    input_json,
                    input_hash,
                    Utc::now().to_rfc3339(),
                    run_id,
                    step.step_key
                ],
            )
            .map_err(|error| error.to_string())?;
        }

        let call_started = std::time::Instant::now();
        let output = self
            .registry
            .execute(&step.agent_key, agent_input, provider.as_ref(), &model)
            .await;
        let latency_ms = call_started.elapsed().as_millis() as i64;
        match &output {
            Ok(_) => {
                self.log_provider_call(ProviderCallRecord {
                    run_id,
                    step_key: &step.step_key,
                    provider_id: &provider_config.id,
                    model: &model,
                    status: "succeeded",
                    latency_ms,
                    error: None,
                })?;
            }
            Err(error) => {
                self.log_provider_call(ProviderCallRecord {
                    run_id,
                    step_key: &step.step_key,
                    provider_id: &provider_config.id,
                    model: &model,
                    status: "failed",
                    latency_ms,
                    error: Some(error),
                })?;
            }
        }
        let output = output?;
        enforce_scene_scope(&output, &target_scene_ids)?;

        {
            let mut db = self.lock_db()?;
            let revision = apply_agent_changes(
                &mut db,
                &self.projects_root,
                run_id,
                &step.step_key,
                &step.project_id,
                &project,
                &output,
            )?;
            let warnings_json =
                serde_json::to_string(&output.warnings).map_err(|error| error.to_string())?;
            let output_json = serde_json::to_string(&json!({
                "summary": output.summary,
                "warnings": output.warnings,
                "needsAttention": output.needs_attention,
                "revision": revision.revision,
                "tools": revision.tools
            }))
            .map_err(|error| error.to_string())?;
            let before_json = project_json;
            let after_json =
                serde_json::to_string(&revision.project).map_err(|error| error.to_string())?;
            let now = Utc::now().to_rfc3339();
            if step.requires_approval {
                db.execute(
                    r#"
                    UPDATE workflow_steps
                    SET status = 'waiting_approval', approval_status = 'pending',
                        output_json = ?1, warnings_json = ?2, before_project_json = ?3,
                        after_project_json = ?4, finished_at = ?5, updated_at = ?5
                    WHERE run_id = ?6 AND step_key = ?7
                    "#,
                    params![
                        output_json,
                        warnings_json,
                        before_json,
                        after_json,
                        now,
                        run_id,
                        step.step_key
                    ],
                )
                .map_err(|error| error.to_string())?;
                db.execute(
                    r#"
                    UPDATE workflow_runs
                    SET status = 'waiting_approval', current_step_key = ?1, updated_at = ?2
                    WHERE id = ?3
                    "#,
                    params![step.step_key, now, run_id],
                )
                .map_err(|error| error.to_string())?;
            } else {
                db.execute(
                    r#"
                    UPDATE workflow_steps
                    SET status = 'completed', output_json = ?1, warnings_json = ?2,
                        before_project_json = ?3, after_project_json = ?4,
                        finished_at = ?5, updated_at = ?5
                    WHERE run_id = ?6 AND step_key = ?7
                    "#,
                    params![
                        output_json,
                        warnings_json,
                        before_json,
                        after_json,
                        now,
                        run_id,
                        step.step_key
                    ],
                )
                .map_err(|error| error.to_string())?;
                db.execute(
                    "UPDATE workflow_runs SET current_step_key = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now, run_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        self.emit_event(
            app,
            run_id,
            Some(&step.step_key),
            if step.requires_approval {
                "step_waiting_approval"
            } else {
                "step_completed"
            },
            if step.requires_approval {
                "Agent 已完成，等待用户审批"
            } else {
                "Agent 完成并根据受控工具更新项目"
            },
            if step.requires_approval {
                "waiting_approval"
            } else {
                "running"
            },
        );
        Ok(step.requires_approval)
    }

    fn claim_next_step(&self, run_id: &str) -> Result<Option<StepRow>, String> {
        let db = self.lock_db()?;
        let steps = load_step_rows(&db, run_id)?;
        let statuses: HashMap<_, _> = steps
            .iter()
            .map(|step| (step.step_key.clone(), step.status.clone()))
            .collect();
        let next = steps.into_iter().find(|step| {
            step.status == "pending"
                && step.dependencies.iter().all(|dependency| {
                    statuses.get(dependency).map(String::as_str) == Some("completed")
                })
        });
        if let Some(step) = &next {
            db.execute(
                r#"
                UPDATE workflow_steps
                SET status = 'running', attempt = attempt + 1, updated_at = ?1
                WHERE id = ?2
                "#,
                params![Utc::now().to_rfc3339(), step.id],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(next)
    }

    fn dependency_outputs(
        &self,
        run_id: &str,
        dependencies: &[String],
    ) -> Result<BTreeMap<String, Value>, String> {
        let db = self.lock_db()?;
        let mut outputs = BTreeMap::new();
        for dependency in dependencies {
            let output: Option<String> = db
                .query_row(
                    "SELECT output_json FROM workflow_steps WHERE run_id = ?1 AND step_key = ?2",
                    params![run_id, dependency],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(output) = output {
                if let Ok(value) = serde_json::from_str(&output) {
                    outputs.insert(dependency.clone(), value);
                }
            }
        }
        Ok(outputs)
    }

    fn finish_if_complete(&self, app: &AppHandle, run_id: &str) -> Result<(), String> {
        let db = self.lock_db()?;
        let statuses = load_step_rows(&db, run_id)?
            .into_iter()
            .map(|step| step.status)
            .collect::<Vec<_>>();
        if statuses.iter().all(|status| status == "completed") {
            db.execute(
                "UPDATE workflow_runs SET status = 'completed', current_step_key = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), run_id],
            )
            .map_err(|error| error.to_string())?;
            drop(db);
            self.emit_event(
                app,
                run_id,
                None,
                "workflow_completed",
                "所有 Agent 与审批节点已完成",
                "completed",
            );
        } else {
            let failed = statuses
                .iter()
                .any(|status| matches!(status.as_str(), "failed" | "changes_requested"));
            if failed {
                return Err("Workflow cannot continue because a step needs retry".to_string());
            }
        }
        Ok(())
    }

    fn mark_step_failed(&self, run_id: &str, step: &StepRow, error: &str) -> Result<(), String> {
        let db = self.lock_db()?;
        let now = Utc::now().to_rfc3339();
        db.execute(
            r#"
            UPDATE workflow_steps
            SET status = 'failed', error_code = 'AGENT_EXECUTION_FAILED',
                error_message = ?1, finished_at = ?2, updated_at = ?2
            WHERE run_id = ?3 AND step_key = ?4
            "#,
            params![error, now, run_id, step.step_key],
        )
        .map_err(|error| error.to_string())?;
        db.execute(
            r#"
            UPDATE workflow_runs
            SET status = 'failed', current_step_key = ?1,
                error_code = 'AGENT_EXECUTION_FAILED', error_message = ?2, updated_at = ?3
            WHERE id = ?4
            "#,
            params![step.step_key, error, now, run_id],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn mark_run_failed(&self, run_id: &str, error: &str) -> Result<(), String> {
        let db = self.lock_db()?;
        db.execute(
            r#"
            UPDATE workflow_runs
            SET status = 'failed', error_code = 'WORKFLOW_EXECUTION_FAILED',
                error_message = ?1, updated_at = ?2
            WHERE id = ?3 AND status NOT IN ('waiting_approval', 'completed')
            "#,
            params![error, Utc::now().to_rfc3339(), run_id],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn log_provider_call(&self, call: ProviderCallRecord<'_>) -> Result<(), String> {
        let db = self.lock_db()?;
        db.execute(
            r#"
            INSERT INTO provider_calls(
                id, run_id, step_key, provider_id, model, status,
                latency_ms, error_message, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                Uuid::new_v4().to_string(),
                call.run_id,
                call.step_key,
                call.provider_id,
                call.model,
                call.status,
                call.latency_ms,
                call.error,
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn emit_event(
        &self,
        app: &AppHandle,
        run_id: &str,
        step_key: Option<&str>,
        kind: &str,
        message: &str,
        run_status: &str,
    ) {
        let payload = WorkflowEventPayload {
            event_id: Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
            step_key: step_key.map(str::to_string),
            kind: kind.to_string(),
            message: message.to_string(),
            run_status: run_status.to_string(),
            at: Utc::now().to_rfc3339(),
        };
        if let Ok(db) = self.lock_db() {
            let _ = db.execute(
                r#"
                INSERT INTO workflow_events(id, run_id, step_key, kind, message, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    payload.event_id,
                    payload.run_id,
                    payload.step_key,
                    payload.kind,
                    payload.message,
                    payload.at
                ],
            );
        }
        let _ = app.emit(WORKFLOW_EVENT, payload);
    }

    fn lock_db(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.database
            .lock()
            .map_err(|_| "Agent database lock is unavailable".to_string())
    }
}

struct ProviderCallRecord<'a> {
    run_id: &'a str,
    step_key: &'a str,
    provider_id: &'a str,
    model: &'a str,
    status: &'a str,
    latency_ms: i64,
    error: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct StepRow {
    id: String,
    project_id: String,
    step_key: String,
    agent_key: String,
    title: String,
    status: String,
    requires_approval: bool,
    dependencies: Vec<String>,
}

fn extract_target_scene_ids(project: Option<&Value>, instruction: Option<&str>) -> Vec<String> {
    let Some(project) = project else {
        return Vec::new();
    };
    let Some(instruction) = instruction.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let scenes = project
        .get("scenes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if scenes.is_empty() {
        return Vec::new();
    }
    let chinese = [
        "第一", "第二", "第三", "第四", "第五", "第六", "第七", "第八", "第九", "第十",
    ];
    let mut target_indices = Vec::new();
    for (index, word) in chinese.iter().enumerate() {
        if instruction.contains(word) {
            target_indices.push(index);
        }
    }
    for index in 1..=10 {
        let markers = [
            format!("第{index}"),
            format!("scene {index}"),
            format!("scene{index}"),
        ];
        if markers.iter().any(|marker| {
            instruction
                .to_ascii_lowercase()
                .contains(&marker.to_ascii_lowercase())
        }) {
            target_indices.push(index - 1);
        }
    }
    if instruction.contains("最后一个场景")
        || instruction.to_ascii_lowercase().contains("last scene")
    {
        target_indices.push(scenes.len() - 1);
    }
    target_indices.sort_unstable();
    target_indices.dedup();
    target_indices
        .into_iter()
        .filter_map(|index| {
            scenes
                .get(index)
                .and_then(|scene| scene.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn enforce_scene_scope(
    output: &super::model::AgentOutput,
    target_ids: &[String],
) -> Result<(), String> {
    if target_ids.is_empty() {
        return Ok(());
    }
    for change in &output.changes {
        if let ProjectToolCall::PatchScenes(input) = change {
            for scene in &input.scenes {
                let scene_id = scene.get("id").and_then(Value::as_str).unwrap_or_default();
                if !target_ids.iter().any(|target| target == scene_id) {
                    return Err(format!(
                        "Agent attempted to patch a scene outside the requested scope: {scene_id}"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS workflow_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                workflow_key TEXT NOT NULL,
                workflow_version TEXT NOT NULL,
                status TEXT NOT NULL,
                current_step_key TEXT,
                instruction TEXT,
                project_json TEXT NOT NULL,
                providers_json TEXT NOT NULL,
                agent_routes_json TEXT NOT NULL,
                max_attempts INTEGER NOT NULL DEFAULT 2,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_steps (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                step_key TEXT NOT NULL,
                agent_key TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                position INTEGER NOT NULL,
                status TEXT NOT NULL,
                attempt INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 2,
                dependencies_json TEXT NOT NULL,
                requires_approval INTEGER NOT NULL DEFAULT 0,
                approval_label TEXT,
                approval_status TEXT NOT NULL DEFAULT 'pending',
                provider_id TEXT,
                model TEXT,
                input_hash TEXT,
                input_json TEXT,
                output_json TEXT,
                warnings_json TEXT,
                before_project_json TEXT,
                after_project_json TEXT,
                error_code TEXT,
                error_message TEXT,
                started_at TEXT,
                finished_at TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, step_key)
            );

            CREATE TABLE IF NOT EXISTS project_revisions (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                step_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                summary TEXT NOT NULL,
                before_json TEXT NOT NULL,
                after_json TEXT NOT NULL,
                undoable INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_events (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                step_key TEXT,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                data_json TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS provider_calls (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                step_key TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                status TEXT NOT NULL,
                latency_ms INTEGER NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                error_message TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_workflow_runs_project
                ON workflow_runs(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_workflow_steps_run
                ON workflow_steps(run_id, position, status);
            CREATE INDEX IF NOT EXISTS idx_project_revisions_run
                ON project_revisions(run_id, revision DESC);
            CREATE INDEX IF NOT EXISTS idx_provider_calls_run
                ON provider_calls(run_id, created_at DESC);
            "#,
        )
        .map_err(|error| error.to_string())
}

fn recover_interrupted_runs(connection: &Connection) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            r#"
            UPDATE workflow_steps
            SET status = 'pending', updated_at = ?1
            WHERE status = 'running'
            "#,
            params![now],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            UPDATE workflow_runs
            SET status = 'paused', error_code = 'APP_RESTARTED',
                error_message = '应用曾关闭，工作流已安全暂停。可恢复或在失败步骤重试。',
                updated_at = ?1
            WHERE status IN ('running', 'pending')
            "#,
            params![now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_step_rows(connection: &Connection, run_id: &str) -> Result<Vec<StepRow>, String> {
    let project_id = connection
        .query_row(
            "SELECT project_id FROM workflow_runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, step_key, agent_key, title, status,
                   requires_approval, dependencies_json
            FROM workflow_steps WHERE run_id = ?1 ORDER BY position ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            let dependencies_json: String = row.get(6)?;
            Ok(StepRow {
                id: row.get(0)?,
                project_id: project_id.clone(),
                step_key: row.get(1)?,
                agent_key: row.get(2)?,
                title: row.get(3)?,
                status: row.get(4)?,
                requires_approval: row.get::<_, i64>(5)? == 1,
                dependencies: serde_json::from_str(&dependencies_json).unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_steps(connection: &Connection, run_id: &str) -> Result<Vec<WorkflowStepView>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, step_key, title, description, status, attempt, max_attempts,
                   dependencies_json, requires_approval, approval_label, approval_status,
                   provider_id, model, output_json, warnings_json, error_message,
                   started_at, finished_at
            FROM workflow_steps WHERE run_id = ?1 ORDER BY position ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            let dependencies_json: String = row.get(7)?;
            let output_json = row.get::<_, Option<String>>(13)?;
            let output: Option<Value> = output_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok());
            let warnings_json = row.get::<_, Option<String>>(14)?;
            let warnings = warnings_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
                .unwrap_or_default();
            Ok(WorkflowStepView {
                id: row.get(0)?,
                key: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                status: row.get(4)?,
                attempt: row.get::<_, i64>(5)? as u32,
                max_attempts: row.get::<_, i64>(6)? as u32,
                dependencies: serde_json::from_str(&dependencies_json).unwrap_or_default(),
                requires_approval: row.get::<_, i64>(8)? == 1,
                approval_label: row.get(9)?,
                approval_status: row.get(10)?,
                provider_id: row.get(11)?,
                model: row.get(12)?,
                summary: output
                    .as_ref()
                    .and_then(|value| value.get("summary"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                warnings,
                error: row.get(15)?,
                started_at: row.get(16)?,
                finished_at: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_recovery_pauses_running_workflows() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("studio.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        initialize_database(&connection).expect("initialize schema");
        connection
            .execute(
                r#"
                INSERT INTO workflow_runs(
                    id, project_id, workflow_key, workflow_version, status,
                    current_step_key, instruction, project_json, providers_json,
                    agent_routes_json, max_attempts, created_at, updated_at
                ) VALUES ('run-1', 'project-1', 'test', '1.0', 'running',
                          'research', NULL, '{}', '[]', '{}', 2, 'now', 'now')
                "#,
                [],
            )
            .expect("insert run");
        connection
            .execute(
                r#"
                INSERT INTO workflow_steps(
                    id, run_id, step_key, agent_key, title, description, position,
                    status, attempt, max_attempts, dependencies_json,
                    requires_approval, approval_status, updated_at
                ) VALUES ('step-1', 'run-1', 'research', 'research', 'Research',
                          'Research context', 0, 'running', 1, 2, '[]', 0, 'pending', 'now')
                "#,
                [],
            )
            .expect("insert step");

        recover_interrupted_runs(&connection).expect("recover");

        let run_status: String = connection
            .query_row(
                "SELECT status FROM workflow_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("run status");
        let step_status: String = connection
            .query_row(
                "SELECT status FROM workflow_steps WHERE id = 'step-1'",
                [],
                |row| row.get(0),
            )
            .expect("step status");
        assert_eq!(run_status, "paused");
        assert_eq!(step_status, "pending");
    }

    #[test]
    fn natural_language_scene_scope_is_enforced() {
        let project = json!({
            "scenes": [
                {"id": "scene-1"},
                {"id": "scene-2"},
                {"id": "scene-3"}
            ]
        });
        assert_eq!(
            extract_target_scene_ids(Some(&project), Some("把第二个场景的动画改得更有趣")),
            vec!["scene-2".to_string()]
        );
        assert_eq!(
            extract_target_scene_ids(Some(&project), Some("change scene 3 to be faster")),
            vec!["scene-3".to_string()]
        );
        let output = super::super::model::AgentOutput {
            summary: "animation".to_string(),
            changes: vec![ProjectToolCall::PatchScenes(
                super::super::model::ScenesInput {
                    scenes: vec![json!({"id": "scene-1"}), json!({"id": "scene-2"})],
                },
            )],
            warnings: vec![],
            needs_attention: false,
        };
        assert!(enforce_scene_scope(&output, &["scene-2".to_string()]).is_err());
    }
}
