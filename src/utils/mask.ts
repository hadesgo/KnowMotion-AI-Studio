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
  maskDataUrl: string;
  alphaMaskDataUrl: string;
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
 * 生成两张遮罩：
 * - mask：黑底白区，供 ComfyUI LoadImageMask 使用；
 * - alphaMask：透明底黑区，供 OpenAI images/edits 使用。
 */
export function buildMaskCanvases(
  strokes: MaskStroke[],
  width: number,
  height: number,
): MaskCanvasPair {
  const safeWidth = Math.max(16, Math.round(width));
  const safeHeight = Math.max(16, Math.round(height));
  const mask = document.createElement("canvas");
  mask.width = safeWidth;
  mask.height = safeHeight;
  const maskContext = mask.getContext("2d");
  if (!maskContext) throw new Error("Canvas 2D context is unavailable");
  maskContext.fillStyle = "#000000";
  maskContext.fillRect(0, 0, safeWidth, safeHeight);
  drawStrokes(maskContext, strokes, safeWidth, safeHeight, "#ffffff");

  const alpha = document.createElement("canvas");
  alpha.width = safeWidth;
  alpha.height = safeHeight;
  const alphaContext = alpha.getContext("2d");
  if (!alphaContext) throw new Error("Canvas 2D context is unavailable");
  alphaContext.clearRect(0, 0, safeWidth, safeHeight);
  drawStrokes(alphaContext, strokes, safeWidth, safeHeight, "#000000");

  return {
    maskDataUrl: mask.toDataURL("image/png"),
    alphaMaskDataUrl: alpha.toDataURL("image/png"),
    coverage: maskCoverage(strokes),
  };
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
