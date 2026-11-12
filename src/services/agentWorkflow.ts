import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderProfile, VideoProject } from "../types";
import { isTauriDesktop } from "./desktop";

export interface AgentDescriptor {
  key: string;
  title: string;
  description: string;
  version: string;
  capability: string;
  dependencies: string[];
  requiresApproval: boolean;
  approvalLabel?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  allowedTools: string[];
}

export interface WorkflowDefinition {
  key: string;
  version: string;
  title: string;
  description: string;
  agents: AgentDescriptor[];
}

export interface AgentModelRoute {
  providerId: string;
  model?: string;
}

export interface WorkflowStep {
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  dependencies: string[];
  requiresApproval: boolean;
  approvalLabel?: string;
  approvalStatus: string;
  providerId?: string;
  model?: string;
  summary?: string;
  warnings: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowRevision {
  id: string;
  runId: string;
  stepKey: string;
  projectId: string;
  revision: number;
  summary: string;
  createdAt: string;
  undoable: boolean;
}

export interface WorkflowRun {
  id: string;
  projectId: string;
  workflowKey: string;
  status: string;
  currentStepKey?: string;
  instruction?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  project?: VideoProject & Record<string, unknown>;
  steps: WorkflowStep[];
  revisions: WorkflowRevision[];
}

export interface WorkflowChangedEvent {
  eventId: string;
  runId: string;
  stepKey?: string;
  kind: string;
  message: string;
  runStatus: string;
  at: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  model: string;
}

export const fallbackWorkflowDefinition: WorkflowDefinition = {
  key: "knowledge-animation-v1",
  version: "1.0",
  title: "知识动画完整创作流程",
  description: "从研究到质量检查的持久化 Agent DAG。",
  agents: [
    agent("research", "Research Agent", "整理问题、核验需求与来源风险。", [], false, ["setResearchSources"]),
    agent("director", "Director Agent", "设计钩子、知识顺序和目标时长。", ["research"], true, ["replaceOutline"], "大纲审批"),
    agent("script", "Script Agent", "把大纲写成旁白、画面建议与镜头说明。", ["director"], false, ["replaceScenes"]),
    agent("storyboard", "Storyboard Agent", "拆分镜头、转场、构图与视觉需求。", ["script"], true, ["replaceScenes"], "分镜审批"),
    agent("art_director", "Art Director Agent", "统一视觉语言并生成场景提示词。", ["storyboard"], false, ["replaceScenes", "updateSettings"]),
    agent("asset", "Asset Agent", "规划素材形式并生成本地视觉草案。", ["art_director"], false, ["generateSceneAssets", "replaceAssets"]),
    agent("animation", "Animation Agent", "生成结构化图层、时间点和镜头运动。", ["asset"], false, ["replaceScenes"]),
    agent("audio", "Audio Agent", "生成字幕、旁白与轨道时间线。", ["animation"], false, ["replaceSubtitles", "replaceTimeline", "updateAudio"]),
    agent("quality", "Quality Agent", "检查事实、时长、素材和字幕完整性。", ["audio"], true, ["setQualityReport"], "最终内容审批"),
  ],
};

function agent(
  key: string,
  title: string,
  description: string,
  dependencies: string[],
  requiresApproval: boolean,
  allowedTools: string[],
  approvalLabel?: string,
): AgentDescriptor {
  return {
    key,
    title,
    description,
    version: "1.0",
    capability: "LLM",
    dependencies,
    requiresApproval,
    approvalLabel,
    inputSchema: {},
    outputSchema: {},
    allowedTools,
  };
}

function requireDesktop(): void {
  if (!isTauriDesktop) {
    throw new Error("Agent Workflow 需要运行在 Tauri 桌面应用中。");
  }
}

export async function getWorkflowDefinition(): Promise<WorkflowDefinition> {
  if (!isTauriDesktop) return fallbackWorkflowDefinition;
  return invoke<WorkflowDefinition>("agent_workflow_definition");
}

export async function startWorkflow(
  project: VideoProject,
  providers: ProviderProfile[],
  agentRoutes: Record<string, AgentModelRoute>,
  options?: {
    instruction?: string;
    targetAgent?: string;
    maxAttempts?: number;
  },
): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_start", {
    request: {
      project,
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: provider.model,
        enabled: provider.enabled,
        capabilities: provider.capabilities,
      })),
      agentRoutes,
      instruction: options?.instruction ?? null,
      targetAgent: options?.targetAgent ?? null,
      maxAttempts: options?.maxAttempts ?? 2,
    },
  });
}

export async function getWorkflow(runId: string): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_get", { runId });
}

export async function listWorkflows(
  projectId: string,
  limit = 20,
): Promise<WorkflowRun[]> {
  requireDesktop();
  return invoke<WorkflowRun[]>("workflow_list", { projectId, limit });
}

export async function pauseWorkflow(runId: string): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_pause", { runId });
}

export async function resumeWorkflow(runId: string): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_resume", { runId });
}

export async function retryWorkflow(runId: string): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_retry", { runId });
}

export async function rerunWorkflowStep(
  runId: string,
  stepKey: string,
): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_rerun_step", { runId, stepKey });
}

export async function approveWorkflowStep(
  runId: string,
  stepKey: string,
  decision: "approve" | "request_changes",
  note?: string,
): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_approve", {
    runId,
    stepKey,
    decision,
    note: note ?? null,
  });
}

export async function undoWorkflowRevision(
  runId: string,
  revisionId: string,
): Promise<WorkflowRun> {
  requireDesktop();
  return invoke<WorkflowRun>("workflow_undo_revision", {
    runId,
    revisionId,
  });
}

export async function listenForWorkflowChanges(
  handler: (event: WorkflowChangedEvent) => void,
): Promise<UnlistenFn> {
  requireDesktop();
  return listen<WorkflowChangedEvent>("agent-workflow-changed", (event) =>
    handler(event.payload),
  );
}

export async function saveProviderSecret(
  providerId: string,
  apiKey: string,
): Promise<void> {
  requireDesktop();
  return invoke("provider_save_secret", { providerId, apiKey });
}

export async function clearProviderSecret(providerId: string): Promise<void> {
  requireDesktop();
  return invoke("provider_clear_secret", { providerId });
}

export async function testProviderConnection(
  provider: ProviderProfile,
): Promise<ProviderTestResult> {
  requireDesktop();
  return invoke<ProviderTestResult>("provider_test", {
    request: {
      provider: {
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: provider.model,
        enabled: provider.enabled,
        capabilities: provider.capabilities,
      },
    },
  });
}
