/**
 * 像素级角色身份引擎。
 *
 * 这里做的是真正的像素比较，而不是提示词层的一致性声明：
 *   1. 把任意尺寸的图像重采样成 64×64 工作网格，得到亮度、颜色与梯度信息；
 *   2. 从像素里抽出四组互相独立的签名（结构方向直方图 / 亮度网格 / RGB 直方图 /
 *      感知哈希），再单独估计人脸区域并抽取脸部描述子；
 *   3. 两张图之间逐项计算相似度，加权得到 0–1 的像素相似度，并按阈值给出判定。
 *
 * 它不依赖任何外部服务、模型下载或 GPU：全部是确定性的数值计算，因此可以在
 * Node 测试里用合成像素直接验证。边界也说清楚——这是手工设计的视觉描述子，
 * 不是训练过的人脸识别网络，也不是 CLIP 语义嵌入；它能发现明显的外观漂移
 * （换发型、换衣服、换配色、换构图），但不能替代人脸识别的置信度。
 */

export const IDENTITY_VERSION = "identity-v1" as const;
/** 工作网格边长；所有签名都从这张 64×64 图上抽取。 */
export const IDENTITY_WORK_SIZE = 64;
/** 结构描述子的人脸/构图网格。 */
export const IDENTITY_GRID = 8;
const GRID_CELL = IDENTITY_WORK_SIZE / IDENTITY_GRID;
const ORIENTATION_BINS = 8;
/** 区域描述子（人脸 / 画面中心）的网格：4×4 单元、每单元 8×8 像素。 */
const REGION_CELLS = 4;
const REGION_PIXELS = REGION_CELLS * 8;

/** 判定阈值：经验值，可通过参数覆盖。 */
export const IDENTITY_THRESHOLDS = { pass: 0.7, warn: 0.5 } as const;

export type IdentityVerdict = "pass" | "warn" | "fail";

