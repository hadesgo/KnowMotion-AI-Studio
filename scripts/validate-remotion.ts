import assert from "node:assert/strict";
import { makeSampleProject } from "../src/data/demo";
import {
  buildProjectComposition,
  validateComposition,
} from "../src/remotion/schema";

const project = makeSampleProject();
const composition = buildProjectComposition(project);
const validation = validateComposition(composition);

assert.equal(validation.valid, true, validation.errors.join("\n"));
assert.ok(composition.scenes.length >= 3, "示例必须至少包含三个场景");
assert.ok(
  new Set(composition.scenes.map((scene) => scene.styleVariant)).size >= 3,
  "示例必须包含至少三种视觉风格",
);

const layerTypes = new Set<string>(
  composition.scenes.flatMap((scene) => scene.layers.map((layer) => layer.type)),
);
for (const required of ["text", "svg", "image", "chart"]) {
  assert.ok(layerTypes.has(required), `示例缺少 ${required} 图层`);
}

console.log(
  `Remotion composition valid: ${composition.scenes.length} scenes, ${new Set(composition.scenes.map((scene) => scene.styleVariant)).size} styles, ${composition.durationInFrames} frames.`,
);
