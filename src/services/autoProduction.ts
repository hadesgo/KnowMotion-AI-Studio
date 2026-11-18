import type {
  Asset,
  ProviderProfile,
  SubtitleCue,
  TimelineClip,
  VideoProject,
} from "../types";
import type {
  AgentModelRoute,
  WorkflowDefinition,
} from "../generated/ipc";
import {
  getWorkflow,
  type WorkflowRun,
} from "./agentWorkflow";
import type { ImageGenerationRequestInput } from "./capabilities";
import {
  enqueueImageJobs,
  listImageJobs,
} from "./imageQueue";
import { buildAnchoredImageRequest } from "./imageRequests";
import { makeId } from "../utils";

export function defaultAgentRoutes(
  definition: WorkflowDefinition,
  providers: ProviderProfile[],
  preferredProviderId?: string,
): Record<string, AgentModelRoute> {
  const provider =
    providers.find(
      (item) =>
        item.enabled &&
        item.id === preferredProviderId &&
        item.capabilities.includes("LLM"),
    ) ??
    providers.find(
      (item) => item.enabled && item.capabilities.includes("LLM"),
    );
  if (!provider) return {};
  return Object.fromEntries(
    definition.agents.map((agent) => [
      agent.key,
      { providerId: provider.id, model: provider.model },
    ]),
  );
}

export async function waitForWorkflowRun(
  runId: string,
  onUpdate?: (run: WorkflowRun) => void,
  timeoutMs = 90 * 60 * 1000,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getWorkflow(runId);
    onUpdate?.(run);
    if (["completed", "failed", "waiting_approval", "paused"].includes(run.status)) {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error("Agent 工作流超过 90 分钟仍未完成，请检查模型服务。");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }
}

