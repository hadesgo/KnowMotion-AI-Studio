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
  acceleration: "CUDA 12.4" | "CUDA 13" | "Vulkan" | string;
};

export type { LocalModelSchedulerStatus, LocalRuntimeConfig };

export async function ensureLocalRuntime(
  runtime: LocalRuntimeId,
  force = false,
  acceleration: "auto" | "vulkan" | "cuda" | "cuda13" = "auto",
): Promise<LocalRuntimeInstallResult> {
  return invoke<LocalRuntimeInstallResult>("ensure_local_runtime", {
    runtime,
    // force 走「重装」：忽略已安装副本，重新下载固定版本归档并逐文件校验。
    force,
    // 手工放进来的 CUDA 构建缺少 cudart 时，用 vulkan 选项装体积更小的 Vulkan 版本。
    acceleration,
  });
}

export async function getLocalModelSchedulerStatus(): Promise<LocalModelSchedulerStatus> {
  return invoke<LocalModelSchedulerStatus>("local_model_scheduler_status");
}

export async function unloadLocalModels(): Promise<LocalModelSchedulerStatus> {
  return invoke<LocalModelSchedulerStatus>("unload_local_models");
}
