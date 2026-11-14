import type {
  Asset,
  CharacterProfile,
  ConsistencyStamp,
  LocationProfile,
  ReferenceRole,
  Scene,
  StyleLock,
  VideoProject,
} from "../types";

/**
 * 设定集一致性引擎。
 *
 * 这里做的是「结构一致性」：把角色外观、环境、风格锁和参考图解析成一组
 * 可复现的提示词锚点 + 稳定指纹 + 稳定种子。它不假装能做人脸相似度计算，
 * 但可以证明：
 *   1. 同一套锚点在任何一次生成里都得到完全相同的提示词和种子；
 *   2. 锚点或参考图一旦被修改，指纹就变化，旧素材会被判定为「已过期」；
 *   3. 每个镜头是否绑定锚点、是否有参考图，可以被逐项审计。
 */

export const CONSISTENCY_DIRECTIVE_HEADER = "[CONSISTENCY LOCK]";
export const STYLE_LOCK_ENTITY_ID = "style-lock";

export function stableHash(value: string): string {
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    primary ^= code;
    primary = Math.imul(primary, 0x01000193) >>> 0;
    secondary =
      (secondary + Math.imul(code, 0x85ebca6b) + index) >>> 0;
    secondary = Math.imul(secondary ^ (secondary >>> 13), 0xc2b2ae35) >>> 0;
  }
  return `${hex8(primary)}${hex8(secondary)}`;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

export function seedFromFingerprint(fingerprint: string): number {
  const parsed = Number.parseInt(fingerprint.slice(0, 8), 16);
  if (!Number.isFinite(parsed)) return 1;
  return (parsed % 2_000_000_000) + 1;
}

export interface SceneAnchors {
  sceneId: string;
  characters: CharacterProfile[];
  location?: LocationProfile;
  style: StyleLock;
  styleActive: boolean;
  referenceAssetIds: string[];
  fingerprint: string;
  seed: number;
  label: string;
  directive: string;
  negativePrompt: string;
  /** 声明式缺口，用于 UI 提示；不参与指纹。 */
  missing: string[];
}

export function referenceAssetsFor(
  project: VideoProject,
  role: ReferenceRole,
  entityId: string,
): Asset[] {
  return project.assets.filter(
    (asset) =>
      asset.reference?.role === role &&
      asset.reference.entityId === entityId &&
      asset.kind === "image",
  );
}

export function allReferenceAssets(project: VideoProject): Asset[] {
  return project.assets.filter((asset) => Boolean(asset.reference));
}

