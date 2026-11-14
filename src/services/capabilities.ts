import { invoke } from "@tauri-apps/api/core";
import type { Asset, ProviderProfile, ReferenceRole } from "../types";
import { isTauriDesktop } from "./desktop";

export interface ImageReferenceInput {
  assetId: string;
  role: ReferenceRole;
  label: string;
  weight: number;
  /** kmasset URL 或 data URL；后端只接受项目内文件。 */
  source: string;
}

export interface ImageGenerationResult {
  assets: Asset[];
  providerId: string;
  model: string;
  elapsedMs: number;
  referenceMode: "prompt" | "prompt+img2img";
  referenceCount: number;
  seed: number;
  anchorLabel: string;
}

export interface ImageGenerationRequestInput {
  projectId: string;
  sceneId: string;
  provider: ProviderProfile;
  prompt: string;
  style: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  count: number;
  negativePrompt?: string;
  seed?: number;
  references?: ImageReferenceInput[];
  anchorLabel?: string;
  consistencyFingerprint?: string;
}

export async function generateProjectImages(
  input: ImageGenerationRequestInput,
): Promise<ImageGenerationResult> {
  if (!isTauriDesktop) {
    throw new Error("在线图片生成需要 Tauri 桌面运行时。");
  }
  return invoke<ImageGenerationResult>("generate_project_images", {
    request: input,
  });
}

export interface InpaintResult {
  asset: Asset;
  providerId: string;
  model: string;
  elapsedMs: number;
  mode: "openai-edits" | "comfyui-inpaint";
  seed: number;
}

export async function inpaintProjectImage(input: {
  projectId: string;
  sceneId: string;
  sourceAssetId: string;
  provider: ProviderProfile;
  prompt: string;
  negativePrompt?: string;
  size: string;
  maskDataUrl: string;
  maskAlphaDataUrl: string;
  maskCoverage?: number;
  seed?: number;
  anchorLabel?: string;
  consistencyFingerprint?: string;
}): Promise<InpaintResult> {
  if (!isTauriDesktop) {
    throw new Error("局部重绘需要 Tauri 桌面运行时与已配置的图片 Provider。");
  }
  return invoke<InpaintResult>("inpaint_project_image", { request: input });
}

export async function generateCloudNarration(input: {
  projectId: string;
  provider: ProviderProfile;
  scenes: Array<{ id: string; title: string; narration: string }>;
  voice: string;
  rate: number;
}): Promise<{
  assets: Asset[];
  providerId: string;
  model: string;
  elapsedMs: number;
}> {
  if (!isTauriDesktop) {
    throw new Error("云端旁白生成需要 Tauri 桌面运行时。");
  }
  return invoke<{
    assets: Asset[];
    providerId: string;
    model: string;
    elapsedMs: number;
  }>("generate_project_cloud_narration", {
    request: input,
  });
}

export interface AsrCue {
  start: number;
  end: number;
  text: string;
}

export interface AsrResult {
  text: string;
  cues: AsrCue[];
  providerId: string;
  model: string;
  elapsedMs: number;
}

export async function transcribeProjectAudio(input: {
  projectId: string;
  assetId: string;
  provider: ProviderProfile;
}): Promise<AsrResult> {
  if (!isTauriDesktop) {
    throw new Error("语音识别需要 Tauri 桌面运行时。");
  }
  return invoke<AsrResult>("transcribe_project_audio", { request: input });
}

export async function fetchResearchSource(url: string): Promise<{
  title: string;
  text: string;
  url: string;
  bytes: number;
}> {
  if (!isTauriDesktop) {
    throw new Error("来源抓取需要 Tauri 桌面运行时。");
  }
  return invoke("fetch_research_source", { request: { url } });
}

export async function embedProjectKnowledge(input: {
  projectId: string;
  sourceId: string;
  texts: string[];
  provider: ProviderProfile;
}): Promise<{
  chunks: number;
  dimensions: number;
  providerId: string;
  model: string;
}> {
  if (!isTauriDesktop) {
    throw new Error("知识索引需要 Tauri 桌面运行时。");
  }
  return invoke("embed_project_knowledge", { request: input });
}

export async function searchProjectKnowledge(input: {
  projectId: string;
  query: string;
  limit?: number;
  provider: ProviderProfile;
}): Promise<
  Array<{ sourceId: string; chunkIndex: number; text: string; score: number }>
> {
  if (!isTauriDesktop) return [];
  return invoke("search_project_knowledge", { request: input });
}