function splitNarration(text: string): string[] {
  const segments = text
    .split(/(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length ? segments : [text.trim()];
}

export function applyNarrationAssets(
  project: VideoProject,
  generated: Asset[],
): VideoProject {
  const generatedByScene = new Map(
    generated.map((item) => [item.sceneId, item]),
  );
  let cursor = 0;
  const cues: SubtitleCue[] = [];
  const narrationClips: TimelineClip[] = [];

  for (const scene of project.scenes) {
    const audio = generatedByScene.get(scene.id);
    if (!audio) {
      cursor += scene.duration;
      continue;
    }
    const spokenDuration = Math.max(1, (audio.durationMs ?? 0) / 1000);
    const segments = splitNarration(scene.narration);
    const step = spokenDuration / segments.length;
    segments.forEach((text, index) => {
      cues.push({
        id: makeId("sub"),
        sceneId: scene.id,
        start: Number((cursor + 0.15 + index * step).toFixed(2)),
        end: Number((cursor + 0.15 + (index + 1) * step).toFixed(2)),
        text,
      });
    });
    narrationClips.push({
      id: makeId("clip"),
      track: "narration",
      sceneId: scene.id,
      assetId: audio.id,
      label: audio.name,
      start: cursor + 0.15,
      duration: spokenDuration,
      color: "#a78bfa",
    });
    cursor += Math.max(scene.duration, spokenDuration + 0.35);
  }

  let videoCursor = 0;
  const scenes = project.scenes.map((scene) => {
    const audio = generatedByScene.get(scene.id);
    const duration = audio
      ? Math.max(scene.duration, (audio.durationMs ?? 0) / 1000 + 0.35)
      : scene.duration;
    videoCursor += duration;
    return { ...scene, duration };
  });
  videoCursor = 0;
  const videoClips = scenes.map((scene, index) => {
    const clip: TimelineClip = {
      id: makeId("clip"),
      track: "video",
      sceneId: scene.id,
      label: `${String(index + 1).padStart(2, "0")} ${scene.title}`,
      start: videoCursor,
      duration: scene.duration,
      color: scene.accent,
    };
    videoCursor += scene.duration;
    return clip;
  });
  const subtitleClips = cues.map((cue) => ({
    id: makeId("clip"),
    track: "subtitle" as const,
    sceneId: cue.sceneId,
    label: cue.text,
    start: cue.start,
    duration: Math.max(0.8, cue.end - cue.start),
    color: "#c8ff65",
  }));
  const generatedIds = new Set(generated.map((asset) => asset.id));

  return {
    ...project,
    assets: [
      ...project.assets.filter(
        (asset) =>
          !generatedIds.has(asset.id) &&
          !asset.id.startsWith("narration-"),
      ),
      ...generated,
    ],
    scenes,
    subtitles: cues,
    timeline: [
      ...project.timeline.filter(
        (clip) => clip.track === "music" || clip.track === "sfx",
      ),
      ...videoClips,
      ...narrationClips,
      ...subtitleClips,
    ],
    stage: "audio",
  };
}

export function automaticImageRequests(
  project: VideoProject,
  provider: ProviderProfile,
  brief: string,
): ImageGenerationRequestInput[] {
  const wantsImages =
    /(写实|照片|摄影|插画|海报|电影画面|写实图像|photoreal|illustration|cinematic still)/i.test(
      brief,
    );
  const existingRealImage = (sceneId: string) =>
    project.assets.some(
      (asset) =>
        asset.sceneId === sceneId &&
        asset.kind === "image" &&
        !asset.src.startsWith("data:image/svg"),
    );
  return project.scenes
    .filter(
      (scene) =>
        (scene.visualMode === "image" || wantsImages) &&
        !existingRealImage(scene.id),
    )
    .map((scene) =>
      buildAnchoredImageRequest({
        project,
        scene,
        provider,
        style: project.settings.style,
        size:
          project.settings.aspectRatio === "9:16"
            ? "1024x1536"
            : project.settings.aspectRatio === "16:9"
              ? "1536x1024"
              : "1024x1024",
        count: 1,
        useAnchors: true,
      }),
    );
}

export async function waitForAutomaticImages(
  project: VideoProject,
  requests: ImageGenerationRequestInput[],
  onProgress?: (completed: number, total: number) => void,
  timeoutMs = 25 * 60 * 1000,
): Promise<{ project: VideoProject; warnings: string[] }> {
  if (!requests.length) return { project, warnings: [] };
  const created = await enqueueImageJobs(requests);
  const ids = new Set(created.map((job) => job.id));
  const deadline = Date.now() + timeoutMs;
  const warnings: string[] = [];

  for (;;) {
    const jobs = (await listImageJobs(project.id)).filter((job) =>
      ids.has(job.id),
    );
    const finished = jobs.filter(
      (job) => !["pending", "running"].includes(job.status),
    );
    onProgress?.(finished.length, ids.size);
    for (const job of finished) {
      if (job.status === "completed" && job.assets.length) {
        ids.delete(job.id);
        const resolved = new Set(project.assets.map((asset) => asset.id));
        const additions = job.assets.filter((asset) => !resolved.has(asset.id));
        project = {
          ...project,
          assets: [...additions, ...project.assets],
          scenes: project.scenes.map((scene) =>
            scene.id === job.sceneId && additions[0]
              ? { ...scene, assetId: additions[0].id, visualMode: "image" }
              : scene,
          ),
          stage: "assets",
        };
      } else if (
        (job.status === "completed" ||
          ["failed", "canceled", "interrupted"].includes(job.status)) &&
        ids.delete(job.id)
      ) {
        warnings.push(
          `${project.scenes.find((scene) => scene.id === job.sceneId)?.title ?? job.sceneId}：图片生成未完成，已回退为矢量画面${job.error ? `（${job.error}）` : ""}`,
        );
      }
    }
    if (!ids.size) return { project, warnings };
    if (Date.now() >= deadline) {
      warnings.push("部分图片任务超过等待时间，成片使用已完成的素材和矢量画面。");
      return { project, warnings };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
}
