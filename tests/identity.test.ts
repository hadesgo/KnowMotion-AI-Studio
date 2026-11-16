import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSignatures,
  extractSignature,
  mergeSignatures,
  signatureConsensus,
  verdictForScore,
  type PixelBuffer,
} from "../src/services/identity";

function createBuffer(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

function solid(width: number, height: number, rgb: [number, number, number]) {
  return createBuffer(width, height, () => rgb);
}

/** 合成「人像」：皮肤色椭圆 + 深色头发 + 不同背景，用于验证人脸区域估计。 */
function portrait(background: [number, number, number], shiftX = 0) {
  return createBuffer(160, 160, (x, y) => {
    const cx = 80 + shiftX;
    const cy = 88;
    const nx = (x - cx) / 34;
    const ny = (y - cy) / 44;
    const inFace = nx * nx + ny * ny <= 1;
    const hair = y < 56 && Math.abs(x - cx) < 40;
    if (hair) return [38, 28, 26];
    if (inFace) {
      const shade = 1 - Math.abs(nx) * 0.12;
      return [Math.round(226 * shade), Math.round(176 * shade), Math.round(142 * shade)];
    }
    return background;
  });
}

test("identical pixels score 1 and pass", () => {
  const image = portrait([60, 120, 180]);
  const signature = extractSignature(image);
  const comparison = compareSignatures(signature, extractSignature(image));
  assert.equal(comparison.verdict, "pass");
  assert.ok(comparison.score > 0.99, `expected ~1, got ${comparison.score}`);
  assert.equal(comparison.method, "pixel");
});

test("same subject with small jitter still matches", () => {
  const left = extractSignature(portrait([60, 120, 180]));
  const right = extractSignature(portrait([60, 120, 180], 3));
  const comparison = compareSignatures(left, right);
  assert.ok(comparison.score > 0.5, `expected > 0.5, got ${comparison.score}`);
  assert.notEqual(comparison.verdict, "fail");
});

test("a different composition is rejected", () => {
  const face = extractSignature(portrait([60, 120, 180]));
  const flat = extractSignature(solid(160, 160, [12, 12, 12]));
  const striped = extractSignature(
    createBuffer(160, 160, (x, y) =>
      (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? [250, 250, 250] : [15, 15, 15],
    ),
  );
  assert.equal(compareSignatures(face, flat).verdict, "fail");
  assert.equal(compareSignatures(face, striped).verdict, "fail");
});

test("face region is detected around a centred portrait", () => {
  const signature = extractSignature(portrait([60, 120, 180]));
  assert.ok(signature.face, "expected a face region");
  const box = signature.face!.box;
  assert.ok(box.x < 0.5 && box.x + box.width > 0.5, `face box should be centred: ${JSON.stringify(box)}`);
  assert.ok(box.width > 0.2 && box.height > 0.2);
});

test("merging references keeps both views close to the centroid", () => {
  const front = extractSignature(portrait([60, 120, 180]));
  const side = extractSignature(portrait([40, 90, 150], -8));
  const other = extractSignature(solid(160, 160, [220, 60, 40]));
  const centroid = mergeSignatures([front, side]);
  assert.equal(centroid.sampleCount, 2);
  const toFront = compareSignatures(centroid, front).score;
  const toSide = compareSignatures(centroid, side).score;
  const toOther = compareSignatures(centroid, other).score;
  assert.ok(toFront > toOther, `${toFront} should beat ${toOther}`);
  assert.ok(toSide > toOther, `${toSide} should beat ${toOther}`);
});

test("consensus exposes references that disagree with each other", () => {
  const front = extractSignature(portrait([60, 120, 180]));
  const side = extractSignature(portrait([60, 120, 180], -6));
  const unrelated = extractSignature(solid(160, 160, [30, 30, 30]));
  assert.ok(signatureConsensus([front, side]) > 0.5);
  assert.ok(signatureConsensus([front, unrelated]) < 0.6);
});

test("verdicts follow the configured thresholds", () => {
  assert.equal(verdictForScore(0.95), "pass");
  assert.equal(verdictForScore(0.6), "warn");
  assert.equal(verdictForScore(0.2), "fail");
  assert.equal(verdictForScore(0.6, { pass: 0.9, warn: 0.55 }), "warn");
});

test("signatures from incompatible engines are refused", () => {
  const signature = extractSignature(portrait([60, 120, 180]));
  const forged = { ...signature, version: "identity-v0" as never };
  assert.throws(() => compareSignatures(signature, forged));
});

test("degenerate input fails loudly instead of producing a score", () => {
  assert.throws(() => extractSignature(solid(4, 4, [0, 0, 0])));
  assert.throws(() =>
    extractSignature({ data: new Uint8ClampedArray(8 * 8 * 4), width: 16, height: 16 }),
  );
});
