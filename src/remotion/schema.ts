import { z } from "zod";
import type { Scene, VideoProject } from "../types";

const colorSchema = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/, "颜色必须是十六进制颜色");

const timingSchema = z
  .object({
    fromMs: z.number().finite().min(0),
    toMs: z.number().finite().positive(),
  })
  .strict()
  .refine((value) => value.toMs > value.fromMs, {
    message: "图层结束时间必须晚于开始时间",
    path: ["toMs"],
  });

const animationSchema = z
  .object({
    type: z.enum([
      "none",
      "fade",
      "fadeUp",
      "slideIn",
      "scaleIn",
      "typewriter",
    ]),
    delayMs: z.number().finite().min(0).max(30_000).default(0),
    durationMs: z.number().finite().min(0).max(30_000).default(600),
    easing: z
      .enum(["linear", "easeIn", "easeOut", "easeInOut", "spring"])
      .default("easeOut"),
  })
  .strict();

const baseLayerShape = {
  id: z.string().min(1).max(120),
  timing: timingSchema,
  animation: animationSchema,
  opacity: z.number().finite().min(0).max(1).default(1),
  x: z.number().finite().min(-100).max(200),
  y: z.number().finite().min(-100).max(200),
  width: z.number().finite().min(0.1).max(300),
  height: z.number().finite().min(0.1).max(300),
  rotation: z.number().finite().min(-3600).max(3600).default(0),
};

const textLayerSchema = z
  .object({
    ...baseLayerShape,
    type: z.literal("text"),
    content: z.string().max(5000),
    color: colorSchema,
    fontSize: z.number().finite().min(8).max(240),
    fontWeight: z.number().int().min(300).max(900).default(600),
    align: z.enum(["left", "center", "right"]).default("left"),
    letterSpacing: z.number().finite().min(-10).max(40).default(0),
  })
  .strict();

const svgLayerSchema = z
  .object({
    ...baseLayerShape,
    type: z.literal("svg"),
    variant: z.enum(["orbit", "wave", "grid", "particles", "progressRing"]),
    color: colorSchema,
    strokeWidth: z.number().finite().min(0.2).max(20).default(2),
    intensity: z.number().finite().min(0).max(1).default(0.7),
  })
  .strict();

const imageLayerSchema = z
  .object({
    ...baseLayerShape,
    type: z.literal("image"),
    assetId: z.string().min(1).max(120),
    fit: z.enum(["cover", "contain", "fill"]).default("cover"),
    borderRadius: z.number().finite().min(0).max(100).default(18),
    treatment: z.enum(["none", "duotone", "vignette"]).default("vignette"),
  })
  .strict();

const chartDatumSchema = z
  .object({
    label: z.string().min(1).max(80),
    value: z.number().finite().min(-100_000).max(100_000),
    color: colorSchema.optional(),
  })
  .strict();

const chartLayerSchema = z
  .object({
    ...baseLayerShape,
    type: z.literal("chart"),
    chartType: z.enum(["bar", "line", "donut"]),
    data: z.array(chartDatumSchema).min(1).max(24),
    accent: colorSchema,
    showValues: z.boolean().default(true),
  })
  .strict();

export const sceneLayerSchema = z.discriminatedUnion("type", [
  textLayerSchema,
  svgLayerSchema,
  imageLayerSchema,
  chartLayerSchema,
]);

const cameraPointSchema = z
  .object({
    scale: z.number().finite().min(0.5).max(3),
    x: z.number().finite().min(-40).max(40),
    y: z.number().finite().min(-40).max(40),
  })
  .strict();

const backgroundSchema = z
  .object({
    type: z.enum(["gradient", "solid"]),
    colors: z.array(colorSchema).min(1).max(4),
    angle: z.number().finite().min(0).max(360).default(135),
    vignette: z.number().finite().min(0).max(1).default(0.34),
  })
  .strict();

const transitionSchema = z
  .object({
    type: z.enum(["fade", "slide", "wipe", "iris"]),
    durationMs: z.number().finite().min(0).max(2000),
    direction: z.enum(["left", "right", "up", "down"]).default("left"),
  })
  .strict();

