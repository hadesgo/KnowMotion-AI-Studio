import type { GsapMotionConfig } from "./gsap/gsapMotion";

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
  content?: string;
  indexedAt?: string;
}

/** 参考图归属：角色、场景（环境）或全局风格。 */
export type ReferenceRole = "character" | "location" | "style" | "prop";

export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  summary: string;
  appearance: string;
  wardrobe: string;
  palette: string[];
  negative: string;
  seed?: number;
  referenceAssetIds: string[];
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocationProfile {
  id: string;
  name: string;
  summary: string;
  environment: string;
  lighting: string;
  timeOfDay: string;
  palette: string[];
  negative: string;
  seed?: number;
  referenceAssetIds: string[];
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StyleLock {
  enabled: boolean;
  descriptor: string;
  palette: string[];
  negative: string;
  referenceAssetIds: string[];
}

export interface SceneLayer {
  id: string;
  type: "text" | "shape" | "canvas";
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
  canvasVariant?:
    | "particleFlow"
    | "waveform"
    | "network"
    | "orbitTrails";
  secondaryColor?: string;
  density?: number;
  speed?: number;
  lineWidth?: number;
  intensity?: number;
  seed?: number;
  gsapMotion?: GsapMotionConfig;
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
  /** 该镜头出场的角色设定 ID，按顺序进入提示词。 */
  characterIds?: string[];
  /** 该镜头所处的环境设定 ID。 */
  locationId?: string;
  remotion?: Record<string, unknown>;
  motionPreset?: "pushIn" | "pullOut" | "panLeft" | "panRight" | "none";
  visualMode?: "programmatic" | "image";
  gsapMotion?: GsapMotionConfig;
}

export interface ReferenceAttachment {
  role: ReferenceRole;
  /** 角色 / 场景 / 风格锁定卡的 ID；风格锁定时为 "style-lock"。 */
  entityId: string;
  label: string;
  weight: number;
  locked: boolean;
  notes: string;
}

export interface ConsistencyStamp {
  fingerprint: string;
  anchorLabel: string;
  seed: number;
  prompt: string;
  negativePrompt: string;
  referenceAssetIds: string[];
  conditioning: "prompt" | "prompt+img2img";
  generatedAt: string;
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
  durationMs?: number;
  mimeType?: string;
  providerId?: string;
  /** 设定集参考图的归属；普通场景素材没有该字段。 */
  reference?: ReferenceAttachment;
  /** 生成时使用的锚点快照，用于检测设定漂移。 */
  consistency?: ConsistencyStamp;
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
  assetId?: string;
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
  outputPath?: string;
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
  /** 角色设定集：跨场景复用的外观锚点与参考图。 */
  characters: CharacterProfile[];
  /** 场景（环境）设定集。 */
  locations: LocationProfile[];
  /** 全局风格锁定。 */
  styleLock: StyleLock;
  subtitles: SubtitleCue[];
  timeline: TimelineClip[];
  audio: AudioSettings;
  renders: RenderRecord[];
  qualityReport?: {
    score: number;
    status: "pass" | "warn" | "fail" | string;
    findings: Array<{
      severity: string;
      code: string;
      message: string;
      sceneId?: string;
    }>;
    checkedAt?: string;
    summary?: string;
  };
}

export type ProviderCapability = "LLM" | "Image" | "TTS" | "ASR" | "Embedding";
export type GgufInferenceBackend = "auto" | "gpu" | "cpu";

export interface ProviderProfile {
  id: string;
  name: string;
  protocol:
    | "OpenAI Compatible"
    | "Anthropic"
    | "Gemini"
    | "Ollama"
    | "GGUF"
    | "ComfyUI";
  baseUrl: string;
  model: string;
  contextSize?: number;
  inferenceBackend?: GgufInferenceBackend;
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
