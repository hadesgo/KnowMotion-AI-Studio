mod agents;
mod gguf;
pub(crate) mod model;
mod provider;
pub(crate) mod runtime;
mod tools;

use model::{ProviderTestRequest, ProviderTestResult, WorkflowDefinition, WorkflowRunView};
use std::sync::Arc;
use tauri::{AppHandle, State};

pub(crate) use gguf::{embed_with_local_runtime, embedding_vectors_from_payload};
pub use model::workflow_definition;
pub(crate) use model::WorkflowStartRequest;
#[cfg(test)]
pub(crate) use model::{AgentModelRoute, ProviderConfig};
pub(crate) use provider::get_provider_secret;
#[cfg(test)]
pub(crate) use provider::{
    clear_provider_secret, resolve_provider, save_provider_secret, LlmRequest,
};
pub(crate) use runtime::AgentRuntime;
#[cfg(test)]
pub(crate) use runtime::WorkflowEventSink;

pub(crate) fn configure_llama_runtime(resource_dir: std::path::PathBuf) {
    gguf::configure_runtime(resource_dir);
}

pub(crate) fn shutdown_llama_runtime() {
    gguf::shutdown_runtime();
}

pub(crate) fn unload_idle_llama_runtime(max_idle: std::time::Duration) -> usize {
    gguf::unload_idle(max_idle)
}

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
    runtime.inner().create_run(Arc::new(app), request)
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
    runtime.inner().pause(Arc::new(app), &run_id)
}

#[tauri::command]
pub fn workflow_resume(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().resume(Arc::new(app), &run_id)
}

#[tauri::command]
pub fn workflow_retry(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().retry(Arc::new(app), &run_id)
}

#[tauri::command]
pub fn workflow_rerun_step(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
    step_key: String,
) -> Result<WorkflowRunView, String> {
    runtime
        .inner()
        .rerun_step(Arc::new(app), &run_id, &step_key)
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
        .approve(Arc::new(app), &run_id, &step_key, &decision, note)
}

#[tauri::command]
pub fn workflow_undo_revision(
    app: AppHandle,
    runtime: State<'_, Arc<AgentRuntime>>,
    run_id: String,
    revision_id: String,
) -> Result<WorkflowRunView, String> {
    runtime.inner().undo(Arc::new(app), &run_id, &revision_id)
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
    let provider = request.provider;
    let started = std::time::Instant::now();
    let result = provider::test_provider(provider.clone()).await;
    if let Err(error) = &result {
        // 失败原因以前只在 UI toast 里出现，关掉窗口就查不到了。这里落一条结构化日志，
        // 让「模型都下好了为什么还检测失败」能直接从日志读出协议、能力与根因。
        crate::logging::log_event(
            crate::logging::LogLevel::Warn,
            "provider.test",
            "Provider connection test failed",
            Some(serde_json::json!({
                "providerId": provider.id,
                "protocol": provider.protocol,
                "model": provider.model,
                "capabilities": provider.capabilities,
                "elapsedMs": started.elapsed().as_millis(),
                "error": error
            })),
        );
    }
    result
}
