import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Asset } from "../types";
import { isTauriDesktop } from "./desktop";

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "ogv"];

export async function pickVideoFile(): Promise<string | null> {
  if (!isTauriDesktop) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "视频文件", extensions: VIDEO_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function importProjectVideo(
  projectId: string,
  sourcePath: string,
  name?: string,
): Promise<Asset> {
  if (!isTauriDesktop) {
    throw new Error("导入视频需要 Tauri 桌面运行时。");
  }
  return invoke<Asset>("import_project_video", {
    projectId,
    sourcePath,
    name: name ?? null,
  });
}

export interface VideoProbe {
  durationMs: number;
  width: number;
  height: number;
  decodable: boolean;
}

/** 用浏览器的媒体解码器读取时长与分辨率，避免在 Rust 侧重复实现容器解析。 */
export function probeVideoSource(src: string, timeoutMs = 8000): Promise<VideoProbe> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve({ durationMs: 0, width: 0, height: 0, decodable: false });
      return;
    }
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: VideoProbe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = window.setTimeout(
      () => finish({ durationMs: 0, width: 0, height: 0, decodable: false }),
      timeoutMs,
    );
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      finish({
        durationMs: Number.isFinite(video.duration)
          ? Math.max(0, Math.round(video.duration * 1000))
          : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        decodable: true,
      });
    video.onerror = () =>
      finish({ durationMs: 0, width: 0, height: 0, decodable: false });
    video.src = src;
  });
}

export function formatClipTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}
