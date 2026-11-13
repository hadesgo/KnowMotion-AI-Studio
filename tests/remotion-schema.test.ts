import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, makeSampleProject } from "../src/data/demo";
import { evaluateGsapMotion } from "../src/gsap/gsapMotion";
import {
  buildProjectComposition,
  compositionSchema,
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