export const sceneDslSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z.string().min(1).max(120),
    styleVariant: z.enum([
      "cinematic",
      "diagram",
      "data",
      "editorial",
      "minimal",
    ]),
    title: z.string().min(1).max(200),
    narration: z.string().max(8000),
    durationMs: z.number().finite().min(250).max(600_000),
    background: backgroundSchema,
    camera: z
      .object({
        from: cameraPointSchema,
        to: cameraPointSchema,
        easing: z
          .enum(["linear", "easeIn", "easeOut", "easeInOut"])
          .default("easeInOut"),
      })
      .strict(),
    transition: transitionSchema,
    layers: z.array(sceneLayerSchema).max(60),
  })
  .strict()
  .superRefine((scene, context) => {
    const seen = new Set<string>();
    for (const layer of scene.layers) {
      if (seen.has(layer.id)) {
        context.addIssue({
          code: "custom",
          message: `重复图层 ID：${layer.id}`,
          path: ["layers"],
        });
      }
      seen.add(layer.id);
      if (layer.timing.toMs > scene.durationMs) {
        context.addIssue({
          code: "custom",
          message: `图层 ${layer.id} 超出场景时长`,
          path: ["layers"],
        });
      }
    }
  });

export const compositionAssetSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.enum(["image", "video", "audio"]),
    src: z.string().min(1).max(3_000_000),
    mimeType: z.string().max(120).optional(),
  })
  .strict();

export const compositionSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    width: z.number().int().min(256).max(7680),
    height: z.number().int().min(256).max(7680),
    fps: z.union([
      z.literal(24),
      z.literal(25),
      z.literal(30),
      z.literal(50),
      z.literal(60),
    ]),
    durationInFrames: z.number().int().positive(),
    assets: z.array(compositionAssetSchema).max(500),
    scenes: z.array(sceneDslSchema).min(1).max(100),
  })
  .strict()
  .superRefine((composition, context) => {
    const sceneIds = new Set<string>();
    const assetIds = new Set(composition.assets.map((asset) => asset.id));
    const expectedFrames = composition.scenes.reduce(
      (total, scene) =>
        total + Math.max(1, Math.round((scene.durationMs / 1000) * composition.fps)),
      0,
    );
    if (expectedFrames !== composition.durationInFrames) {
      context.addIssue({
        code: "custom",
        message: `Composition 时长 ${composition.durationInFrames} 与场景总时长 ${expectedFrames} 不一致`,
        path: ["durationInFrames"],
      });
    }
    for (const scene of composition.scenes) {
      if (sceneIds.has(scene.id)) {
        context.addIssue({
          code: "custom",
          message: `重复场景 ID：${scene.id}`,
          path: ["scenes"],
        });
      }
      sceneIds.add(scene.id);
      for (const layer of scene.layers) {
        if (layer.type === "image" && !assetIds.has(layer.assetId)) {
          context.addIssue({
            code: "custom",
            message: `图片图层 ${layer.id} 引用了不存在的素材 ${layer.assetId}`,
            path: ["scenes"],
          });
        }
      }
    }
  });

export type SceneLayerDsl = z.infer<typeof sceneLayerSchema>;
export type TextLayerDsl = z.infer<typeof textLayerSchema>;
export type SvgLayerDsl = z.infer<typeof svgLayerSchema>;
export type ImageLayerDsl = z.infer<typeof imageLayerSchema>;
export type ChartLayerDsl = z.infer<typeof chartLayerSchema>;
export type SceneDsl = z.infer<typeof sceneDslSchema>;
export type CompositionDsl = z.infer<typeof compositionSchema>;

