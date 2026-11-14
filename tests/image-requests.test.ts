import assert from "node:assert/strict";
import test from "node:test";
import { createCharacter, makeSampleProject } from "../src/data/demo";
import { buildAnchoredImageRequest } from "../src/services/imageRequests";
import { resolveSceneAnchors } from "../src/services/consistency";
import type { Asset, ProviderProfile, VideoProject } from "../src/types";

const provider: ProviderProfile = {
  id: "provider-comfy",
  name: "Local ComfyUI",
  protocol: "ComfyUI",
  baseUrl: "http://127.0.0.1:8188",
  model: "sdxl.safetensors",
  capabilities: ["Image"],
  enabled: true,
  health: "healthy",
  hasSecret: false,
  isDefault: true,
};

function anchoredProject(): VideoProject {
  const project = makeSampleProject();
  const character = createCharacter("林博士", "解说者");
  character.appearance = "短卷发，圆框眼镜";
  project.characters = [character];
  const reference: Asset = {
    id: "asset_ref_lin",
    sceneId: "",
    name: "林博士参考",
    kind: "image",
    src: "data:image/png;base64,AAAA",
    prompt: "reference",
    createdAt: "2026-11-14T00:00:00.000Z",
    local: true,
    reference: {
      role: "character",
      entityId: character.id,
      label: "林博士 · 定妆",
      weight: 0.9,
      locked: true,
      notes: "",
    },
  };
  character.referenceAssetIds = [reference.id];
  project.assets = [reference];
  project.scenes[0] = { ...project.scenes[0], characterIds: [character.id] };
  return project;
}

test("batch request carries anchors, references and a stable seed", () => {
  const project = anchoredProject();
  const anchors = resolveSceneAnchors(project, project.scenes[0]);
  const request = buildAnchoredImageRequest({
    project,
    scene: project.scenes[0],
    provider,
    style: "电影感纪录片",
    size: "1536x1024",
    count: 2,
    useAnchors: true,
  });

  assert.equal(request.projectId, project.id);
  assert.match(request.prompt, /\[CONSISTENCY LOCK\]/);
  assert.equal(request.seed, anchors.seed);
  assert.equal(request.consistencyFingerprint, anchors.fingerprint);
  assert.equal(request.anchorLabel, "林博士");
  assert.equal(request.references?.length, 1);
  assert.equal(request.references?.[0].source, "data:image/png;base64,AAAA");
  assert.equal(request.count, 2);
  assert.equal(request.size, "1536x1024");
});

test("disabling anchors falls back to the raw scene prompt", () => {
  const project = anchoredProject();
  const request = buildAnchoredImageRequest({
    project,
    scene: project.scenes[0],
    provider,
    style: "电影感纪录片",
    size: "1024x1024",
    count: 1,
    useAnchors: false,
  });

  assert.equal(request.prompt, project.scenes[0].visualPrompt);
  assert.deepEqual(request.references, []);
  assert.equal(request.seed, undefined);
  assert.equal(request.anchorLabel, "");
});

test("scene without anchors still produces a valid request", () => {
  const project = makeSampleProject();
  const request = buildAnchoredImageRequest({
    project,
    scene: project.scenes[1],
    provider,
    style: "",
    size: "1024x1024",
    count: 1,
    useAnchors: true,
  });
  assert.equal(request.prompt, project.scenes[1].visualPrompt);
  assert.equal(request.consistencyFingerprint, "");
  assert.equal(request.anchorLabel, "");
});
