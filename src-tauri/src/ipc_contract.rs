use crate::{
    agent::model::{
        AgentDescriptor, AgentModelRoute, ProviderConfig, ProviderTestRequest, ProviderTestResult,
        WorkflowDefinition, WorkflowEventPayload, WorkflowRevision, WorkflowRunView,
        WorkflowStartRequest, WorkflowStepView,
    },
    capabilities::{
        AsrCue, AsrRequest, AsrResult, EmbeddingRequest, EmbeddingResult, ImageConditioningInput,
        ImageGenerationRequest, ImageGenerationResult, ImageProviderConfig, ImageReferenceInput,
        InpaintRequest, InpaintResult, KnowledgeSearchRequest, KnowledgeSearchResult,
        ResearchFetchRequest, ResearchFetchResult, TtsGenerationRequest, TtsGenerationResult,
        TtsScene,
    },
    image_queue::ImageJobView,
    local_model_scheduler::{
        ActiveLeaseStatus, LocalModelSchedulerStatus, LocalRuntimeConfig, ManagedRuntimeStatus,
    },
    local_runtime::RuntimeInstallResult,
    media::{GeneratedMediaAsset, MusicRequest, NarrationRequest},
    render::{RenderJobView, RenderProgressPayload, RenderStartResponse},
    storage::MissingAsset,
    DesktopStatus,
};
use schemars::{schema_for, JsonSchema};

/// Canonical root for the IPC contract generator.
///
/// Runtime DTOs are the source of truth. Adding an IPC DTO must also add it here so
/// both TypeScript and JSON Schema are regenerated from the same Rust definitions.
#[derive(JsonSchema)]
#[schemars(rename = "IpcTypes", rename_all = "camelCase")]
pub struct IpcTypes {
    pub agent_descriptor: AgentDescriptor,
    pub workflow_definition: WorkflowDefinition,
    pub provider_config: ProviderConfig,
    pub agent_model_route: AgentModelRoute,
    pub workflow_start_request: WorkflowStartRequest,
    pub workflow_revision: WorkflowRevision,
    pub workflow_step: WorkflowStepView,
    pub workflow_run: WorkflowRunView,
    pub workflow_changed_event: WorkflowEventPayload,
    pub provider_test_request: ProviderTestRequest,
    pub provider_test_result: ProviderTestResult,
    pub local_runtime_config: LocalRuntimeConfig,

    pub desktop_status: DesktopStatus,
    pub missing_asset: MissingAsset,

    pub image_provider_config: ImageProviderConfig,
    pub image_reference_input: ImageReferenceInput,
    pub image_conditioning_input: ImageConditioningInput,
    pub image_generation_request: ImageGenerationRequest,
    pub image_generation_result: ImageGenerationResult,
    pub image_job: ImageJobView,
    pub inpaint_request: InpaintRequest,
    pub inpaint_result: InpaintResult,
    pub tts_scene: TtsScene,
    pub tts_generation_request: TtsGenerationRequest,
    pub tts_generation_result: TtsGenerationResult,
    pub asr_request: AsrRequest,
    pub asr_cue: AsrCue,
    pub asr_result: AsrResult,
    pub embedding_request: EmbeddingRequest,
    pub embedding_result: EmbeddingResult,
    pub knowledge_search_request: KnowledgeSearchRequest,
    pub knowledge_search_result: KnowledgeSearchResult,
    pub research_fetch_request: ResearchFetchRequest,
    pub research_fetch_result: ResearchFetchResult,

    pub render_start_response: RenderStartResponse,
    pub render_job: RenderJobView,
    pub render_progress: RenderProgressPayload,
    pub runtime_install_result: RuntimeInstallResult,
    pub active_lease_status: ActiveLeaseStatus,
    pub managed_runtime_status: ManagedRuntimeStatus,
    pub local_model_scheduler_status: LocalModelSchedulerStatus,
    pub generated_media_asset: GeneratedMediaAsset,
    pub narration_request: NarrationRequest,
    pub music_request: MusicRequest,
}

pub fn contract_schema() -> serde_json::Value {
    serde_json::to_value(schema_for!(IpcTypes)).expect("IPC schema must serialize")
}
