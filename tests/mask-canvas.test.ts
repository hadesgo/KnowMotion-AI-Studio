/**
 * 真实 Canvas alpha 像素测试。
 *
 * 这里不 mock canvas：用 Skia 实现（@napi-rs/canvas）当作浏览器 canvas，
 * 走 `buildMaskCanvases` 的真实绘制路径，再把产出的 PNG 解码回来逐像素断言。
 * 目的是锁死遮罩方向：涂抹区域必须是 alpha=0（可重绘），其余必须是 alpha=255（保留）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  EDITABLE_ALPHA,
  LOCKED_ALPHA,
  buildMaskCanvases,
  maskCoverage,
  type MaskStroke,
} from "../src/utils/mask";

// buildMaskCanvases 通过 document.createElement("canvas") 拿画布，这里替换成 Skia。
const globals = globalThis as unknown as {
  document?: { createElement: (tag: string) => unknown };
};
globals.document = {
  createElement(tag: string) {
    if (tag !== "canvas") throw new Error(`unexpected element: ${tag}`);
    return createCanvas(1, 1);
  },
};

type Rgba = { width: number; height: number; data: Uint8ClampedArray };

async function decodeMask(dataUrl: string, width: number, height: number): Promise<Rgba> {
  assert.ok(dataUrl.startsWith("data:image/png;base64,"), "mask must be a PNG data URL");
  const image = await loadImage(dataUrl);
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, width, height);
  return {
    width,
    height,
    data: new Uint8ClampedArray(imageData.data),
  };
}

function alphaAt(rgba: Rgba, x: number, y: number): number {
  return rgba.data[(y * rgba.width + x) * 4 + 3];
}

function transparentPixels(rgba: Rgba): number {
  let count = 0;
  for (let index = 3; index < rgba.data.length; index += 4) {
    if (rgba.data[index] === EDITABLE_ALPHA) count += 1;
  }
  return count;
}

/** PNG IHDR 的 color type：6 表示真彩色 + alpha 通道。 */
function pngColorType(dataUrl: string): number {
  const bytes = Buffer.from(dataUrl.split(",", 2)[1], "base64");
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  return bytes[25];
}

test("painted pixels become transparent and untouched pixels stay opaque", async () => {
  const width = 128;
  const height = 96;
  const strokes: MaskStroke[] = [{ size: 0.3, points: [{ x: 0.5, y: 0.5 }] }];

  const mask = buildMaskCanvases(strokes, width, height);
  const rgba = await decodeMask(mask.alphaMaskDataUrl, width, height);

  // 方向断言：笔迹中心 alpha = 0（可编辑），四角 alpha = 255（保留）。
  assert.equal(alphaAt(rgba, Math.floor(width / 2), Math.floor(height / 2)), EDITABLE_ALPHA);
  for (const [x, y] of [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]) {
    assert.equal(alphaAt(rgba, x, y), LOCKED_ALPHA, `corner ${x},${y} must stay locked`);
  }
  // 二值化后不应残留半透明像素，避免 Provider 各自解释边缘。
  for (let index = 3; index < rgba.data.length; index += 4) {
    const alpha = rgba.data[index];
    assert.ok(
      alpha === EDITABLE_ALPHA || alpha === LOCKED_ALPHA,
      `alpha ${alpha} is neither editable nor locked`,
    );
  }
  assert.equal(pngColorType(mask.alphaMaskDataUrl), 6, "mask PNG must carry an alpha channel");
});

test("rasterized mask area tracks the analytic coverage", async () => {
  const width = 160;
  const height = 160;
  const strokes: MaskStroke[] = [
    { size: 0.18, points: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }] },
  ];
  const mask = buildMaskCanvases(strokes, width, height);
  const rgba = await decodeMask(mask.alphaMaskDataUrl, width, height);
  const raster = transparentPixels(rgba) / (width * height);
  const analytic = maskCoverage(strokes);
  assert.ok(Math.abs(raster - analytic) < 0.02, `raster ${raster} vs analytic ${analytic}`);
  assert.ok(raster > 0.02 && raster < 0.35, `unexpected mask area ${raster}`);
});

test("multiple strokes all become editable and empty masks stay fully locked", async () => {
  const width = 96;
  const height = 96;
  const strokes: MaskStroke[] = [
    { size: 0.2, points: [{ x: 0.2, y: 0.2 }] },
    { size: 0.2, points: [{ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.8 }] },
  ];
  const masks = buildMaskCanvases(strokes, width, height);
  const rgba = await decodeMask(masks.alphaMaskDataUrl, width, height);
  assert.equal(alphaAt(rgba, 19, 19), EDITABLE_ALPHA);
  assert.equal(alphaAt(rgba, 48, 48), EDITABLE_ALPHA);
  assert.equal(alphaAt(rgba, 77, 77), EDITABLE_ALPHA);
  assert.equal(alphaAt(rgba, 90, 5), LOCKED_ALPHA);

  const empty = buildMaskCanvases([], width, height);
  const emptyRgba = await decodeMask(empty.alphaMaskDataUrl, width, height);
  assert.equal(transparentPixels(emptyRgba), 0, "an empty mask must not mark anything editable");
  assert.equal(empty.coverage, 0);
});

test("luminance mask paints white where the user drew and black elsewhere", async () => {
  const width = 96;
  const height = 96;
  const strokes: MaskStroke[] = [{ size: 0.3, points: [{ x: 0.5, y: 0.5 }] }];
  const mask = buildMaskCanvases(strokes, width, height);
  const rgba = await decodeMask(mask.luminanceMaskDataUrl, width, height);
  const center = (48 * width + 48) * 4;
  assert.deepEqual(
    [rgba.data[center], rgba.data[center + 1], rgba.data[center + 2]],
    [255, 255, 255],
    "painted pixel must be white for stable-diffusion.cpp masks",
  );
  assert.equal(rgba.data[center + 3], 255, "luminance mask stays opaque");
  const corner = 0;
  assert.deepEqual(
    [rgba.data[corner], rgba.data[corner + 1], rgba.data[corner + 2]],
    [0, 0, 0],
    "untouched pixel must be black",
  );
});

test("mask keeps the source image aspect size even for tiny requests", async () => {
  const mask = buildMaskCanvases(
    [{ size: 0.4, points: [{ x: 0.5, y: 0.5 }] }],
    1,
    1,
  );
  const rgba = await decodeMask(mask.alphaMaskDataUrl, 16, 16);
  assert.equal(rgba.width, 16);
  assert.equal(rgba.height, 16);
});

test("explicit feather creates soft alpha and luminance edges", async () => {
  const width = 128;
  const height = 96;
  const strokes: MaskStroke[] = [
    { size: 0.32, points: [{ x: 0.5, y: 0.5 }] },
  ];
  const mask = buildMaskCanvases(strokes, width, height, 5);
  assert.equal(mask.featherPx, 5);
  const alpha = await decodeMask(mask.alphaMaskDataUrl, width, height);
  let partial = 0;
  for (let index = 3; index < alpha.data.length; index += 4) {
    const value = alpha.data[index];
    if (value > EDITABLE_ALPHA && value < LOCKED_ALPHA) partial += 1;
  }
  assert.ok(partial > 0, "feathered alpha must contain semi-transparent edge pixels");

  const luminance = await decodeMask(mask.luminanceMaskDataUrl, width, height);
  let gray = 0;
  for (let index = 0; index < luminance.data.length; index += 4) {
    const value = luminance.data[index];
    if (value > 0 && value < 255) gray += 1;
  }
  assert.ok(gray > 0, "feathered luminance mask must contain gray edge pixels");
});
