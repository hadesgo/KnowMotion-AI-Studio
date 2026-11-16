import type {
  Asset,
  CharacterLockConfig,
  CharacterLockMode,
  CharacterProfile,
  ControlNetType,
  ProviderProfile,
  Scene,
  VideoProject,
} from "../types";
import { referenceAssetsFor } from "./consistency";

/**
 * 角色锁协商层。
 *
 * 设定卡里的参考图要真正进入生成管，必须先回答两个问题：
 *   1. 这个 Provider 到底能做到哪一档？（ControlNet / IP-Adapter / img2img 参考 / 纯提示词）
 *   2. 做不到时怎么降级，降级原因要能被用户看到，而不是悄悄变成一句提示词。
 *
 * 这里只做协商与参数推导，不做网络请求；真正的像素条件由 Rust 侧
 * 在 stable-diffusion.cpp 上执行（`/sdcpp/v1/img_gen` 或 `/sdapi/v1/img2img`）。
 */

export const DEFAULT_CHARACTER_LOCK: CharacterLockConfig = {
  enabled: true,
  mode: "img2img-reference",
  weight: 0.6,
  controlType: "reference",
  startAt: 0,
  endAt: 1,
};

export type ConditioningChannel =
  | "prompt"
  | "prompt+img2img"
  | "prompt+ip-adapter"
  | "prompt+controlnet";

/** 协议实际支持的像素条件档位。旧版 sd.cpp 若没有原生接口，会由后端继续降级并在日志中说明。 */
const PROTOCOL_CONDITIONING: Record<string, CharacterLockMode[]> = {
  "stable-diffusion.cpp": ["controlnet", "ip-adapter", "img2img-reference"],
};

const CHANNEL_RANK: Record<CharacterLockMode, number> = {
  controlnet: 3,
  "ip-adapter": 2,
  "img2img-reference": 1,
  prompt: 0,
};

const CHANNEL_FOR_MODE: Record<CharacterLockMode, ConditioningChannel> = {
  controlnet: "prompt+controlnet",
  "ip-adapter": "prompt+ip-adapter",
  "img2img-reference": "prompt+img2img",
  prompt: "prompt",
};

export function resolveCharacterLock(character: CharacterProfile): CharacterLockConfig {
  const lock = character.lock;
  return {
    ...DEFAULT_CHARACTER_LOCK,
    ...(lock ?? {}),
    weight: clamp(lock?.weight ?? DEFAULT_CHARACTER_LOCK.weight, 0, 1),
    startAt: clamp(lock?.startAt ?? 0, 0, 1),
    endAt: clamp(lock?.endAt ?? 1, 0, 1),
    controlType: lock?.controlType ?? DEFAULT_CHARACTER_LOCK.controlType,
  };
}

export function providerConditioningModes(provider: ProviderProfile): CharacterLockMode[] {
  if (!provider.enabled) return [];
  return PROTOCOL_CONDITIONING[provider.protocol] ?? [];
}

export interface ConditioningLock {
  characterId: string;
  characterName: string;
  requested: CharacterLockMode;
  granted: CharacterLockMode;
  weight: number;
  referenceAssetId?: string;
  controlType: ControlNetType;
  startAt: number;
  endAt: number;
  note?: string;
}

export interface ConditioningPlan {
  requested: CharacterLockMode;
  channel: ConditioningChannel;
  /** img2img 去噪强度 / ControlNet·IP-Adapter 强度；权重越高越贴近参考图。 */
  strength: number;
  referenceAssetId?: string;
  controlType: ControlNetType;
  startAt: number;
  endAt: number;
  locks: ConditioningLock[];
  /** 生效档位低于请求档位的原因。 */
  degradations: string[];
  /** 配置层面的提醒（缺参考图、多角色只锁一个）。 */
  warnings: string[];
}

/**
 * 权重 → 强度：权重要的是「像不像」，而 img2img 的去噪强度是「改多少」。
 * 权重高 → 强度低（更贴近参考图）；权重低 → 强度高（更听提示词）。
 */
export function strengthFromWeight(weight: number): number {
  return round2(clamp(0.9 - 0.6 * clamp(weight, 0, 1), 0.3, 0.85));
}