export function resolveSceneAnchors(
  project: VideoProject,
  scene: Scene,
): SceneAnchors {
  const characterIds = scene.characterIds ?? [];
  const characters = characterIds
    .map((id) => project.characters.find((item) => item.id === id))
    .filter((item): item is CharacterProfile => Boolean(item));
  const location = project.locations.find(
    (item) => item.id === scene.locationId,
  );
  const style = project.styleLock;
  const styleActive = Boolean(
    style.enabled && style.descriptor.trim().length > 0,
  );
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const existing = (ids: string[]) => ids.filter((id) => assetIds.has(id));
  const referenceAssetIds = unique([
    ...characters.flatMap((character) =>
      existing(character.referenceAssetIds),
    ),
    ...(location ? existing(location.referenceAssetIds) : []),
    ...(styleActive ? existing(style.referenceAssetIds) : []),
  ]);

  const parts = [
    "consistency-v1",
    styleActive ? `style:${style.descriptor.trim()}` : "",
    styleActive ? `stylePalette:${style.palette.join("|")}` : "",
    ...characters.map((character) =>
      [
        "character",
        character.id,
        character.name,
        character.appearance,
        character.wardrobe,
        character.palette.join("|"),
      ].join(":"),
    ),
    location
      ? [
          "location",
          location.id,
          location.name,
          location.environment,
          location.lighting,
          location.timeOfDay,
          location.palette.join("|"),
        ].join(":")
      : "",
    `references:${referenceAssetIds.join("|")}`,
  ].filter(Boolean);

  const fingerprint = stableHash(parts.join("\n"));
  const seed =
    characters.find((character) => character.seed)?.seed ??
    location?.seed ??
    seedFromFingerprint(fingerprint);

  const label =
    [
      styleActive ? style.descriptor.trim() : "",
      ...characters.map((character) => character.name),
      location?.name ?? "",
    ]
      .filter(Boolean)
      .join(" · ") || "未绑定锚点";

  const missing: string[] = [];
  if (!characters.length && !location && !styleActive) {
    missing.push("镜头还没有绑定角色、场景或风格锚点");
  }
  for (const character of characters) {
    if (!character.appearance.trim() && !character.referenceAssetIds.length) {
      missing.push(`角色「${character.name}」既没有外观描述也没有参考图`);
    }
  }
  if (location && !location.environment.trim() && !location.referenceAssetIds.length) {
    missing.push(`场景「${location.name}」既没有环境描述也没有参考图`);
  }
  if (!referenceAssetIds.length) {
    missing.push("当前只有文字锚点，没有像素级参考图");
  }

  return {
    sceneId: scene.id,
    characters,
    location,
    style,
    styleActive,
    referenceAssetIds,
    fingerprint,
    seed,
    label,
    directive: buildDirective({
      characters,
      location,
      style,
      styleActive,
      referenceAssetIds,
      label,
    }),
    negativePrompt: unique(
      [
        styleActive ? style.negative : "",
        ...characters.map((character) => character.negative),
        location?.negative ?? "",
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ).join(", "),
    missing,
  };
}

function buildDirective(input: {
  characters: CharacterProfile[];
  location?: LocationProfile;
  style: StyleLock;
  styleActive: boolean;
  referenceAssetIds: string[];
  label: string;
}): string {
  const lines: string[] = [];
  if (input.styleActive) {
    lines.push(`Global style lock: ${input.style.descriptor.trim()}.`);
    if (input.style.palette.length) {
      lines.push(`Style palette: ${input.style.palette.join(", ")}.`);
    }
  }
  for (const character of input.characters) {
    const traits = [character.appearance, character.wardrobe]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("; ");
    const palette = character.palette.length
      ? ` Palette: ${character.palette.join(", ")}.`
      : "";
    lines.push(
      `Character "${character.name}"${
        character.role ? ` (${character.role})` : ""
      }: ${traits || "keep the reference identity"}.${palette}`,
    );
  }
  if (input.location) {
    const traits = [
      input.location.environment,
      input.location.lighting,
      input.location.timeOfDay,
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("; ");
    const palette = input.location.palette.length
      ? ` Palette: ${input.location.palette.join(", ")}.`
      : "";
    lines.push(
      `Location "${input.location.name}": ${
        traits || "keep the reference environment"
      }.${palette}`,
    );
  }
  if (input.referenceAssetIds.length) {
    lines.push(
      `Reference images are authoritative for identity and environment; preserve face, hairstyle, clothing and layout of ${input.label}.`,
    );
  }
  if (!lines.length) return "";
  return `${CONSISTENCY_DIRECTIVE_HEADER} Keep these subjects identical across every shot. ${lines.join(
    " ",
  )}`;
}

/** 只有真正绑定了角色、场景或风格锁，锚点才算生效。 */
export function hasSceneAnchors(anchors: SceneAnchors): boolean {
  return (
    anchors.characters.length > 0 ||
    Boolean(anchors.location) ||
    anchors.styleActive
  );
}

export function composeAnchoredPrompt(
  basePrompt: string,
  anchors: SceneAnchors,
): string {
  const base = basePrompt.trim();
  if (!anchors.directive) return base;
  if (base.includes(CONSISTENCY_DIRECTIVE_HEADER)) return base;
  return base ? `${base}. ${anchors.directive}` : anchors.directive;
}

export function createConsistencyStamp(
  anchors: SceneAnchors,
  prompt: string,
  conditioning: ConsistencyStamp["conditioning"],
): ConsistencyStamp {
  return {
    fingerprint: anchors.fingerprint,
    anchorLabel: anchors.label,
    seed: anchors.seed,
    prompt,
    negativePrompt: anchors.negativePrompt,
    referenceAssetIds: [...anchors.referenceAssetIds],
    conditioning,
    generatedAt: new Date().toISOString(),
  };
}

export type ConsistencyStatus =
  | "consistent"
  | "stale"
  | "unapplied"
  | "unanchored";

export interface ConsistencyEvaluation {
  status: ConsistencyStatus;
  title: string;
  detail: string;
  tone: "success" | "warning" | "danger" | "neutral";
  weak: boolean;
  asset?: Asset;
}

export function evaluateConsistency(
  project: VideoProject,
  scene: Scene,
): { anchors: SceneAnchors; evaluation: ConsistencyEvaluation } {
  const anchors = resolveSceneAnchors(project, scene);
  const asset = scene.assetId
    ? project.assets.find((item) => item.id === scene.assetId)
    : undefined;
  const weak = anchors.referenceAssetIds.length === 0;
  const hasAnchors = hasSceneAnchors(anchors);

  if (!hasAnchors) {
    return {
      anchors,
      evaluation: {
        status: "unanchored",
        title: "未绑定锚点",
        detail: "这个镜头没有角色、场景或风格约束，每次生成都可能长得不一样。",
        tone: "neutral",
        weak,
        asset,
      },
    };
  }
  if (!asset) {
    return {
      anchors,
      evaluation: {
        status: "unapplied",
        title: "尚未生成画面",
        detail: `锚点已就绪（${anchors.label}），但还没有采用任何素材。`,
        tone: "warning",
        weak,
        asset,
      },
    };
  }
  if (asset.consistency?.fingerprint !== anchors.fingerprint) {
    return {
      anchors,
      evaluation: {
        status: "stale",
        title: "素材已过期",
        detail: asset.consistency
          ? `生成时的锚点是「${asset.consistency.anchorLabel}」，之后设定集被修改过。`
          : "该素材生成时还没有记录锚点快照。",
        tone: "danger",
        weak,
        asset,
      },
    };
  }
  return {
    anchors,
    evaluation: {
      status: "consistent",
      title: weak ? "文字锚点一致" : "与设定集一致",
      detail: weak
        ? `指纹与「${anchors.label}」匹配，但只有文字约束，建议补充参考图。`
        : `指纹与「${anchors.label}」完全匹配，参考图 ${anchors.referenceAssetIds.length} 张。`,
      tone: weak ? "warning" : "success",
      weak,
      asset,
    },
  };
}

export interface ConsistencyReport {
  score: number;
  scenes: number;
  anchored: number;
  consistent: number;
  stale: number;
  unapplied: number;
  unanchored: number;
  referenceImages: number;
  entries: Array<{
    scene: Scene;
    index: number;
    anchors: SceneAnchors;
    evaluation: ConsistencyEvaluation;
  }>;
}

const STATUS_WEIGHT: Record<ConsistencyStatus, number> = {
  consistent: 1,
  stale: 0.35,
  unapplied: 0.42,
  unanchored: 0.1,
};

export function consistencyReport(project: VideoProject): ConsistencyReport {
  const entries = project.scenes.map((scene, index) => {
    const { anchors, evaluation } = evaluateConsistency(project, scene);
    return { scene, index, anchors, evaluation };
  });
  const counts = {
    consistent: 0,
    stale: 0,
    unapplied: 0,
    unanchored: 0,
  };
  for (const entry of entries) {
    counts[entry.evaluation.status] += 1;
  }
  const anchored = entries.filter(
    (entry) =>
      entry.anchors.characters.length > 0 ||
      Boolean(entry.anchors.location) ||
      entry.anchors.styleActive,
  ).length;
  const score = entries.length
    ? Math.round(
        (entries.reduce((total, entry) => {
          const base = STATUS_WEIGHT[entry.evaluation.status];
          const penalty =
            entry.evaluation.weak && entry.evaluation.status !== "unanchored"
              ? 0.85
              : 1;
          return total + base * penalty;
        }, 0) /
          entries.length) *
          100,
      )
    : 0;
  return {
    score,
    scenes: entries.length,
    anchored,
    consistent: counts.consistent,
    stale: counts.stale,
    unapplied: counts.unapplied,
    unanchored: counts.unanchored,
    referenceImages: allReferenceAssets(project).length,
    entries,
  };
}

export function paletteToText(palette: string[]): string {
  return palette.join(", ");
}

export function parsePalette(value: string): string[] {
  return unique(
    value
      .split(/[,\s;，、]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.startsWith("#") ? item : `#${item}`)),
  );
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
