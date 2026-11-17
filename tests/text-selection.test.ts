import assert from "node:assert/strict";
import test from "node:test";
import {
  detectTextRegions,
  textRegionsToStrokes,
  type PixelImage,
} from "../src/utils/textSelection";

function syntheticImage(
  width: number,
  height: number,
  paint: (setPixel: (x: number, y: number, value: number) => void) => void,
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 250;
    data[index + 1] = 250;
    data[index + 2] = 250;
    data[index + 3] = 255;
  }
  paint((x, y, value) => {
    const index = (y * width + x) * 4;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  });
  return { width, height, data };
}

test("text-like high-contrast line is selected without a model download", () => {
  const pixels = syntheticImage(240, 160, (setPixel) => {
    // Black glyph blocks separated by narrow white gaps.
    for (let glyph = 0; glyph < 7; glyph += 1) {
      const left = 28 + glyph * 23;
      for (let y = 48; y < 64; y += 1) {
        for (let x = left; x < left + 14; x += 1) setPixel(x, y, 15);
      }
    }
  });
  const regions = detectTextRegions(pixels);
  assert.ok(regions.length >= 1, "expected at least one text line");
  assert.ok(
    regions.some(
      (region) =>
        region.y < 0.4 &&
        region.y + region.height > 0.3 &&
        region.width > 0.45,
    ),
    JSON.stringify(regions),
  );
});

test("blank image produces no automatic text selection", () => {
  assert.deepEqual(detectTextRegions(syntheticImage(160, 120, () => {})), []);
});

test("text boxes become bounded round brush strokes", () => {
  const strokes = textRegionsToStrokes([
    { x: 0.1, y: 0.2, width: 0.5, height: 0.08, confidence: 0.9 },
  ]);
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0].points.length, 2);
  assert.ok(strokes[0].size >= 0.08);
  for (const point of strokes[0].points) {
    assert.ok(point.x >= 0 && point.x <= 1);
    assert.ok(point.y >= 0 && point.y <= 1);
  }
});