export function planConditioning(
  project: VideoProject,
  scene: Scene,
  provider: ProviderProfile,
): ConditioningPlan {
  const supported = providerConditioningModes(provider);
  const degradations: string[] = [];
  const warnings: string[] = [];
  const locks: ConditioningLock[] = [];

  const characters = (scene.characterIds ?? [])
    .map((id) => project.characters.find((item) => item.id === id))
    .filter((item): item is CharacterProfile => Boolean(item));

  for (const character of characters) {
    const lock = resolveCharacterLock(character);
    if (!lock.enabled || lock.mode === "prompt") continue;
    const references = referenceAssetsFor(project, "character", character.id);
    if (!references.length) {
      warnings.push(`角色「${character.name}」开启了角色锁，但没有参考图，只能使用文字锚点。`);
      continue;
    }
    const source =
      references.find((asset) => asset.id === lock.sourceAssetId) ?? pickPrimaryReference(references);
    const granted = supported.includes(lock.mode)
      ? lock.mode
      : fallbackMode(supported);
    if (granted !== lock.mode) {
      degradations.push(
        `${provider.name} 不支持 ${labelForMode(lock.mode)}，角色「${character.name}」已降级为 ${labelForMode(granted)}。`,
      );
    }
    locks.push({
      characterId: character.id,
      characterName: character.name,
      requested: lock.mode,
      granted,
      weight: lock.weight,
      referenceAssetId: source?.id,
      controlType: lock.controlType,
      startAt: lock.startAt,
      endAt: lock.endAt,
      note:
        granted === "img2img-reference"
          ? "参考图作为初始图重绘，强度由权重推导。"
          : undefined,
    });
  }

  const pixelLocks = locks.filter((lock) => lock.granted !== "prompt" && lock.referenceAssetId);
  if (pixelLocks.length > 1) {
    warnings.push(
      `这个镜头有 ${pixelLocks.length} 个角色需要像素锁定；当前实现只把权重最高的「${
        [...pixelLocks].sort((a, b) => b.weight - a.weight)[0].characterName
      }」传给后端，其余角色仍由提示词约束。`,
    );
  }
  const primary = [...pixelLocks].sort((a, b) => b.weight - a.weight)[0];
  const channel: ConditioningChannel = primary
    ? CHANNEL_FOR_MODE[primary.granted]
    : "prompt";
  const requestedMode = locks.length
    ? locks.reduce<CharacterLockMode>(
        (best, lock) => (CHANNEL_RANK[lock.requested] > CHANNEL_RANK[best] ? lock.requested : best),
        "prompt",
      )
    : "prompt";

  return {
    requested: requestedMode,
    channel,
    strength: primary ? strengthFromWeight(primary.weight) : 0.55,
    referenceAssetId: primary?.referenceAssetId,
    controlType: primary?.controlType ?? "reference",
    startAt: primary?.startAt ?? 0,
    endAt: primary?.endAt ?? 1,
    locks,
    degradations,
    warnings,
  };
}

/** 后端请求体里使用的精简条件描述。 */
export interface ImageConditioningInput {
  mode: CharacterLockMode;
  strength: number;
  referenceAssetId: string;
  controlType: string;
  startAt: number;
  endAt: number;
  lockCount: number;
}

export function conditioningPayload(
  plan: ConditioningPlan,
): ImageConditioningInput | undefined {
  if (plan.channel === "prompt") return undefined;
  return {
    mode: plan.locks.find((lock) => lock.referenceAssetId === plan.referenceAssetId)?.granted ??
      "img2img-reference",
    strength: plan.strength,
    referenceAssetId: plan.referenceAssetId ?? "",
    controlType: plan.controlType,
    startAt: plan.startAt,
    endAt: plan.endAt,
    lockCount: plan.locks.length,
  };
}

export function channelLabel(channel: ConditioningChannel): string {
  switch (channel) {
    case "prompt+controlnet":
      return "ControlNet 结构锁";
    case "prompt+ip-adapter":
      return "IP-Adapter 参考锁";
    case "prompt+img2img":
      return "img2img 参考锁";
    default:
      return "仅提示词";
  }
}

export function labelForMode(mode: CharacterLockMode): string {
  switch (mode) {
    case "controlnet":
      return "ControlNet";
    case "ip-adapter":
      return "IP-Adapter";
    case "img2img-reference":
      return "img2img 参考";
    default:
      return "提示词锚点";
  }
}

function fallbackMode(supported: CharacterLockMode[]): CharacterLockMode {
  if (supported.includes("img2img-reference")) return "img2img-reference";
  if (supported.includes("ip-adapter")) return "ip-adapter";
  if (supported.includes("controlnet")) return "controlnet";
  return "prompt";
}

function pickPrimaryReference(references: Asset[]): Asset | undefined {
  return [...references].sort((left, right) => {
    const leftScore = (left.reference?.weight ?? 0) + (left.reference?.locked ? 0.2 : 0);
    const rightScore = (right.reference?.weight ?? 0) + (right.reference?.locked ? 0.2 : 0);
    return rightScore - leftScore;
  })[0];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
