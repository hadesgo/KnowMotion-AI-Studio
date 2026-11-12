mod agents;
mod model;
mod provider;
pub(crate) mod runtime;
mod tools;

use model::{
    ProviderTestRequest, ProviderTestResult, WorkflowDefinition, WorkflowRunView,
    WorkflowStartRequest,
};
use runtime::AgentRuntime;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub use model::workflow_definition;

#[tauri::command]
pub fn agent_workflow_definition() -> WorkflowDefinition {
    workflow_definition()
}

#[tauri::command]
pub fn workflow_start(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    request: WorkflowStartRequest,
) -> Result<WorkflowRunView, String> {
    runtime.inner().create_run(app, request)
}

#[tauri::command]
pub fn workflow_get(
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.get_run(&run_id)
}

#[tauri::command]
pub fn workflow_list(
    runtime: State<'_, Arc<AgentRuntime>>,
    project_id: String,
    limit: Option<usize>,
) -> Result<Vec<WorkflowRunView>, String> {
    runtime.list_runs(&project_id, limit.unwrap_or(20))
}

#[tauri::command]
pub fn workflow_pause(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().pause(app, &run_id)
}

#[tauri::command]
pub fn workflow_resume(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().resume(app, &run_id)
}

#[tauri::command]
pub fn workflow_retry(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().retry(app, &run_id)
}

#[tauri::command]
pub fn workflow_rerun_step(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
    step_key: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().rerun_step(app, &run_id, &step_key)
}

#[tauri::command]
pub fn workflow_approve(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
    step_key: String,
    decision: String,
    note: Option<String>,
) -> Result<WorkflowRunView, String> {
    runtime
        .inner()
        .approve(app, &run_id, &step_key, &decision, note)
}

#[tauri::command]
pub fn workflow_undo_revision(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
    revision_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().undo(app, &run_id, &revision_id)
}

#[tauri::command]
pub fn provider_save_secret(provider_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    provider::save_provider_secret(&provider_id, api_key.trim())
}

#[tauri::command]
pub fn provider_clear_secret(provider_id: String) -> Result<(), String> {
    provider::clear_provider_secret(&provider_id)
}

#[tauri::command]
pub async fn provider_test(request: ProviderTestRequest) -> Result<ProviderTestResult, String> {
    provider::test_provider(request.provider).await
}