export interface PixelBuffer {
  /** RGBA，长度必须 >= width * height * 4。 */
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface IdentityFaceRegion {
  /** 归一化坐标 0–1。 */
  box: { x: number; y: number; width: number; height: number };
  /** 皮肤像素占比。 */
  skinRatio: number;
  /** 皮肤像素的平均 RGB，用于区分不同人物的肤色。 */
  skin: number[];
  /** 128 维区域梯度方向直方图（对位移与背景亮度不敏感）。 */
  descriptor: number[];
}

export interface IdentitySignature {
  version: typeof IDENTITY_VERSION;
  /** 256 位感知哈希，64 个十六进制字符。 */
  phash: string;
  /** 8×8 单元 × 8 方向的梯度方向直方图（逐单元 L2 归一化）。 */
  structure: number[];
  /** 8×8 单元平均亮度，整体零均值单位方差。 */
  luma: number[];
  /** 4×4×4 RGB 直方图（按像素数归一化）。 */
  color: number[];
  /** 画面中心 60% 区域 16×16 亮度描述子。 */
  center: number[];
  /** 检测到的人脸区域；没有则缺省。 */
  face?: IdentityFaceRegion;
  /** 参与合成该签名的参考图数量。 */
  sampleCount: number;
}

export interface IdentityComparison {
  /** 0–1 的像素相似度。 */
  score: number;
  verdict: IdentityVerdict;
  /** 感知哈希相似度。 */
  pixel: number;
  /** 梯度结构相似度。 */
  structure: number;
  /** 颜色分布相似度。 */
  color: number;
  /** 人脸（或中心区域）相似度。 */
  face: number;
  /** 两张图是否都检测到人脸。 */
  faceDetected: boolean;
  method: "pixel";
}

interface WorkImage {
  rgb: Uint8Array;
  luma: Float32Array;
}

export function extractSignature(buffer: PixelBuffer): IdentitySignature {
  if (!buffer || !Number.isFinite(buffer.width) || !Number.isFinite(buffer.height)) {
    throw new Error("Identity signature requires a pixel buffer with dimensions.");
  }
  if (buffer.width < 8 || buffer.height < 8) {
    throw new Error("Identity signature requires at least 8×8 pixels.");
  }
  if (buffer.data.length < buffer.width * buffer.height * 4) {
    throw new Error("Pixel buffer is smaller than its declared dimensions.");
  }
  const work = resampleWork(buffer);
  const structure = orientationHistogram(work.luma);
  const luma = normalizeVector(cellMeans(work.luma, IDENTITY_GRID));
  const color = colorHistogram(work.rgb);
  const phash = averageHash(work.luma);
  const center = regionDescriptor(work.luma, {
    x: 0.2,
    y: 0.2,
    width: 0.6,
    height: 0.6,
  });
  const face = detectFace(work);
  return {
    version: IDENTITY_VERSION,
    phash,
    structure: roundAll(structure),
    luma: roundAll(luma),
    color: roundAll(color),
    center: roundAll(center),
    ...(face ? { face: { ...face, descriptor: roundAll(face.descriptor) } } : {}),
    sampleCount: 1,
  };
}
/**
 * 把多张参考图合并成角色质心：向量取平均后重新归一化，感知哈希按位多数表决。
 * 这样同一个角色有正脸、侧脸、全身三张参考时，任何一张都能被判定为「属于该角色」。
 */
export function mergeSignatures(signatures: IdentitySignature[]): IdentitySignature {
  if (!signatures.length) {
    throw new Error("Cannot merge an empty identity signature list.");
  }
  if (signatures.length === 1) {
    return { ...signatures[0], sampleCount: Math.max(1, signatures[0].sampleCount) };
  }
  const averaged = (pick: (signature: IdentitySignature) => number[]) =>
    normalizeVector(averageVectors(signatures.map(pick)));
  const faces = signatures
    .map((signature) => signature.face)
    .filter((face): face is IdentityFaceRegion => Boolean(face));
  const face = faces.length
    ? {
        box: {
          x: round(average(faces.map((item) => item.box.x))),
          y: round(average(faces.map((item) => item.box.y))),
          width: round(average(faces.map((item) => item.box.width))),
          height: round(average(faces.map((item) => item.box.height))),
        },
        skinRatio: round(average(faces.map((item) => item.skinRatio))),
        skin: faces[0].skin.map((_, channel) =>
          round(average(faces.map((item) => item.skin[channel] ?? item.skin[0]))),
        ),
        descriptor: roundAll(normalizeVector(averageVectors(faces.map((item) => item.descriptor)))),
      }
    : undefined;
  return {
    version: IDENTITY_VERSION,
    phash: majorityHash(signatures.map((signature) => signature.phash)),
    structure: roundAll(averaged((signature) => signature.structure)),
    luma: roundAll(normalizeVector(averageVectors(signatures.map((signature) => signature.luma)))),
    color: roundAll(normalizeVector(averageVectors(signatures.map((signature) => signature.color)))),
    center: roundAll(averaged((signature) => signature.center)),
    ...(face ? { face } : {}),
    sampleCount: signatures.reduce(
      (total, signature) => total + Math.max(1, signature.sampleCount),
      0,
    ),
  };
}

export function compareSignatures(
  left: IdentitySignature,
  right: IdentitySignature,
  thresholds: { pass: number; warn: number } = IDENTITY_THRESHOLDS,
): IdentityComparison {
  if (left.version !== right.version || right.version !== IDENTITY_VERSION) {
    throw new Error("Identity signatures were built by incompatible engines.");
  }
  const pixel = calibrate(hashSimilarity(left.phash, right.phash));
  const structure = calibrate(cosine(left.structure, right.structure));
  const color = calibrate(histogramIntersection(left.color, right.color));
  const faceDetected = Boolean(left.face && right.face);
  const face = faceDetected
    ? calibrate(
        0.64 * cosine(left.face!.descriptor, right.face!.descriptor) +
          0.36 * skinSimilarity(left.face!.skin, right.face!.skin),
      )
    : calibrate(cosine(left.center, right.center));
  const score = clamp01(
    structure * 0.34 + face * 0.26 + color * 0.22 + pixel * 0.18,
  );
  return {
    score: round(score),
    verdict: verdictForScore(score, thresholds),
    pixel: round(pixel),
    structure: round(structure),
    color: round(color),
    face: round(face),
    faceDetected,
    method: "pixel",
  };
}

export function verdictForScore(
  score: number,
  thresholds: { pass: number; warn: number } = IDENTITY_THRESHOLDS,
): IdentityVerdict {
  if (score >= thresholds.pass) return "pass";
  if (score >= thresholds.warn) return "warn";
  return "fail";
}

/** 只有同一角色多张参考之间才应该高；用于提示「参考图互相都不像」。 */
export function signatureConsensus(signatures: IdentitySignature[]): number {
  if (signatures.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < signatures.length; i += 1) {
    for (let j = i + 1; j < signatures.length; j += 1) {
      total += compareSignatures(signatures[i], signatures[j]).score;
      pairs += 1;
    }
  }
  return pairs ? round(total / pairs) : 0;
}

function resampleWork(buffer: PixelBuffer): WorkImage {
  const rgb = new Uint8Array(IDENTITY_WORK_SIZE * IDENTITY_WORK_SIZE * 3);
  const luma = new Float32Array(IDENTITY_WORK_SIZE * IDENTITY_WORK_SIZE);
  const { data, width, height } = buffer;
  for (let ty = 0; ty < IDENTITY_WORK_SIZE; ty += 1) {
    const sy0 = Math.floor((ty * height) / IDENTITY_WORK_SIZE);
    const sy1 = Math.max(sy0 + 1, Math.ceil(((ty + 1) * height) / IDENTITY_WORK_SIZE));
    for (let tx = 0; tx < IDENTITY_WORK_SIZE; tx += 1) {
      const sx0 = Math.floor((tx * width) / IDENTITY_WORK_SIZE);
      const sx1 = Math.max(sx0 + 1, Math.ceil(((tx + 1) * width) / IDENTITY_WORK_SIZE));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = sy0; sy < Math.min(sy1, height); sy += 1) {
        for (let sx = sx0; sx < Math.min(sx1, width); sx += 1) {
          const index = (sy * width + sx) * 4;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          count += 1;
        }
      }
      const safe = count || 1;
      const offset = (ty * IDENTITY_WORK_SIZE + tx) * 3;
      const red = r / safe;
      const green = g / safe;
      const blue = b / safe;
      rgb[offset] = Math.round(red);
      rgb[offset + 1] = Math.round(green);
      rgb[offset + 2] = Math.round(blue);
      luma[ty * IDENTITY_WORK_SIZE + tx] =
        0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }
  }
  return { rgb, luma };
}

