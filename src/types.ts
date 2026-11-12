export type AspectRatio = "16:9" | "9:16" | "1:1";
export type ProjectStage =
  | "planning"
  | "script"
  | "storyboard"
  | "assets"
  | "animation"
  | "timeline"
  | "audio"
  | "render";

export interface ProjectSettings {
  topic: string;
  contentType: string;
  audience: string;
  duration: number;
  aspectRatio: AspectRatio;
  style: string;
  language: string;
}

export interface OutlineSection {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  seconds: number;
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  note: string;
  verified: boolean;
}

export interface SceneLayer {
  id: string;
  type: "text" | "shape";
  name: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  start: number;
  end: number;
  color: string;
  fontSize: number;
  shape?: "circle" | "rectangle" | "line";
}

export interface Scene {
  id: string;
  title: string;
  narration: string;
  description: string;
  visualPrompt: string;
  shotType: string;
  transition: string;
  duration: number;
  accent: string;
  assetId?: string;
  layers: SceneLayer[];
}

export interface Asset {
  id: string;
  sceneId: string;
  name: string;
  kind: "image" | "audio";
  src: string;
  prompt: string;
  createdAt: string;
  local: boolean;
}

export interface SubtitleCue {
  id: string;
  sceneId: string;
  start: number;
  end: number;
  text: string;
}

export type TrackKind = "video" | "narration" | "subtitle" | "music" | "sfx";

export interface TimelineClip {
  id: string;
  track: TrackKind;
  sceneId?: string;
  label: string;
  start: number;
  duration: number;
  color: string;
}

export interface AudioSettings {
  voice: string;
  rate: number;
  volume: number;
  subtitleSize: number;
  subtitlePosition: "bottom" | "center" | "top";
}

export interface RenderRecord {
  id: string;
  createdAt: string;
  resolution: string;
  format: string;
  duration: number;
  size: string;
  status: "ready" | "failed";
}

export interface VideoProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  stage: ProjectStage;
  isDemo: boolean;
  settings: ProjectSettings;
  outline: OutlineSection[];
  outlineApproved: boolean;
  researchSources: ResearchSource[];
  scenes: Scene[];
  assets: Asset[];
  subtitles: SubtitleCue[];
  timeline: TimelineClip[];
  audio: AudioSettings;
  renders: RenderRecord[];
}

export type ProviderCapability = "LLM" | "Image" | "TTS" | "ASR" | "Embedding";

export interface ProviderProfile {
  id: string;
  name: string;
  protocol:
    | "OpenAI Compatible"
    | "Anthropic"
    | "Gemini"
    | "Ollama"
    | "ComfyUI";
  baseUrl: string;
  model: string;
  capabilities: ProviderCapability[];
  enabled: boolean;
  health: "healthy" | "unchecked" | "error";
  hasSecret: boolean;
  isDefault: boolean;
}

export interface CreateProjectInput {
  title: string;
  topic: string;
  contentType: string;
  audience: string;
  duration: number;
  aspectRatio: AspectRatio;
  style: string;
  language: string;
}

export interface ToastMessage {
  id: string;
  type: "success" | "info" | "error";
  title: string;
  message?: string;
}