export interface CompositionValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateComposition(input: unknown): CompositionValidation {
  const result = compositionSchema.safeParse(input);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "composition"}: ${issue.message}`,
      ),
      warnings: [],
    };
  }
  const warnings = result.data.scenes
    .filter((scene) => !scene.layers.some((layer) => layer.type === "text"))
    .map((scene) => `${scene.title} 没有文字图层`);
  return { valid: true, errors: [], warnings };
}

export function sceneToRemotionDsl(
  scene: Scene,
  index: number,
  project: VideoProject,
  assets: CompositionDsl["assets"],
): SceneDsl {
  if (scene.remotion) {
    const parsed = sceneDslSchema.safeParse(scene.remotion);
    if (parsed.success) return parsed.data;
  }
  const style = (
    ["cinematic", "diagram", "data", "editorial", "minimal"] as const
  )[index % 5];
  const durationMs = Math.max(500, scene.duration * 1000);
  const accent = scene.accent || "#c8ff65";
  const titleEnd = durationMs;
  const bodyStart = Math.min(durationMs - 250, 850);
  const layers: SceneLayerDsl[] = [
    {
      type: "text",
      id: `${scene.id}-headline`,
      timing: { fromMs: 0, toMs: titleEnd },
      animation: {
        type: "fadeUp",
        delayMs: 80,
        durationMs: 650,
        easing: "spring",
      },
      opacity: 1,
      x: style === "minimal" ? 16 : 8,
      y: style === "cinematic" ? 62 : 69,
      width: style === "diagram" ? 52 : 74,
      height: 18,
      rotation: 0,
      content: scene.title,
      color: "#f3f7f4",
      fontSize: style === "cinematic" ? 58 : style === "minimal" ? 52 : 46,
      fontWeight: 650,
      align: "left",
      letterSpacing: -1,
    },
    {
      type: "text",
      id: `${scene.id}-narration`,
      timing: { fromMs: bodyStart, toMs: durationMs },
      animation: {
        type: "fadeUp",
        delayMs: 0,
        durationMs: 580,
        easing: "easeOut",
      },
      opacity: 0.78,
      x: style === "minimal" ? 16 : 8,
      y: style === "cinematic" ? 76 : 81,
      width: style === "diagram" ? 70 : 62,
      height: 14,
      rotation: 0,
      content: scene.narration,
      color: "#aebcc7",
      fontSize: 20,
      fontWeight: 400,
      align: "left",
      letterSpacing: 0,
    },
  ];

  if (style === "cinematic" || style === "editorial") {
    const fallbackAsset = ensureFallbackAsset(project, scene, index, assets);
    if (fallbackAsset) {
      layers.unshift({
        type: "image",
        id: `${scene.id}-visual`,
        timing: { fromMs: 0, toMs: durationMs },
        animation: {
          type: "scaleIn",
          delayMs: 0,
          durationMs: 1300,
          easing: "easeOut",
        },
        opacity: style === "editorial" ? 0.42 : 0.5,
        x: style === "editorial" ? 46 : 58,
        y: style === "editorial" ? 5 : 3,
        width: style === "editorial" ? 52 : 40,
        height: style === "editorial" ? 52 : 48,
        rotation: style === "editorial" ? 1.5 : 0,
        assetId: fallbackAsset,
        fit: "cover",
        borderRadius: style === "editorial" ? 3 : 22,
        treatment: "vignette",
      });
    }
  }

  if (style === "cinematic" || style === "minimal") {
    layers.unshift({
      type: "svg",
      id: `${scene.id}-orbit`,
      timing: { fromMs: 0, toMs: durationMs },
      animation: {
        type: "fade",
        delayMs: 100,
        durationMs: 1200,
        easing: "easeOut",
      },
      opacity: style === "minimal" ? 0.36 : 0.72,
      x: style === "minimal" ? 54 : 63,
      y: style === "minimal" ? 9 : 5,
      width: style === "minimal" ? 33 : 30,
      height: style === "minimal" ? 33 : 30,
      rotation: 0,
      variant: "orbit",
      color: accent,
      strokeWidth: 1.6,
      intensity: style === "minimal" ? 0.65 : 1,
    });
  }

  if (style === "diagram") {
    layers.unshift(
      {
        type: "svg",
        id: `${scene.id}-grid`,
        timing: { fromMs: 0, toMs: durationMs },
        animation: {
          type: "fade",
          delayMs: 0,
          durationMs: 900,
          easing: "easeOut",
        },
        opacity: 0.2,
        x: 48,
        y: 7,
        width: 46,
        height: 42,
        rotation: 0,
        variant: "grid",
        color: accent,
        strokeWidth: 0.8,
        intensity: 0.8,
      },
      {
        type: "svg",
        id: `${scene.id}-wave`,
        timing: { fromMs: 0, toMs: durationMs },
        animation: {
          type: "slideIn",
          delayMs: 200,
          durationMs: 1000,
          easing: "easeOut",
        },
        opacity: 0.72,
        x: 53,
        y: 36,
        width: 38,
        height: 30,
        rotation: 0,
        variant: "wave",
        color: accent,
        strokeWidth: 2.4,
        intensity: 0.82,
      },
    );
  }

  if (style === "data") {
    layers.unshift({
      type: "chart",
      id: `${scene.id}-chart`,
      timing: { fromMs: 180, toMs: durationMs },
      animation: {
        type: "slideIn",
        delayMs: 0,
        durationMs: 900,
        easing: "easeOut",
      },
      opacity: 0.92,
      x: 53,
      y: 16,
      width: 37,
      height: 38,
      rotation: 0,
      chartType: index % 2 === 0 ? "bar" : "line",
      data: [
        {
          label: "钩子",
          value: Math.max(2, Math.round(scene.narration.length / 7)),
          color: accent,
        },
        {
          label: "解释",
          value: Math.max(3, Math.round(scene.narration.length / 5)),
          color: "#79a9ff",
        },
        {
          label: "收束",
          value: Math.max(2, Math.round(scene.narration.length / 9)),
          color: "#ffbc66",
        },
      ],
      accent,
      showValues: true,
    });
  }

  const backgrounds: Record<
    SceneDsl["styleVariant"],
    SceneDsl["background"]["colors"]
  > = {
    cinematic: ["#153c44", "#081319", "#05090d"],
    diagram: ["#0d2732", "#0b151e", "#070c11"],
    data: ["#10253d", "#0d1723", "#070b10"],
    editorial: ["#2b2a24", "#141713", "#080b0a"],
    minimal: ["#1a2423", "#0d1214", "#070a0b"],
  };

  return sceneDslSchema.parse({
    schemaVersion: "1.0",
    id: scene.id,
    styleVariant: style,
    title: scene.title,
    narration: scene.narration,
    durationMs,
    background: {
      type: "gradient",
      colors: backgrounds[style],
      angle: style === "diagram" ? 110 : 145,
      vignette: style === "minimal" ? 0.5 : 0.34,
    },
    camera: {
      from: { scale: 1, x: 0, y: 0 },
      to:
        style === "cinematic"
          ? { scale: 1.07, x: -1.5, y: -1 }
          : style === "data"
            ? { scale: 1.025, x: 0.8, y: 0 }
            : { scale: 1.02, x: 0, y: -0.6 },
      easing: "easeInOut",
    },
    transition: {
      type:
        style === "cinematic"
          ? "fade"
          : style === "diagram"
            ? "wipe"
            : style === "data"
              ? "slide"
              : "fade",
      durationMs: Math.min(700, Math.round(durationMs * 0.1)),
      direction: index % 2 === 0 ? "left" : "right",
    },
    layers,
  });
}

function ensureFallbackAsset(
  project: VideoProject,
  scene: Scene,
  index: number,
  assets: CompositionDsl["assets"],
): string | null {
  const existing = project.assets.find(
    (asset) => asset.id === scene.assetId && asset.kind === "image",
  );
  if (existing) {
    if (!assets.some((asset) => asset.id === existing.id)) {
      assets.push({
        id: existing.id,
        type: "image",
        src: existing.src,
        mimeType: "image/svg+xml",
      });
    }
    return existing.id;
  }
  if (index % 2 !== 0) return null;
  const assetId = `${scene.id}-generated-visual`;
  if (!assets.some((asset) => asset.id === assetId)) {
    const accent = escapeXml(scene.accent);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">
      <defs><radialGradient id="g" cx="72%" cy="28%" r="80%"><stop offset="0" stop-color="${accent}" stop-opacity=".82"/><stop offset=".48" stop-color="#153e45"/><stop offset="1" stop-color="#071015"/></radialGradient></defs>
      <rect width="960" height="720" fill="url(#g)"/>
      <circle cx="700" cy="230" r="135" fill="none" stroke="${accent}" stroke-width="2" opacity=".7"/>
      <circle cx="700" cy="230" r="75" fill="none" stroke="${accent}" opacity=".45"/>
      <circle cx="700" cy="230" r="18" fill="${accent}"/>
      <path d="M120 590 C330 430 530 610 850 390" fill="none" stroke="${accent}" stroke-width="2" opacity=".4"/>
    </svg>`;
    assets.push({
      id: assetId,
      type: "image",
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      mimeType: "image/svg+xml",
    });
  }
  return assetId;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildProjectComposition(project: VideoProject): CompositionDsl {
  const width =
    project.settings.aspectRatio === "9:16"
      ? 1080
      : project.settings.aspectRatio === "1:1"
        ? 1080
        : 1920;
  const height =
    project.settings.aspectRatio === "9:16"
      ? 1920
      : project.settings.aspectRatio === "1:1"
        ? 1080
        : 1080;
  const fps = 30;
  const assets: CompositionDsl["assets"] = project.assets
    .filter((asset) => asset.kind === "image" || asset.kind === "audio")
    .map((asset) => ({
      id: asset.id,
      type: asset.kind,
      src: asset.src,
      mimeType: asset.src.startsWith("data:image/svg+xml")
        ? "image/svg+xml"
        : undefined,
    }));
  const scenes = project.scenes.map((scene, index) =>
    sceneToRemotionDsl(scene, index, project, assets),
  );
  const durationInFrames = scenes.reduce(
    (total, scene) =>
      total + Math.max(1, Math.round((scene.durationMs / 1000) * fps)),
    0,
  );
  return compositionSchema.parse({
    schemaVersion: "1.0",
    id: `composition-${project.id}`,
    title: project.title,
    width,
    height,
    fps,
    durationInFrames,
    assets,
    scenes,
  });
}

export function buildSceneComposition(
  scene: SceneDsl,
  width: number,
  height: number,
  fps: CompositionDsl["fps"],
  assets: CompositionDsl["assets"],
): CompositionDsl {
  return compositionSchema.parse({
    schemaVersion: "1.0",
    id: `single-${scene.id}`,
    title: scene.title,
    width,
    height,
    fps,
    durationInFrames: Math.max(
      1,
      Math.round((scene.durationMs / 1000) * fps),
    ),
    assets,
    scenes: [scene],
  });
}
