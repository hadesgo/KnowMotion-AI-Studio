import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, makeSampleProject } from "../src/data/demo";
import { evaluateGsapMotion } from "../src/gsap/gsapMotion";
import {
  buildProjectComposition,
  compositionSchema,
  sceneDslSchema,
  validateComposition,
} from "../src/remotion/schema";

test("sample project converts to a renderable composition", () => {
  const composition = buildProjectComposition(makeSampleProject());
  const result = validateComposition(composition);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.ok(composition.durationInFrames > 0);
  assert.ok(composition.scenes.length >= 3);
});

test("duration mismatch is rejected before rendering", () => {
  const composition = buildProjectComposition(makeSampleProject());
  const result = compositionSchema.safeParse({
    ...composition,
    durationInFrames: composition.durationInFrames + 1,
  });
  assert.equal(result.success, false);
});

test("editor Canvas layers are preserved in the shared Remotion DSL", () => {
  const project = makeSampleProject();
  const canvas = createLayer("canvas", project.scenes[0].layers.length);
  canvas.canvasVariant = "network";
  canvas.density = 48;
  canvas.end = project.scenes[0].duration;
  project.scenes[0] = {
    ...project.scenes[0],
    layers: [...project.scenes[0].layers, canvas],
  };

  const composition = buildProjectComposition(project);
  const layer = composition.scenes[0].layers.find(
    (item) => item.id === canvas.id,
  );

  assert.equal(layer?.type, "canvas");
  if (layer?.type === "canvas") {
    assert.equal(layer.variant, "network");
    assert.equal(layer.density, 48);
  }
  assert.equal(validateComposition(composition).valid, true);
});

test("GSAP motion is deterministic and reaches generated Remotion layers", () => {
  const project = makeSampleProject();
  project.scenes[0] = {
    ...project.scenes[0],
    gsapMotion: {
      preset: "orbit",
      intensity: 0.7,
      speed: 0.8,
    },
  };
  const composition = buildProjectComposition(project);
  assert.equal(composition.scenes[0].gsap?.preset, "orbit");

  const first = evaluateGsapMotion(project.scenes[0].gsapMotion, 1250);
  const repeated = evaluateGsapMotion(project.scenes[0].gsapMotion, 1250);
  const later = evaluateGsapMotion(project.scenes[0].gsapMotion, 2100);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, later);
});

test("legacy null GSAP fields are normalized instead of crashing the render editor", () => {
  const project = makeSampleProject();
  const composition = buildProjectComposition(project);
  const legacyScene = {
    ...composition.scenes[0],
    gsap: null,
    layers: composition.scenes[0].layers.map((layer) => ({
      ...layer,
      gsap: null,
    })),
  };
  const parsedLegacyScene = sceneDslSchema.parse(legacyScene);
  assert.equal(parsedLegacyScene.gsap, undefined);
  assert.ok(parsedLegacyScene.layers.every((layer) => layer.gsap === undefined));

  Object.assign(project.scenes[0], {
    gsapMotion: null,
    remotion: undefined,
  });

  let normalized: ReturnType<typeof buildProjectComposition>;
  try {
    normalized = buildProjectComposition(project);
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  }

  assert.equal(normalized.scenes[0].gsap, undefined);
  assert.ok(normalized.scenes[0].layers.every((layer) => layer.gsap === undefined));
  assert.equal(validateComposition(normalized).valid, true);
});

test("LLM context explainers use semantic mechanism diagrams, not generic assets", () => {
  const project = makeSampleProject();
  project.settings.topic = "大语言模型怎样理解上下文？";
  const specifications = [
    {
      title: "它真的记住前文了吗？",
      narration: "离开当前输入后，模型不会自动保留整段对话。",
    },
    {
      title: "输入先被切成 token",
      narration: "文本会先经过分词器，变成离散 token。",
    },
    {
      title: "注意力计算相关权重",
      narration: "每个 token 会和前文计算相关权重。",
    },
    {
      title: "上下文窗口有读取范围",
      narration: "一次推理只能读取当前窗口里的内容。",
    },
    {
      title: "理解上下文是组织线索",
      narration: "读取线索、保留顺序、计算关联并组织成结构。",
    },
  ];
  project.scenes = project.scenes.map((scene, index) => ({
    ...scene,
    ...specifications[index],
  }));

  const composition = buildProjectComposition(project);
  const variants = composition.scenes.map(
    (scene) =>
      scene.layers.find((layer) => layer.type === "diagram")?.type === "diagram"
        ? scene.layers.find((layer) => layer.type === "diagram")?.variant
        : undefined,
  );

  assert.deepEqual(variants, [
    "contextBridge",
    "tokenSequence",
    "attentionMechanism",
    "contextWindow",
    "contextSummary",
  ]);
  assert.ok(
    composition.scenes.every(
      (scene) => !scene.layers.some((layer) => layer.type === "image"),
    ),
  );
  assert.equal(validateComposition(composition).valid, true);
});
