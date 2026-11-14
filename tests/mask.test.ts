import assert from "node:assert/strict";
import test from "node:test";
import {
  clampUnit,
  hasMaskContent,
  maskBoundingBox,
  maskCoverage,
  sizeForImage,
  type MaskStroke,
} from "../src/utils/mask";

test("empty mask has no content and zero coverage", () => {
  assert.equal(hasMaskContent([]), false);
  assert.equal(maskCoverage([]), 0);
  assert.equal(maskBoundingBox([]), null);
});

test("a single brush dot keeps a positive but bounded coverage", () => {
  const strokes: MaskStroke[] = [
    { size: 0.2, points: [{ x: 0.5, y: 0.5 }] },
  ];
  const coverage = maskCoverage(strokes);
  assert.ok(hasMaskContent(strokes));
  assert.ok(coverage > 0.005, `coverage ${coverage}`);
  assert.ok(coverage < 0.12, `coverage ${coverage}`);
});

test("bounding box follows normalized stroke points", () => {
  const box = maskBoundingBox([
    { size: 0.04, points: [{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.55 }] },
  ]);
  assert.ok(box);
  assert.ok(Math.abs(box.x - 0.2) < 1e-9);
  assert.ok(Math.abs(box.y - 0.3) < 1e-9);
  assert.ok(Math.abs(box.width - 0.4) < 1e-9);
  assert.ok(Math.abs(box.height - 0.25) < 1e-9);
});

test("clampUnit and sizeForImage normalise user input", () => {
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(2), 1);
  assert.equal(clampUnit(Number.NaN), 0);
  assert.equal(sizeForImage(1536, 1024), "1536x1024");
  assert.equal(sizeForImage(1024, 1536), "1024x1536");
  assert.equal(sizeForImage(1024, 1024), "1024x1024");
  assert.equal(sizeForImage(0, 0), "1024x1024");
});
