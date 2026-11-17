/** 归一化坐标（0..1），渲染时再乘以图片像素尺寸。 */
export interface MaskPoint {
  x: number;
  y: number;
}

export interface MaskStroke {
  /** 笔刷直径，按图片宽度归一化。 */
  size: number;
  points: MaskPoint[];
}

export interface MaskCanvasPair {
  /** alpha 遮罩：透明 = 重绘（OpenAI Images edits）。 */
  alphaMaskDataUrl: string;
  /** 亮度遮罩：白 = 重绘（stable-diffusion.cpp 原生 img_gen）。 */
  luminanceMaskDataUrl: string;
  coverage: number;
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function hasMaskContent(strokes: MaskStroke[]): boolean {
  return strokes.some((stroke) => stroke.points.length > 0);
}

function strokeSegments(strokes: MaskStroke[]) {
  const segments: Array<[MaskPoint, MaskPoint, number]> = [];
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const radius = Math.max(0.002, stroke.size) / 2;
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      segments.push([point, point, radius]);
      continue;
    }
    for (let index = 1; index < stroke.points.length; index += 1) {
      segments.push([
        stroke.points[index - 1],
        stroke.points[index],
        radius,
      ]);
    }
  }
  return segments;
}

function distanceToSegment(
  px: number,
  py: number,
  start: MaskPoint,
  end: MaskPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - start.x, py - start.y);
  const t = clampUnit(
    ((px - start.x) * dx + (py - start.y) * dy) / lengthSquared,
  );
  return Math.hypot(px - (start.x + t * dx), py - (start.y + t * dy));
}

/**
 * 用网格采样估算遮罩覆盖率。纯函数、与 Canvas 无关，
 * 因此在单元测试里可以稳定验证，也用于写入素材元数据。
 */
export function maskCoverage(
  strokes: MaskStroke[],
  grid = 96,
): number {
  const segments = strokeSegments(strokes);
  if (!segments.length) return 0;
  const columns = Math.max(16, Math.round(grid));
  const rows = columns;
  let covered = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column + 0.5) / columns;
      const y = (row + 0.5) / rows;
      if (
        segments.some(
          ([start, end, radius]) =>
            distanceToSegment(x, y, start, end) <= radius,
        )
      ) {
        covered += 1;
      }
    }
  }
  return covered / (columns * rows);
}

export function maskBoundingBox(
  strokes: MaskStroke[],
): { x: number; y: number; width: number; height: number } | null {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (!points.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function drawStrokes(
  context: CanvasRenderingContext2D,
  strokes: MaskStroke[],
  width: number,
  height: number,
  color: string,
) {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.lineWidth = Math.max(1, stroke.size * width);
    const first = stroke.points[0];
    if (stroke.points.length === 1) {
      context.beginPath();
      context.arc(
        first.x * width,
        first.y * height,
        Math.max(0.5, (stroke.size * width) / 2),
        0,
        Math.PI * 2,
      );
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(first.x * width, first.y * height);
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x * width, point.y * height);
    }
    context.stroke();
  }
}

/**
 * 遮罩语义：**涂抹区域 alpha = 0（允许重绘），其余区域 alpha = 255（保持不变）**。
 *
 * OpenAI Images edits 与 stable-diffusion.cpp `/v1/images/edits` 都按这个方向解释遮罩：
 * 透明像素是可以被改写的区域，不透明像素必须回填原图。反方向会让“涂抹处不动、
 * 没涂的地方被重画”，这是第三轮审计的 P1 缺陷。
 */
export const EDITABLE_ALPHA = 0;
export const LOCKED_ALPHA = 255;

/**
 * 生成图片编辑接口所需的遮罩，两条通道约定不同，必须各给一份：
 *
 * - `alphaMaskDataUrl`：先把画布铺满不透明底色，再用 `destination-out` 把笔迹擦成透明。
 *   透明像素 = 允许重绘（OpenAI Images edits）。
 * - `luminanceMaskDataUrl`：黑底白笔迹。白色 = 允许重绘（stable-diffusion.cpp 原生 img_gen）。
 *
 * 两份遮罩尺寸都与源图一致，避免 Provider 端缩放导致遮罩错位。
 */
export function buildMaskCanvases(
  strokes: MaskStroke[],
  width: number,
  height: number,
): MaskCanvasPair {
  const safeWidth = Math.max(16, Math.round(width));
  const safeHeight = Math.max(16, Math.round(height));
  const alpha = document.createElement("canvas");
  alpha.width = safeWidth;
  alpha.height = safeHeight;
  const alphaContext = alpha.getContext("2d");
  if (!alphaContext) throw new Error("Canvas 2D context is unavailable");
  alphaContext.clearRect(0, 0, safeWidth, safeHeight);
  alphaContext.globalCompositeOperation = "source-over";
  alphaContext.fillStyle = "#000000";
  alphaContext.fillRect(0, 0, safeWidth, safeHeight);
  alphaContext.save();
  // 只在笔迹处把 alpha 擦成 0；不透明底色代表“保留原像素”。
  alphaContext.globalCompositeOperation = "destination-out";
  drawStrokes(alphaContext, strokes, safeWidth, safeHeight, "#000000");
  alphaContext.restore();
  alphaContext.globalCompositeOperation = "source-over";
  binarizeMaskAlpha(alphaContext, safeWidth, safeHeight);

  const luminance = document.createElement("canvas");
  luminance.width = safeWidth;
  luminance.height = safeHeight;
  const luminanceContext = luminance.getContext("2d");
  if (!luminanceContext) throw new Error("Canvas 2D context is unavailable");
  luminanceContext.fillStyle = "#000000";
  luminanceContext.fillRect(0, 0, safeWidth, safeHeight);
  drawStrokes(luminanceContext, strokes, safeWidth, safeHeight, "#FFFFFF");

  return {
    alphaMaskDataUrl: alpha.toDataURL("image/png"),
    luminanceMaskDataUrl: luminance.toDataURL("image/png"),
    coverage: maskCoverage(strokes),
  };
}

/** 抗锯齿边缘会留下半透明像素；Provider 对半透明的解释各不相同，这里二值化。 */
export const MASK_ALPHA_THRESHOLD = 128;

function binarizeMaskAlpha(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  for (let index = 3; index < pixels.length; index += 4) {
    pixels[index] =
      pixels[index] >= MASK_ALPHA_THRESHOLD ? LOCKED_ALPHA : EDITABLE_ALPHA;
  }
  context.putImageData(image, 0, 0);
}

export function sizeForImage(width: number, height: number):
  | "1024x1024"
  | "1536x1024"
  | "1024x1536" {
  if (!width || !height) return "1024x1024";
  const ratio = width / height;
  if (ratio > 1.1) return "1536x1024";
  if (ratio < 0.9) return "1024x1536";
  return "1024x1024";
}
