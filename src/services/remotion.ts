import { invoke } from "@tauri-apps/api/core";
import type { CompositionDsl } from "../remotion/schema";
import { isTauriDesktop } from "./desktop";

export interface RemotionRenderResult {
  outputPath: string;
  bytes: number;
  elapsedMs: number;
}

export async function renderRemotionComposition(
  projectId: string,
  composition: CompositionDsl,
): Promise<RemotionRenderResult> {
  if (!isTauriDesktop) {
    throw new Error("MP4 渲染需要 Tauri 桌面运行时。");
  }
  return invoke<RemotionRenderResult>("render_remotion_composition", {
    projectId,
    compositionJson: JSON.stringify(composition),
  });
}
