import assert from "node:assert/strict";
import test from "node:test";
import { createCharacter, makeSampleProject } from "../src/data/demo";
import {
  channelLabel,
  conditioningPayload,
  planConditioning,
  providerConditioningModes,
  resolveCharacterLock,
  strengthFromWeight,
} from "../src/services/characterLock";
import type { Asset, ProviderProfile, VideoProject } from "../src/types";

const sdProvider: ProviderProfile = {
  id: "provider-sd",
  name: "本地 stable-diffusion.cpp",
  protocol: "stable-diffusion.cpp",
  baseUrl: "http://127.0.0.1:1234",
  model: "qwen-image",
  capabilities: ["Image"],
  enabled: true,
  health: "healthy",
  hasSecret: false,
  isDefault: true,
};

const openAiProvider: ProviderProfile = {
  ...sdProvider,
  id: "provider-openai",
  name: "OpenAI Compatible",
  protocol: "OpenAI Compatible",
  baseUrl: "https://api.example.com",
  model: "gpt-image-1",
};

function reference(
  id: string,
  weight: number,
  locked = false,
  entityId = "character-locked",
): Asset {
  return {
    id,
    sceneId: "",
    name: id,
    kind: "image",
    src: "data:image/png;base64,AAAA",
    prompt: "reference",
    createdAt: "2026-11-16T00:00:00.000Z",
    local: true,
    reference: {
      role: "character",
      entityId,
      label: id,
      weight,
      locked,
      notes: "",
    },
  };
}

function lockedProject(): VideoProject {
  const project = makeSampleProject();
  const character = createCharacter("林博士", "解说者");
  character.id = "character-locked";
  const front = reference("asset_front", 0.6);
  const side = reference("asset_side", 0.95, true);
  character.referenceAssetIds = [front.id, side.id];
  character.lock = {
    enabled: true,
    mode: "ip-adapter",
    weight: 0.8,
    controlType: "pose",
    startAt: 0.1,
    endAt: 0.9,
  };
  project.characters = [character];
  project.assets = [front, side];
  project.scenes[0] = { ...project.scenes[0], characterIds: [character.id] };
  return project;
}

test("sd.cpp declares the full pixel conditioning ladder", () => {
  assert.deepEqual(providerConditioningModes(sdProvider), [
    "controlnet",
    "ip-adapter",
    "img2img-reference",
  ]);
  assert.deepEqual(providerConditioningModes(openAiProvider), []);
  assert.deepEqual(providerConditioningModes({ ...sdProvider, enabled: false }), []);
});

test("planning keeps the requested channel when the provider supports it", () => {
  const project = lockedProject();
  const plan = planConditioning(project, project.scenes[0], sdProvider);
  assert.equal(plan.requested, "ip-adapter");
  assert.equal(plan.channel, "prompt+ip-adapter");
  assert.equal(plan.referenceAssetId, "asset_side");
  assert.equal(plan.controlType, "pose");
  assert.equal(plan.startAt, 0.1);
  assert.equal(plan.endAt, 0.9);
  assert.deepEqual(plan.degradations, []);
  assert.equal(plan.strength, strengthFromWeight(0.8));
});

test("prompt-only providers degrade with an explicit reason", () => {
  const project = lockedProject();
  const plan = planConditioning(project, project.scenes[0], openAiProvider);
  assert.equal(plan.channel, "prompt");
  assert.equal(plan.degradations.length, 1);
  assert.match(plan.degradations[0], /OpenAI Compatible/);
  assert.equal(plan.referenceAssetId, undefined);
  assert.equal(conditioningPayload(plan), undefined);
});

test("characters without references produce a warning instead of a silent lock", () => {
  const project = lockedProject();
  project.assets = [];
  project.characters[0].referenceAssetIds = [];
  const plan = planConditioning(project, project.scenes[0], sdProvider);
  assert.equal(plan.channel, "prompt");
  assert.equal(plan.locks.length, 0);
  assert.match(plan.warnings[0], /没有参考图/);
});

test("multiple locked characters keep the heaviest one and say so", () => {
  const project = lockedProject();
  const second = createCharacter("旁白", "解说者");
  const secondReference = reference("asset_second", 0.7, false, second.id);
  second.referenceAssetIds = [secondReference.id];
  project.characters.push(second);
  project.assets.push(secondReference);
  project.scenes[0] = {
    ...project.scenes[0],
    characterIds: ["character-locked", second.id],
  };
  const plan = planConditioning(project, project.scenes[0], sdProvider);
  assert.equal(plan.locks.length, 2);
  assert.equal(plan.referenceAssetId, "asset_side");
  assert.match(plan.warnings[0], /只把权重最高的/);
});

test("payload mirrors the granted channel and the derived strength", () => {
  const project = lockedProject();
  const plan = planConditioning(project, project.scenes[0], sdProvider);
  const payload = conditioningPayload(plan);
  assert.ok(payload);
  assert.equal(payload!.mode, "ip-adapter");
  assert.equal(payload!.referenceAssetId, "asset_side");
  assert.equal(payload!.lockCount, 1);
  assert.ok(payload!.strength > 0 && payload!.strength <= 1);
  assert.equal(channelLabel(plan.channel), "IP-Adapter 参考锁");
});

test("lock weights resolve defensively for legacy characters", () => {
  const character = createCharacter("旧角色", "解说者");
  const lock = resolveCharacterLock(character);
  assert.equal(lock.enabled, true);
  assert.equal(lock.mode, "img2img-reference");
  assert.ok(lock.weight > 0 && lock.weight < 1);

  character.lock = { ...lock, weight: 4, startAt: -1, endAt: 3 };
  const clamped = resolveCharacterLock(character);
  assert.equal(clamped.weight, 1);
  assert.equal(clamped.startAt, 0);
  assert.equal(clamped.endAt, 1);
});

test("strength is inversely related to lock weight", () => {
  assert.ok(strengthFromWeight(0) > strengthFromWeight(1));
  assert.equal(strengthFromWeight(-2), 0.85);
  assert.equal(strengthFromWeight(5), 0.3);
});
