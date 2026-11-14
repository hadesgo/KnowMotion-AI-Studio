import assert from "node:assert/strict";
import test from "node:test";
import { makeSampleProject } from "../src/data/demo";
import {
  buildProjectComposition,
  compositionSchema,
} from "../src/remotion/schema";
import { formatClipTime } from "../src/services/video";
import type { Asset, SceneLayer, VideoProject } from "../src/types";

const videoAsset = (id = "asset_video_demo"): Asset => ({
  id,
  sceneId: "",
  name: "屏幕录制",
  kind: "video",
  src: "data:video/mp4;base64,AAAA",
  prompt: "用户导入视频",
  createdAt: "2026-11-14T00:00:00.000Z",
  local: true,
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  mimeType: "video/mp4",
});

const videoLayer = (assetId = "asset_video_demo"): SceneLayer => ({
  id: "layer_video_demo",
  type: "video",
  name: "屏幕录制 · 片段",
  content: "",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  opacity: 1,
  start: 0,
  end: 3,
  color: "#000000",
  fontSize: 16,
  assetId,
  trimStart: 1,
  trimEnd: 6,
  fit: "cover",
  volume: 0.8,
  muted: true,
  playbackRate: 1.5,
  borderRadius: 0,
});

function projectWithVideo(): VideoProject {
  const project = makeSampleProject();
  project.assets.push(videoAsset());
  project.scenes[0] = {
    ...project.scenes[0],
    layers: [...project.scenes[0].layers, videoLayer()],
  };
  return project;
}

test("video layers compile into Remotion DSL with trim and audio settings", () => {
  const composition = buildProjectComposition(projectWithVideo());
  const asset = composition.assets.find((item) => item.id === "asset_video_demo");
  assert.equal(asset?.type, "video");
  assert.equal(asset?.mimeType, "video/mp4");

  const layer = composition.scenes[0].layers.find(
    (item) => item.id === "layer_video_demo",
  );
  assert.ok(layer && layer.type === "video");
  assert.equal(layer.assetId, "asset_video_demo");
  assert.equal(layer.trimStartMs, 1000);
  assert.equal(layer.trimEndMs, 6000);
  assert.equal(layer.playbackRate, 1.5);
  assert.equal(layer.muted, true);
  assert.equal(layer.volume, 0.8);
  assert.equal(layer.timing.fromMs, 0);
  assert.equal(layer.timing.toMs, 3000);
});

test("video layer referencing a missing asset is rejected", () => {
  const composition = buildProjectComposition(projectWithVideo());
  const invalid = structuredClone(composition);
  invalid.scenes[0].layers = invalid.scenes[0].layers.map((layer) =>
    layer.type === "video"
      ? { ...layer, assetId: "asset_missing_video" }
      : layer,
  );
  assert.equal(compositionSchema.safeParse(invalid).success, false);
});

test("video layer must reference a video asset, not an image", () => {
  const composition = buildProjectComposition(projectWithVideo());
  const invalid = structuredClone(composition);
  invalid.assets = invalid.assets.map((asset) =>
    asset.id === "asset_video_demo" ? { ...asset, type: "image" } : asset,
  );
  assert.equal(compositionSchema.safeParse(invalid).success, false);
});

test("trim range must be positive and inside the source clip", () => {
  const composition = buildProjectComposition(projectWithVideo());
  const invalid = structuredClone(composition);
  invalid.scenes[0].layers = invalid.scenes[0].layers.map((layer) =>
    layer.type === "video"
      ? { ...layer, trimStartMs: 5000, trimEndMs: 5050 }
      : layer,
  );
  assert.equal(compositionSchema.safeParse(invalid).success, false);
});

test("clip time formatting is stable for editors and toasts", () => {
  assert.equal(formatClipTime(0), "0:00.0");
  assert.equal(formatClipTime(9.5), "0:09.5");
  assert.equal(formatClipTime(65.25), "1:05.3");
  assert.equal(formatClipTime(Number.NaN), "0:00.0");
});
