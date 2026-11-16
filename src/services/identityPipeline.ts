import type {
  Asset,
  CharacterIdentityProfile,
  CharacterProfile,
  IdentityVerification,
  VideoProject,
} from "../types";
import { referenceAssetsFor } from "./consistency";
import {
  compareSignatures,
  extractSignature,
  mergeSignatures,
  signatureConsensus,
  type IdentitySignature,
  type IdentityVerdict,
  type PixelBuffer,
} from "./identity";

/**
 * 浏览器侧取像素与项目级验证。
 *
 * 像素引擎本身是纯函数（`services/identity.ts`），这里只负责把
 * kmasset / data URL 画进 canvas、读回 ImageData，并组织成设定集需要的
 * 「角色质心」与「逐镜头验证结果」。所有计算都在本机完成，不上传图片。
 */

/** 取像素前统一缩放到的上限边长：足够保留脸部与构图结构，又不至于让 4K 素材拖慢界面。 */
const SAMPLE_LIMIT = 256;

const signatureCache = new Map<string, Promise<IdentitySignature>>();

export function clearIdentityCache(): void {
  signatureCache.clear();
}

export function signatureForSource(src: string): Promise<IdentitySignature> {
  const cached = signatureCache.get(src);
  if (cached) return cached;
  const task = buildSignature(src).catch((error: unknown) => {
    signatureCache.delete(src);
    throw error;
  });
  signatureCache.set(src, task);
  return task;
}

async function buildSignature(src: string): Promise<IdentitySignature> {
  const image = await loadImage(src);
  return extractSignature(readPixels(image));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // 素材协议已允许跨源读取；带上 anonymous 才能让 canvas 不被标记为 tainted。
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("无法读取这张图片的像素；SVG 草案或远程图片请先落地为项目素材。"));
    image.src = src;
  });
}

function readPixels(image: HTMLImageElement): PixelBuffer {
  const naturalWidth = image.naturalWidth || image.width || SAMPLE_LIMIT;
  const naturalHeight = image.naturalHeight || image.height || SAMPLE_LIMIT;
  const scale = Math.min(1, SAMPLE_LIMIT / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(8, Math.round(naturalWidth * scale));
  const height = Math.max(8, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("当前运行环境没有可用的 2D 画布，无法计算身份签名。");
  }
  context.drawImage(image, 0, 0, width, height);
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, width, height).data;
  } catch {
    throw new Error("图片像素被浏览器判定为跨源受限，无法做身份验证。");
  }
  return { data, width, height };
}

export function characterReferenceAssets(
  project: VideoProject,
  character: CharacterProfile,
): Asset[] {
  return referenceAssetsFor(project, "character", character.id).filter(
    (asset) => asset.kind === "image",
  );
}

export interface CharacterIdentityBuild {
  profile?: CharacterIdentityProfile;
  errors: string[];
}