function orientationHistogram(luma: Float32Array): number[] {
  const size = IDENTITY_WORK_SIZE;
  const vector = new Array<number>(IDENTITY_GRID * IDENTITY_GRID * ORIENTATION_BINS).fill(0);
  const at = (x: number, y: number) =>
    luma[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 1e-4) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(ORIENTATION_BINS - 1, Math.floor((angle / Math.PI) * ORIENTATION_BINS));
      const cellX = Math.floor(x / GRID_CELL);
      const cellY = Math.floor(y / GRID_CELL);
      vector[(cellY * IDENTITY_GRID + cellX) * ORIENTATION_BINS + bin] += magnitude;
    }
  }
  // 逐单元 L2 + 截断后再归一化，避免单张图被强边缘主导。
  for (let cell = 0; cell < IDENTITY_GRID * IDENTITY_GRID; cell += 1) {
    const offset = cell * ORIENTATION_BINS;
    const slice = vector.slice(offset, offset + ORIENTATION_BINS);
    const norm = l2(slice) || 1;
    for (let bin = 0; bin < ORIENTATION_BINS; bin += 1) {
      vector[offset + bin] = Math.min(0.2, slice[bin] / norm);
    }
  }
  return normalizeVector(vector);
}

function colorHistogram(rgb: Uint8Array): number[] {
  const bins = new Array<number>(4 * 4 * 4).fill(0);
  const total = rgb.length / 3;
  for (let index = 0; index < rgb.length; index += 3) {
    const r = Math.min(3, rgb[index] >> 6);
    const g = Math.min(3, rgb[index + 1] >> 6);
    const b = Math.min(3, rgb[index + 2] >> 6);
    bins[(r * 4 + g) * 4 + b] += 1;
  }
  return bins.map((value) => value / total);
}

function averageHash(luma: Float32Array): string {
  const grid = 16;
  const block = IDENTITY_WORK_SIZE / grid;
  const values: number[] = [];
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      let total = 0;
      for (let by = 0; by < block; by += 1) {
        for (let bx = 0; bx < block; bx += 1) {
          total += luma[(y * block + by) * IDENTITY_WORK_SIZE + x * block + bx];
        }
      }
      values.push(total / (block * block));
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const median =
    (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  let hash = "";
  for (let nibble = 0; nibble < values.length; nibble += 4) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | (values[nibble + bit] >= median ? 1 : 0);
    }
    hash += value.toString(16);
  }
  return hash;
}

