import { invoke } from "@tauri-apps/api/core";
import { isTauriDesktop } from "./desktop";
import type { Asset, Scene } from "../types";

function requireDesktop(): void {
  if (!isTauriDesktop) {
    throw new Error("本地语音和背景音乐生成需要 Tauri 桌面运行时。");
  }
}

export async function generateNarrationAudio(
  projectId: string,
  scenes: Scene[],
  voice: string,
  rate: number,
): Promise<Asset[]> {
  requireDesktop();
  return invoke<Asset[]>("generate_project_narration", {
    request: {
      projectId,
      scenes: scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        narration: scene.narration,
      })),
      voice,
      rate,
    },
  });
}

export async function generateBackgroundMusic(
  projectId: string,
  durationSeconds = 15,
): Promise<Asset> {
  requireDesktop();
  return invoke<Asset>("generate_background_music", {
    request: { projectId, durationSeconds },
  });
}
