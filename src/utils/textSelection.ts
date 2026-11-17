import type { MaskStroke } from "./mask";

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface TextRegion {
  /** Normalised image coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface TextSelectionResult {
  regions: TextRegion[];
  method: "text-detector" | "contrast-bands";
}

function luminance(data: Uint8ClampedArray | Uint8Array, index: number) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function edgeMask(pixels: PixelImage, threshold: number): Uint8Array {
  const { width, height, data } = pixels;
  const mask = new Uint8Array(width * height);
  if (width < 3 || height < 3) return mask;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      const center = luminance(data, index);
      const left = luminance(data, (y * width + x - 1) * 4);
      const right = luminance(data, (y * width + x + 1) * 4);
      const up = luminance(data, ((y - 1) * width + x) * 4);
      const down = luminance(data, ((y + 1) * width + x) * 4);
      const contrast =
        Math.max(center, left, right, up, down) -
        Math.min(center, left, right, up, down);
      if (contrast >= threshold) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function activeRuns(
  values: Uint16Array,
  minimum: number,
  maximumGap: number,
): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  let lastActive = -1;
  values.forEach((value, index) => {
    if (value >= minimum) {
      if (start < 0) start = index;
      lastActive = index;
    } else if (start >= 0 && index - lastActive > maximumGap) {
      runs.push([start, lastActive]);
      start = -1;
      lastActive = -1;
    }
  });
  if (start >= 0) runs.push([start, lastActive]);
  return runs;
}

function mergeLineRegions(regions: TextRegion[], width: number): TextRegion[] {
  const sorted = [...regions].sort((left, right) => {
    const vertical = left.y - right.y;
    return Math.abs(vertical) > 0.02 ? vertical : left.x - right.x;
  });
  const merged: TextRegion[] = [];
  for (const region of sorted) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const previousCenter = previous.y + previous.height / 2;
      const center = region.y + region.height / 2;
      const sameLine =
        Math.abs(previousCenter - center) <
        Math.max(previous.height, region.height) * 0.55;
      const gap = region.x - (previous.x + previous.width);
      if (sameLine && gap <= Math.max(2 / width, 0.035)) {
        const end = Math.max(
          previous.x + previous.width,
          region.x + region.width,
        );
        const bottom = Math.max(
          previous.y + previous.height,
          region.y + region.height,
        );
        previous.y = Math.min(previous.y, region.y);
        previous.width = end - previous.x;
        previous.height = bottom - previous.y;
        previous.confidence = Math.max(previous.confidence, region.confidence);
        continue;
      }
    }
    merged.push({ ...region });
  }
  return merged;
}

/**
 * Lightweight local OCR-free text-band detector. It looks for short,
 * high-contrast horizontal ink bands, then keeps candidates whose proportions
 * resemble lines of text. This runs entirely in the WebView and never uploads
 * the source image.
 */
export function detectTextRegions(
  pixels: PixelImage,
  options: { threshold?: number; maxRegions?: number } = {},
): TextRegion[] {
  const { width, height } = pixels;
  if (width < 16 || height < 16) return [];
  const threshold = Math.min(140, Math.max(24, options.threshold ?? 58));
  const maxRegions = Math.max(1, Math.min(64, options.maxRegions ?? 24));
  const edges = edgeMask(pixels, threshold);
  const rowCounts = new Uint16Array(height);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) count += edges[y * width + x];
    rowCounts[y] = Math.min(65_535, count);
  }
  const rowMinimum = Math.max(2, Math.round(width * 0.006));
  const rowBands = activeRuns(
    rowCounts,
    rowMinimum,
    Math.max(1, Math.round(height * 0.012)),
  );
  const regions: TextRegion[] = [];
  for (const [top, bottom] of rowBands) {
    const bandHeight = bottom - top + 1;
    if (bandHeight < 3 || bandHeight > height * 0.32) continue;
    const columnCounts = new Uint16Array(width);
    for (let y = top; y <= bottom; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!edges[y * width + x]) continue;
        columnCounts[x] += 1;
      }
    }
    const columnMinimum = Math.max(1, Math.round(bandHeight * 0.08));
    const columnBands = activeRuns(
      columnCounts,
      columnMinimum,
      Math.max(3, Math.round(width * 0.06)),
    );
    for (const [left, right] of columnBands) {
      const regionWidth = right - left + 1;
      const aspect = regionWidth / bandHeight;
      const area = regionWidth * bandHeight;
      let inkPixels = 0;
      for (let x = left; x <= right; x += 1) {
        inkPixels += columnCounts[x];
      }
      const density = inkPixels / Math.max(1, area);
      if (
        regionWidth < width * 0.025 ||
        aspect < 1.15 ||
        aspect > 42 ||
        density < 0.015 ||
        density > 0.55
      ) {
        continue;
      }
      const paddingX = Math.max(1, Math.round(regionWidth * 0.035));
      const paddingY = Math.max(1, Math.round(bandHeight * 0.18));
      const boxLeft = Math.max(0, left - paddingX);
      const boxTop = Math.max(0, top - paddingY);
      const boxRight = Math.min(width, right + paddingX + 1);
      const boxBottom = Math.min(height, bottom + paddingY + 1);
      regions.push({
        x: boxLeft / width,
        y: boxTop / height,
        width: (boxRight - boxLeft) / width,
        height: (boxBottom - boxTop) / height,
        confidence: Math.min(0.98, 0.58 + density * 1.8),
      });
    }
  }
  return mergeLineRegions(regions, width)
    .filter(
      (region) =>
        region.width >= 0.025 &&
        region.height >= 0.006 &&
        region.width * region.height <= 0.45,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .slice(0, maxRegions);
}