function detectFace(work: WorkImage): IdentityFaceRegion | undefined {
  const size = IDENTITY_WORK_SIZE;
  const mask = new Uint8Array(size * size);
  let skin = 0;
  let skinR = 0;
  let skinG = 0;
  let skinB = 0;
  for (let index = 0; index < size * size; index += 1) {
    const r = work.rgb[index * 3];
    const g = work.rgb[index * 3 + 1];
    const b = work.rgb[index * 3 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const rgbRule =
      r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 12 && r > g && r > b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const ycbcrRule = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
    if (rgbRule && ycbcrRule) {
      mask[index] = 1;
      skin += 1;
      skinR += r;
      skinG += g;
      skinB += b;
    }
  }
  const skinRatio = skin / (size * size);
  if (skinRatio < 0.015) return undefined;
  const rows = new Float32Array(size);
  const cols = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) continue;
      rows[y] += 1;
      cols[x] += 1;
    }
  }
  const rowPeak = Math.max(...rows);
  const colPeak = Math.max(...cols);
  if (rowPeak <= 0 || colPeak <= 0) return undefined;
  const bounds = (values: Float32Array, peak: number) => {
    let start = -1;
    let end = -1;
    const threshold = peak * 0.35;
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] >= threshold) {
        if (start < 0) start = index;
        end = index;
      }
    }
    return [start, end] as const;
  };
  const [top, bottom] = bounds(rows, rowPeak);
  const [left, right] = bounds(cols, colPeak);
  if (top < 0 || left < 0 || bottom <= top || right <= left) return undefined;
  const box = {
    x: left / size,
    y: top / size,
    width: (right - left + 1) / size,
    height: (bottom - top + 1) / size,
  };
  const aspect = box.width / box.height;
  if (box.width < 0.15 || box.height < 0.15 || box.width * box.height > 0.9) return undefined;
  if (aspect < 0.4 || aspect > 2.5) return undefined;
  return {
    box: {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
    },
    skinRatio: round(skinRatio),
    skin: [round(skinR / skin), round(skinG / skin), round(skinB / skin)],
    descriptor: roundAll(regionDescriptor(work.luma, box)),
  };
}

/**
 * 区域描述子：把人脸/中心区域重采样到 32×32，再切成 4×4 个 8×8 单元，
 * 每个单元累计 8 个方向的梯度幅值。梯度对背景亮度、肤色深浅不敏感，
 * 对轻微位移比直接比较灰度和余弦稳健得多。
 */
function regionDescriptor(
  luma: Float32Array,
  box: { x: number; y: number; width: number; height: number },
): number[] {
  const gray = sampleGray(luma, box, REGION_PIXELS);
  const cell = REGION_PIXELS / REGION_CELLS;
  const vector = new Array<number>(REGION_CELLS * REGION_CELLS * ORIENTATION_BINS).fill(0);
  const at = (x: number, y: number) =>
    gray[Math.min(REGION_PIXELS - 1, Math.max(0, y)) * REGION_PIXELS + Math.min(REGION_PIXELS - 1, Math.max(0, x))];
  for (let y = 0; y < REGION_PIXELS; y += 1) {
    for (let x = 0; x < REGION_PIXELS; x += 1) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 1e-4) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(ORIENTATION_BINS - 1, Math.floor((angle / Math.PI) * ORIENTATION_BINS));
      const cellX = Math.floor(x / cell);
      const cellY = Math.floor(y / cell);
      vector[(cellY * REGION_CELLS + cellX) * ORIENTATION_BINS + bin] += magnitude;
    }
  }
  for (let index = 0; index < REGION_CELLS * REGION_CELLS; index += 1) {
    const offset = index * ORIENTATION_BINS;
    const slice = vector.slice(offset, offset + ORIENTATION_BINS);
    const norm = l2(slice) || 1;
    for (let bin = 0; bin < ORIENTATION_BINS; bin += 1) {
      vector[offset + bin] = slice[bin] / norm;
    }
  }
  return normalizeVector(vector);
}

