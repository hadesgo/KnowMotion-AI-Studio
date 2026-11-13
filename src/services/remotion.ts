import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CompositionDsl } from "../remotion/schema";
import { isTauriDesktop } from "./desktop";

export interface RemotionRenderResult {
  outputPath: string;
  bytes: number;
  elapsedMs: number;
}

export interface RenderStartResponse {
  jobId: string;
  taskId: string;
}

export type RenderJobStatus =
  | "queued"
  | "running"
  | "canceling"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export interface RenderJob {
  id: string;
  taskId: string;
  projectId: string;
  projectRevision: number;
  status: RenderJobStatus;
  percent: number;
  renderedFrames: number;
  encodedFrames: number;
  stage: string;
  outputPath?: string;
  bytes?: number;
  sha256?: string;
  durationMs?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderProgressEvent {
  eventId: string;
  jobId: string;
  percent: number;
  renderedFrames: number;
  encodedFrames: number;
  stage: string;
  at: string;
}

function requireDesktop() {
  if (!isTauriDesktop) {
    throw new Error("MP4 渲染需要 Tauri 桌面运行时。");
  }
}

export async function startRemotionRender(
  projectId: string,
  composition: CompositionDsl,
  projectRevision: number,
): Promise<RenderStartResponse> {
  requireDesktop();
  return invoke<RenderStartResponse>("render_start", {
    projectId,
    compositionJson: JSON.stringify(composition),
    projectRevision,
  });
}

export async function getRenderJob(
  projectId: string,
  jobId: string,
): Promise<RenderJob> {
  requireDesktop();
  return invoke<RenderJob>("render_get", { projectId, jobId });
}

export async function listRenderJobs(
  projectId: string,
  limit = 20,
): Promise<RenderJob[]> {
  if (!isTauriDesktop) return [];
  return invoke<RenderJob[]>("render_list", { projectId, limit });
}

export async function cancelRemotionRender(
  projectId: string,
  jobId: string,
): Promise<RenderJob> {
  requireDesktop();
  return invoke<RenderJob>("render_cancel", { projectId, jobId });
}

export async function listenRenderProgress(
  handler: (progress: RenderProgressEvent) => void,
): Promise<UnlistenFn> {
  requireDesktop();
  return listen<RenderProgressEvent>("render.progress", (event) => {
    handler(event.payload);
  });
}

export async function waitForRender(
  projectId: string,
  jobId: string,
  onUpdate?: (job: RenderJob) => void,
): Promise<RenderJob> {
  for (;;) {
    const job = await getRenderJob(projectId, jobId);
    onUpdate?.(job);
    if (!["queued", "running", "canceling"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

export async function renderRemotionComposition(
  projectId: string,
  composition: CompositionDsl,
  projectRevision = Date.now(),
  onUpdate?: (job: RenderJob) => void,
): Promise<RemotionRenderResult> {
  const startedAt = performance.now();
  const { jobId } = await startRemotionRender(
    projectId,
    composition,
    projectRevision,
  );
  const job = await waitForRender(projectId, jobId, onUpdate);
  if (job.status !== "succeeded" || !job.outputPath || !job.bytes) {
    throw new Error(
      job.error ??
        (job.status === "canceled"
          ? "MP4 渲染已取消。"
          : `MP4 渲染结束，状态为 ${job.status}。`),
    );
  }
  return {
    outputPath: job.outputPath,
    bytes: job.bytes,
    elapsedMs: job.durationMs ?? Math.round(performance.now() - startedAt),
  };
}
