import assert from "node:assert/strict";
import test from "node:test";
import { createCharacter, createLocation, makeSampleProject } from "../src/data/demo";
import {
  composeAnchoredPrompt,
  consistencyReport,
  createConsistencyStamp,
  evaluateConsistency,
  parsePalette,
  resolveSceneAnchors,
  seedFromFingerprint,
  stableHash,
} from "../src/services/consistency";
import type { Asset, VideoProject } from "../src/types";

function referenceAsset(characterId: string): Asset {
  return {
    id: "asset_reference_character",
    sceneId: "",
    name: "林博士 · 定妆参考",
    kind: "image",
    src: "data:image/png;base64,AAAA",
    prompt: "character sheet",
    createdAt: "2026-11-14T00:00:00.000Z",
    local: true,
    reference: {
      role: "character",
      entityId: characterId,
      label: "林博士 · 定妆参考",
      weight: 0.85,
      locked: true,
      notes: "正面半身",
    },
  };
}

function anchoredProject(): VideoProject {
  const project = makeSampleProject();
  const character = createCharacter("林博士", "解说者");
  character.appearance = "短卷发，圆框眼镜，深色高领毛衣";
  character.wardrobe = "米白色实验服";
  character.palette = ["#c8ff65", "#0c3540"];
  const location = createLocation("深夜天文台");
  location.environment = "圆顶观测室，黄铜望远镜，散落星图";
  location.lighting = "冷蓝月光与暖色台灯混合";
  location.timeOfDay = "深夜";
  project.characters = [character];
  project.locations = [location];
  project.styleLock = {
    enabled: true,
    descriptor: "电影感纪录片，低照度，细腻颗粒",
    palette: ["#0c3540", "#79a9ff"],
    negative: "卡通，低清晰度",
    referenceAssetIds: [],
  };
  project.assets = [referenceAsset(character.id)];
  character.referenceAssetIds = [project.assets[0].id];
  project.scenes = project.scenes.map((scene) => ({
    ...scene,
    characterIds: [character.id],
    locationId: location.id,
  }));
  return project;
}

test("stableHash is deterministic and input sensitive", () => {
  assert.equal(stableHash("knowmotion"), stableHash("knowmotion"));
  assert.notEqual(stableHash("knowmotion"), stableHash("knowmotion "));
  assert.match(stableHash("knowmotion"), /^[0-9a-f]{16}$/);
});

test("scene anchors resolve to a stable fingerprint, seed and directive", () => {
  const project = anchoredProject();
  const scene = project.scenes[0];
  const first = resolveSceneAnchors(project, scene);
  const second = resolveSceneAnchors(project, scene);

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.seed, second.seed);
  assert.equal(first.seed, seedFromFingerprint(first.fingerprint));
  assert.equal(first.label, "电影感纪录片，低照度，细腻颗粒 · 林博士 · 深夜天文台");
  assert.match(first.directive, /短卷发，圆框眼镜/);
  assert.match(first.directive, /圆顶观测室/);
  assert.match(first.directive, /Reference images are authoritative/);
  assert.deepEqual(first.referenceAssetIds, [project.assets[0].id]);
  assert.match(first.negativePrompt, /卡通/);
  assert.deepEqual(first.missing, []);
});

test("editing an appearance anchor invalidates the previous generation", () => {
  const project = anchoredProject();
  const scene = project.scenes[0];
  const anchors = resolveSceneAnchors(project, scene);
  const stamp = createConsistencyStamp(anchors, "prompt", "prompt+img2img");
  const asset: Asset = {
    id: "asset_scene_1",
    sceneId: scene.id,
    name: "AI 视觉 1",
    kind: "image",
    src: "data:image/png;base64,AAAA",
    prompt: "prompt",
    createdAt: stamp.generatedAt,
    local: true,
    consistency: stamp,
  };
  project.assets.push(asset);
  project.scenes[0] = { ...scene, assetId: asset.id };

  const before = evaluateConsistency(project, project.scenes[0]);
  assert.equal(before.evaluation.status, "consistent");

  project.characters[0] = {
    ...project.characters[0],
    appearance: "寸头，黑框眼镜，灰色连帽衫",
  };
  const after = evaluateConsistency(project, project.scenes[0]);
  assert.equal(after.evaluation.status, "stale");
  assert.notEqual(after.anchors.fingerprint, anchors.fingerprint);
  assert.match(after.anchors.directive, /寸头，黑框眼镜/);
  assert.doesNotMatch(after.anchors.directive, /短卷发/);
});

test("reference images enter both the prompt and the fingerprint", () => {
  const project = anchoredProject();
  const withoutRefs = resolveSceneAnchors(project, project.scenes[0]);
  project.characters[0] = {
    ...project.characters[0],
    referenceAssetIds: [],
  };
  const stripped = resolveSceneAnchors(project, project.scenes[0]);

  assert.notEqual(withoutRefs.fingerprint, stripped.fingerprint);
  assert.deepEqual(stripped.referenceAssetIds, []);
  assert.doesNotMatch(stripped.directive, /Reference images are authoritative/);
  assert.ok(
    stripped.missing.some((item) => item.includes("没有像素级参考图")),
  );
  assert.equal(
    composeAnchoredPrompt("shot", stripped),
    `shot. ${stripped.directive}`,
  );
});

test("anchored prompt composition is idempotent", () => {
  const project = anchoredProject();
  const anchors = resolveSceneAnchors(project, project.scenes[0]);
  const once = composeAnchoredPrompt("wide shot of the observatory", anchors);
  const twice = composeAnchoredPrompt(once, anchors);
  assert.equal(once, twice);
});

test("report scores unanchored scenes low and fully consistent projects at 100", () => {
  const bare = makeSampleProject();
  const bareScore = consistencyReport(bare).score;
  assert.equal(bareScore, 10);
  assert.equal(consistencyReport(bare).unanchored, bare.scenes.length);

  const project = anchoredProject();
  project.scenes = project.scenes.map((scene, index) => {
    const anchors = resolveSceneAnchors(project, scene);
    const asset: Asset = {
      id: `asset_locked_${index}`,
      sceneId: scene.id,
      name: `AI 视觉 ${index + 1}`,
      kind: "image",
      src: "data:image/png;base64,AAAA",
      prompt: anchors.directive,
      createdAt: "2026-11-14T00:00:00.000Z",
      local: true,
      consistency: createConsistencyStamp(
        anchors,
        anchors.directive,
        "prompt+img2img",
      ),
    };
    project.assets.push(asset);
    return { ...scene, assetId: asset.id };
  });

  const report = consistencyReport(project);
  assert.equal(report.consistent, project.scenes.length);
  assert.equal(report.anchored, project.scenes.length);
  assert.equal(report.score, 100);
  assert.equal(report.referenceImages, 1);
});

test("palette text parsing normalises hex values", () => {
  assert.deepEqual(parsePalette("#c8ff65, 79a9ff  #ffbc66"), [
    "#c8ff65",
    "#79a9ff",
    "#ffbc66",
  ]);
  assert.deepEqual(parsePalette(""), []);
});
