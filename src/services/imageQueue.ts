import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ImageJobView } from "../generated/ipc";
import type { Asset, ImageJob, ImageJobStatus } from "../types";
import type { ImageGenerationRequestInput } from "./capabilities";
import { isTauriDesktop } from "./desktop";

export const IMAGE_JOB_EVENT = "image.job.changed";

type GeneratedImageJob = Omit<ImageJobView, "assets" | "status"> & {
  assets: Asset[];
  status: ImageJobStatus;
};

export interface ImageJobEventPayload {
  eventId: string;
  change: string;
  job: ImageJob;
  at: string;
}

export async function enqueueImageJobs(
  requests: ImageGenerationRequestInput[],
): Promise<ImageJob[]> {
  if (!isTauriDesktop) {
    throw new Error("批量生成队列需要 Tauri 桌面运行时。");
  }
  return invoke<GeneratedImageJob[]>("enqueue_image_jobs", { requests });
}

export async function listImageJobs(
  projectId?: string,
  limit = 60,
): Promise<ImageJob[]> {
  if (!isTauriDesktop) return [];
  return invoke<GeneratedImageJob[]>("list_image_jobs", {
    projectId: projectId ?? null,
    limit,
  });
}

export async function cancelImageJob(jobId: string): Promise<void> {
  if (!isTauriDesktop) return;
  await invoke("cancel_image_job", { jobId });
}

export async function retryImageJob(jobId: string): Promise<void> {
  if (!isTauriDesktop) return;
  await invoke("retry_image_job", { jobId });
}

export async function clearImageJobs(projectId: string): Promise<number> {
  if (!isTauriDesktop) return 0;
  return invoke<number>("clear_image_jobs", { projectId });
}

export async function listenImageJobs(
  handler: (job: ImageJob) => void,
): Promise<UnlistenFn> {
  return listen<ImageJobEventPayload>(IMAGE_JOB_EVENT, (event) => {
    handler(event.payload.job);
  });
}
