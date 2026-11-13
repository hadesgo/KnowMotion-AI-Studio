import assert from "node:assert/strict";
import test from "node:test";
import { makeSampleProject } from "../src/data/demo";
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