function skinSimilarity(left: number[], right: number[]): number {
  const distance = Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
  // RGB 空间最大距离约 441；允许同一个人在不同光照下有一定偏移。
  return clamp01(1 - distance / 180);
}

function sampleGray(
  luma: Float32Array,
  box: { x: number; y: number; width: number; height: number },
  size: number,
): number[] {
  const work = IDENTITY_WORK_SIZE;
  const x0 = Math.max(0, Math.min(work - 1, box.x * work));
  const y0 = Math.max(0, Math.min(work - 1, box.y * work));
  const x1 = Math.max(x0 + 1, Math.min(work, (box.x + box.width) * work));
  const y1 = Math.max(y0 + 1, Math.min(work, (box.y + box.height) * work));
  const output = new Array<number>(size * size).fill(0);
  for (let ty = 0; ty < size; ty += 1) {
    const sy0 = Math.floor(y0 + ((y1 - y0) * ty) / size);
    const sy1 = Math.max(sy0 + 1, Math.ceil(y0 + ((y1 - y0) * (ty + 1)) / size));
    for (let tx = 0; tx < size; tx += 1) {
      const sx0 = Math.floor(x0 + ((x1 - x0) * tx) / size);
      const sx1 = Math.max(sx0 + 1, Math.ceil(x0 + ((x1 - x0) * (tx + 1)) / size));
      let total = 0;
      let count = 0;
      for (let sy = sy0; sy < Math.min(sy1, work); sy += 1) {
        for (let sx = sx0; sx < Math.min(sx1, work); sx += 1) {
          total += luma[sy * work + sx];
          count += 1;
        }
      }
      output[ty * size + tx] = count ? total / count : 0;
    }
  }
  return output;
}

function cellMeans(luma: Float32Array, grid: number): number[] {
  const cell = IDENTITY_WORK_SIZE / grid;
  const means: number[] = [];
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      let total = 0;
      for (let y = 0; y < cell; y += 1) {
        for (let x = 0; x < cell; x += 1) {
          total += luma[(gy * cell + y) * IDENTITY_WORK_SIZE + gx * cell + x];
        }
      }
      means.push(total / (cell * cell));
    }
  }
  return means;
}

function normalizeVector(vector: number[]): number[] {
  if (!vector.length) return vector;
  const mean = average(vector);
  const variance = average(vector.map((value) => (value - mean) ** 2));
  const deviation = Math.sqrt(variance);
  if (deviation < 1e-6) return vector.map(() => 0);
  return vector.map((value) => (value - mean) / deviation);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function averageVectors(vectors: number[][]): number[] {
  const length = Math.min(...vectors.map((vector) => vector.length));
  const output = new Array<number>(length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < length; index += 1) {
      output[index] += vector[index];
    }
  }
  return output.map((value) => value / vectors.length);
}

function l2(vector: number[]): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (denominator < 1e-9) return 0;
  return clamp01(dot / denominator);
}

function histogramIntersection(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.min(left[index], right[index]);
  }
  return clamp01(total);
}

const HEX_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function hashSimilarity(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    const a = Number.parseInt(left[index], 16);
    const b = Number.parseInt(right[index], 16);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    distance += HEX_BITS[a ^ b];
  }
  const bits = length * 4;
  return bits ? clamp01(1 - distance / bits) : 0;
}

function majorityHash(hashes: string[]): string {
  if (!hashes.length) return "";
  const length = Math.min(...hashes.map((hash) => hash.length));
  let output = "";
  for (let index = 0; index < length; index += 1) {
    let value = 0;
    for (let bit = 3; bit >= 0; bit -= 1) {
      let ones = 0;
      for (const hash of hashes) {
        const nibble = Number.parseInt(hash[index], 16) || 0;
        if ((nibble >> bit) & 1) ones += 1;
      }
      value = (value << 1) | (ones * 2 > hashes.length ? 1 : 0);
    }
    output += value.toString(16);
  }
  return output;
}

/**
 * 相似度校准：原始余弦/直方图交集落在 0.2–0.9 区间，直接当百分比会系统性偏低。
 * 这里做一次线性拉伸并截断，让「同一张图」接近 1、「不同主体」落在 0.2 以下。
 */
function calibrate(value: number): number {
  return clamp01((value - 0.15) / 0.8);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundAll(values: number[]): number[] {
  return values.map(round);
}
