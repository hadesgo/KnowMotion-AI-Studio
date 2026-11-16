import { invoke } from "@tauri-apps/api/core";

export type LocalRuntimeId =
  | "llama.cpp"
  | "audio.cpp"
  | "stable-diffusion.cpp";

export interface LocalRuntimeInstallResult {
  runtime: LocalRuntimeId;
  version: string;
  acceleration: "CUDA 12.4" | "Vulkan" | string;
  installPath: string;
  executablePath: string;
  alreadyInstalled: boolean;
}

export interface LocalModelSchedulerStatus {
  activeLease: {
    id: string;
    providerId: string;
    workload: string;
    startedAt: string;
    elapsedMs: number;
  } | null;
  waitingRequests: number;
  vramReserveMib: number;
  freeVramMib: number | null;
  managedProcesses: number;
  runtimes: Array<{
    key: string;
    runtime: string;
    baseUrl: string;
    modelLoaded: boolean;
    managedProcess: boolean;
    idleSeconds: number;
  }>;
}

export async function ensureLocalRuntime(
  runtime: LocalRuntimeId,
): Promise<LocalRuntimeInstallResult> {
  return invoke<LocalRuntimeInstallResult>("ensure_local_runtime", { runtime });
}

export async function getLocalModelSchedulerStatus(): Promise<LocalModelSchedulerStatus> {
  return invoke<LocalModelSchedulerStatus>("local_model_scheduler_status");
}

export async function unloadLocalModels(): Promise<LocalModelSchedulerStatus> {
  return invoke<LocalModelSchedulerStatus>("unload_local_models");
}