/**
 * Turn detected line boxes into brush-shaped mask strokes. Round brush caps
 * produce a soft capsule rather than a hard rectangular selection.
 */
export function textRegionsToStrokes(
  regions: TextRegion[],
  padding = 0.12,
  imageAspect = 1,
): MaskStroke[] {
  const safeAspect =
    Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1;
  return regions.map((region) => {
    const horizontalPadding = Math.max(0.002, region.width * padding);
    const verticalPadding = Math.max(0.002, region.height * padding);
    const left = Math.max(0, region.x - horizontalPadding);
    const right = Math.min(1, region.x + region.width + horizontalPadding);
    const top = Math.max(0, region.y - verticalPadding);
    const bottom = Math.min(1, region.y + region.height + verticalPadding);
    return {
      size: Math.max(0.004, (bottom - top) * safeAspect),
      points: [
        { x: left, y: (top + bottom) / 2 },
        { x: right, y: (top + bottom) / 2 },
      ],
    };
  });
}

interface NativeDetectedText {
  boundingBox: DOMRectReadOnly;
}

interface NativeTextDetector {
  detect(image: CanvasImageSource): Promise<NativeDetectedText[]>;
}

type TextDetectorConstructor = new () => NativeTextDetector;

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  // kmasset responses include CORS headers; anonymous mode keeps the canvas
  // readable in both the custom protocol and normal HTTP preview.
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return image;
}

export async function analyzeImageText(
  src: string,
  options: { maxSide?: number } = {},
): Promise<TextSelectionResult> {
  const image = await loadImage(src);
  const maxSide = Math.max(180, Math.min(960, options.maxSide ?? 640));
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.drawImage(image, 0, 0, width, height);

  const Detector = (
    globalThis as typeof globalThis & { TextDetector?: TextDetectorConstructor }
  ).TextDetector;
  if (Detector) {
    try {
      const detected = await new Detector().detect(canvas);
      const regions = detected
        .map((item) => ({
          x: item.boundingBox.x / width,
          y: item.boundingBox.y / height,
          width: item.boundingBox.width / width,
          height: item.boundingBox.height / height,
          confidence: 0.99,
        }))
        .filter(
          (region) =>
            region.width > 0.01 &&
            region.height > 0.004 &&
            region.x >= 0 &&
            region.y >= 0,
        );
      if (regions.length) return { regions, method: "text-detector" };
    } catch {
      // Shape Detection is optional and unavailable in most WebViews.
    }
  }

  const imageData = context.getImageData(0, 0, width, height);
  return {
    regions: detectTextRegions({
      width,
      height,
      data: imageData.data,
    }),
    method: "contrast-bands",
  };
}
