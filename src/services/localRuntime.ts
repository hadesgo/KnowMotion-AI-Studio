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

export async function ensureLocalRuntime(
  runtime: LocalRuntimeId,
): Promise<LocalRuntimeInstallResult> {
  return invoke<LocalRuntimeInstallResult>("ensure_local_runtime", { runtime });
}
