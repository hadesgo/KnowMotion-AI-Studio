import { invoke } from "@tauri-apps/api/core";
import type {
  LocalModelSchedulerStatus,
  LocalRuntimeConfig,
  RuntimeInstallResult,
} from "../generated/ipc";

export type LocalRuntimeId =
  | "llama.cpp"
  | "audio.cpp"
  | "stable-diffusion.cpp";

export type LocalRuntimeInstallResult = Omit<
  RuntimeInstallResult,
  "runtime" | "acceleration"
> & {
  runtime: LocalRuntimeId;
  acceleration: "CUDA 12.4" | "Vulkan" | string;
};

export type { LocalModelSchedulerStatus, LocalRuntimeConfig };

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
