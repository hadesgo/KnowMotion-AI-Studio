import type { Asset, ProviderProfile, Scene, VideoProject } from "../types";
import type { ImageGenerationRequestInput, ImageReferenceInput } from "./capabilities";
import {
  composeAnchoredPrompt,
  hasSceneAnchors,
  resolveSceneAnchors,
  type SceneAnchors,
} from "./consistency";

export function referencesFromAnchors(
  project: VideoProject,
  anchors: SceneAnchors,
): ImageReferenceInput[] {
  return anchors.referenceAssetIds
    .map((id) => project.assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset?.reference))
    .map((asset) => ({
      assetId: asset.id,
      role: asset.reference!.role,
      label: asset.reference!.label,
      weight: asset.reference!.weight,
      source: asset.src,
    }));
}

export function buildAnchoredImageRequest(input: {
  project: VideoProject;
  scene: Scene;
  provider: ProviderProfile;
  style: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  count: number;
  useAnchors: boolean;
  prompt?: string;
}): ImageGenerationRequestInput {
  const anchors = resolveSceneAnchors(input.project, input.scene);
  const basePrompt = input.prompt?.trim() || input.scene.visualPrompt;
  const active =
    input.useAnchors && hasSceneAnchors(anchors) ? anchors : null;
  return {
    projectId: input.project.id,
    sceneId: input.scene.id,
    provider: input.provider,
    prompt: active ? composeAnchoredPrompt(basePrompt, active) : basePrompt,
    style: input.style,
    size: input.size,
    count: input.count,
    negativePrompt: active?.negativePrompt ?? "",
    seed: active?.seed,
    references: active ? referencesFromAnchors(input.project, active) : [],
    anchorLabel: active?.label ?? "",
    consistencyFingerprint: active?.fingerprint ?? "",
  };
}
