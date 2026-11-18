import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProjectComposition,
  compositionSchema,
} from "../src/remotion/schema";
import type {
  Asset,
  Scene,
  SubtitleCue,
  TimelineClip,
  VideoProject,
} from "../src/types";
import { renderVideoFile } from "./render-video-runtime";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectPath =
  process.env.KNOWMOTION_CONTEXT_PROJECT ??
  path.join(
    process.env.APPDATA ?? "",
    "com.knowmotion.studio",
    "projects",
    "project-a14ade6d-97fd-4ff1-8a88-85461cd22ca7",
    "project.json",
  );
const outputPath = path.join(root, "renders", "llm-context-v2.mp4");
const mediaDirectory = path.join(root, "examples", "llm-context", "audio");
await mkdir(mediaDirectory, { recursive: true });

const narrationById: Record<string, string> = {
  "scene-3885f05e-d786-4ddf-a899-0783b587cacc":
    "模型看起来记住了前文，但只要离开当前输入，它并不会自动保留这段对话。真正参与这次生成的内容，叫做上下文。",
  "scene-e17f8507-528d-4d60-8f61-f67d4d421026":
    "输入文本先按分词器切成 token。每个 token 变成离散线索，再被转换成模型可以计算的向量。",
  "scene-0e8ea1e7-c60b-44e1-9373-f1c2107a0d8b":
    "在注意力层里，每个 token 会和前文计算相关权重。权重决定混合多少信息，但它不是人类解释。",
  "scene-0903610a-37ef-4d06-8548-afbd9ba442ce":
    "位置编码补上词序；自回归生成时，因果掩码会挡住尚未出现的 token。",
  "scene-context-window-001":
    "模型一次推理只能读取上下文窗口里的内容。窗口大小因模型和配置而异，旧内容如何保留，取决于产品策略。",
  "scene-takeaway-context-001":
    "所以理解上下文，是读取当前线索、保留顺序、计算关联，再在有限窗口内组织成可计算结构。",
};

const rawProject = JSON.parse(
  await readFile(projectPath, "utf8"),
) as VideoProject;
const sourceScenes = rawProject.scenes.map((scene) => ({
  ...scene,
  narration: narrationById[scene.id] ?? scene.narration,
}));

const audioAssets: Asset[] = [];
const scenes: Scene[] = [];
const subtitles: SubtitleCue[] = [];
const timeline: TimelineClip[] = [];
let sceneCursor = 0;

for (const [index, scene] of sourceScenes.entries()) {
  const textPath = path.join(mediaDirectory, `${scene.id}.txt`);
  const audioPath = path.join(mediaDirectory, `${scene.id}.wav`);
  await writeFile(textPath, scene.narration, "utf8");
  const bytes = await readFile(audioPath);
  const spokenDurationMs = wavDurationMs(bytes);
  const duration = Math.max(5.5, spokenDurationMs / 1000 + 0.65);
  const timing = describeNarrationTiming(
    scene.narration,
    sceneCursor + 0.2,
    spokenDurationMs / 1000,
  );
  subtitles.push(
    ...timing.map((part, partIndex) => ({
      id: `llm-context-v2-${scene.id}-${partIndex}`,
      sceneId: scene.id,
      start: part.start,
      end: part.end,
      text: part.text,
    })),
  );
  const audio: Asset = {
    id: `narration-v2-${scene.id}`,
    sceneId: scene.id,
    name: `旁白 · ${scene.title}`,
    kind: "audio",
    src: `data:audio/wav;base64,${bytes.toString("base64")}`,
    prompt: "Windows SAPI local narration",
    createdAt: new Date().toISOString(),
    local: true,
    durationMs: spokenDurationMs,
  };
  audioAssets.push(audio);
  timeline.push({
    id: `llm-context-v2-video-${index}`,
    track: "video",
    sceneId: scene.id,
    label: `${String(index + 1).padStart(2, "0")} ${scene.title}`,
    start: sceneCursor,
    duration,
    color: scene.accent,
  });
  timeline.push({
    id: `llm-context-v2-narration-${index}`,
    track: "narration",
    sceneId: scene.id,
    assetId: audio.id,
    label: audio.name,
    start: sceneCursor + 0.2,
    duration: spokenDurationMs / 1000,
    color: "#a78bfa",
  });
  scenes.push({ ...scene, duration });
  sceneCursor += duration;
}

const project: VideoProject = {
  ...rawProject,
  scenes,
  assets: audioAssets,
  subtitles,
  timeline,
  stage: "render",
  updatedAt: new Date().toISOString(),
};

const composition = compositionSchema.parse(buildProjectComposition(project));
await writeFile(
  path.join(root, "examples", "llm-context", "composition.json"),
  JSON.stringify(composition, null, 2),
);
await writeFile(
  path.join(root, "examples", "llm-context", "narration.json"),
  JSON.stringify(
    scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      narration: scene.narration,
      duration: scene.duration,
    })),
    null,
    2,
  ),
);
const persistedProject: VideoProject = {
  ...project,
  scenes: scenes.map((scene, index) => ({
    ...scene,
    assetId: null,
    visualMode: "programmatic",
    layers: [],
    remotion: composition.scenes[index],
  })),
  assets: [
    ...audioAssets.map((asset) => ({
      ...asset,
      src: `assets/audio/narration-v2-${asset.sceneId}.wav`,
      mimeType: "audio/wav",
    })),
  ],
};
await writeFile(
  path.join(root, "examples", "llm-context", "project.json"),
  JSON.stringify(persistedProject, null, 2),
);
if (process.env.KNOWMOTION_SKIP_RENDER === "1") {
  console.log("Updated the persisted explainer project without rendering.");
  process.exit(0);
}
await renderVideoFile(composition, outputPath);
console.log(
  `Rendered ${outputPath} (${composition.durationInFrames} frames / ${composition.audioTracks.length} audio tracks).`,
);

function describeNarrationTiming(
  text: string,
  start: number,
  duration: number,
): Array<{ start: number; end: number; text: string }> {
  const parts = text
    .split(/(?<=[。！？；])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const weights = parts.map((part) => Math.max(1, [...part].length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = start;
  return parts.map((part, index) => {
    const partDuration = (duration * weights[index]) / total;
    const cue = {
      start: Number(cursor.toFixed(3)),
      end: Number((cursor + partDuration).toFixed(3)),
      text: part,
    };
    cursor += partDuration;
    return cue;
  });
}

function wavDurationMs(buffer: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error("Invalid WAV file");
  return (dataSize / byteRate) * 1000;
}