/** 用角色当前所有参考图重建身份质心。参考图本身就是身份，不依赖生成结果。 */
export async function buildCharacterIdentity(
  project: VideoProject,
  character: CharacterProfile,
): Promise<CharacterIdentityBuild> {
  const references = characterReferenceAssets(project, character);
  const errors: string[] = [];
  if (!references.length) {
    return { errors: ["这个角色还没有参考图，先上传一张定妆图再建立身份指纹。"] };
  }
  const settled = await Promise.all(
    references.map(async (asset) => {
      try {
        return await signatureForSource(asset.src);
      } catch (error) {
        errors.push(
          `${asset.reference?.label ?? asset.name}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    }),
  );
  const signatures = settled.filter(
    (signature): signature is IdentitySignature => Boolean(signature),
  );
  if (!signatures.length) {
    return { errors: errors.length ? errors : ["参考图像素读取失败，无法建立身份指纹。"] };
  }
  return {
    profile: {
      version: "identity-v1",
      signature: mergeSignatures(signatures),
      sampleAssetIds: references
        .filter((_, index) => Boolean(settled[index]))
        .map((asset) => asset.id),
      consensus: signatureConsensus(signatures),
      builtAt: new Date().toISOString(),
    },
    errors,
  };
}

export interface SceneIdentityResult {
  sceneId: string;
  assetId: string;
  verification: IdentityVerification;
}

export interface ProjectIdentityVerification {
  results: SceneIdentityResult[];
  errors: string[];
  checked: number;
}

/**
 * 逐镜头验证：把已采用素材的像素签名，和出场角色的身份质心逐一比较，
 * 取分数最高的角色作为判定依据。没有质心的角色会被跳过并在 errors 里说明。
 */
export async function verifyProjectIdentities(
  project: VideoProject,
  characters: CharacterProfile[] = project.characters,
): Promise<ProjectIdentityVerification> {
  const errors: string[] = [];
  const signatures = new Map<string, IdentitySignature>();
  for (const character of characters) {
    if (!character.identity?.signature) {
      if (character.referenceAssetIds.length) {
        errors.push(`角色「${character.name}」还没有建立身份指纹。`);
      }
      continue;
    }
    signatures.set(character.id, character.identity.signature);
  }
  if (!signatures.size) {
    return {
      results: [],
      errors: errors.length ? errors : ["还没有任何角色身份指纹，先建立指纹再验证。"],
      checked: 0,
    };
  }

  const results: SceneIdentityResult[] = [];
  for (const scene of project.scenes) {
    if (!scene.assetId) continue;
    const asset = project.assets.find((item) => item.id === scene.assetId);
    if (!asset || asset.kind !== "image") continue;
    const candidates = (scene.characterIds ?? [])
      .map((id) => characters.find((character) => character.id === id))
      .filter((item): item is CharacterProfile => Boolean(item))
      .filter((character) => signatures.has(character.id));
    if (!candidates.length) continue;
    let assetSignature: IdentitySignature;
    try {
      assetSignature = await signatureForSource(asset.src);
    } catch (error) {
      errors.push(
        `镜头「${scene.title}」：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    let best:
      | { character: CharacterProfile; comparison: ReturnType<typeof compareSignatures> }
      | undefined;
    for (const character of candidates) {
      const comparison = compareSignatures(signatures.get(character.id)!, assetSignature);
      if (!best || comparison.score > best.comparison.score) {
        best = { character, comparison };
      }
    }
    if (!best) continue;
    results.push({
      sceneId: scene.id,
      assetId: asset.id,
      verification: {
        version: "identity-v1",
        score: best.comparison.score,
        verdict: best.comparison.verdict,
        components: {
          pixel: best.comparison.pixel,
          structure: best.comparison.structure,
          color: best.comparison.color,
          face: best.comparison.face,
        },
        faceDetected: best.comparison.faceDetected,
        characterId: best.character.id,
        characterName: best.character.name,
        refSamples: best.character.identity?.signature.sampleCount ?? 1,
        checkedAt: new Date().toISOString(),
        method: "pixel",
      },
    });
  }
  return { results, errors, checked: results.length };
}

export interface IdentitySummary {
  checked: number;
  pass: number;
  warn: number;
  fail: number;
  average: number;
  worst?: IdentityVerification;
}

export function summariseIdentities(assets: Asset[]): IdentitySummary {
  const verifications = assets
    .map((asset) => asset.identity)
    .filter((item): item is IdentityVerification => Boolean(item));
  const summary: IdentitySummary = {
    checked: verifications.length,
    pass: 0,
    warn: 0,
    fail: 0,
    average: 0,
  };
  if (!verifications.length) return summary;
  for (const verification of verifications) {
    summary[verification.verdict as IdentityVerdict] += 1;
    if (!summary.worst || verification.score < summary.worst.score) {
      summary.worst = verification;
    }
  }
  summary.average =
    Math.round(
      (verifications.reduce((total, item) => total + item.score, 0) /
        verifications.length) *
        100,
    ) / 100;
  return summary;
}
