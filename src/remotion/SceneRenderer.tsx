import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CanvasLayer } from "../canvas/CanvasLayer";
import { evaluateGsapMotion } from "../gsap/gsapMotion";
import type {
  CanvasLayerDsl,
  ChartLayerDsl,
  CompositionDsl,
  ImageLayerDsl,
  SceneDsl,
  SceneLayerDsl,
  SvgLayerDsl,
  TextLayerDsl,
  VideoLayerDsl,
} from "./schema";

const easingMap = {
  linear: Easing.linear,
  easeIn: Easing.in(Easing.cubic),
  easeOut: Easing.out(Easing.cubic),
  easeInOut: Easing.inOut(Easing.cubic),
  spring: Easing.out(Easing.back(1.4)),
};

function animationProgress(
  frame: number,
  fps: number,
  fromMs: number,
  delayMs: number,
  durationMs: number,
  easing: keyof typeof easingMap,
): number {
  if (durationMs <= 0) return 1;
  const start = ((fromMs + delayMs) / 1000) * fps;
  const duration = Math.max(1, (durationMs / 1000) * fps);
  if (easing === "spring") {
    return spring({
      frame: frame - start,
      fps,
      config: { damping: 16, stiffness: 115, mass: 0.85 },
    });
  }
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easingMap[easing],
  });
}

function layerOpacity(
  scene: SceneDsl,
  layer: SceneLayerDsl,
  localFrame: number,
  fps: number,
) {
  const start = (layer.timing.fromMs / 1000) * fps;
  const end = (layer.timing.toMs / 1000) * fps;
  const entrance = animationProgress(
    localFrame,
    fps,
    layer.timing.fromMs,
    layer.animation.delayMs,
    layer.animation.durationMs,
    layer.animation.easing,
  );
  if (localFrame < start || localFrame > end) return 0;
  const fadeOut = interpolate(
    localFrame,
    [Math.max(start, end - fps * 0.28), end],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return layer.opacity * entrance * fadeOut * (scene.durationMs > 0 ? 1 : 0);
}

function AnimationShell({
  scene,
  layer,
  children,
}: {
  scene: SceneDsl;
  layer: SceneLayerDsl;
  children: ReactNode;
}) {
  const localFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = animationProgress(
    localFrame,
    fps,
    layer.timing.fromMs,
    layer.animation.delayMs,
    layer.animation.durationMs,
    layer.animation.easing,
  );
  const opacity = layerOpacity(scene, layer, localFrame, fps);
  const translateX = layer.animation.type === "slideIn" ? (1 - progress) * -5 : 0;
  const translateY = layer.animation.type === "fadeUp" ? (1 - progress) * 5 : 0;
  const scale = layer.animation.type === "scaleIn" ? 0.9 + progress * 0.1 : 1;
  const gsapTimeMs = (localFrame / fps) * 1000;
  const sceneGsap = evaluateGsapMotion(scene.gsap, gsapTimeMs);
  const layerGsap = evaluateGsapMotion(layer.gsap, gsapTimeMs);
  const gsapMotion = {
    x: sceneGsap.x + layerGsap.x,
    y: sceneGsap.y + layerGsap.y,
    scale: sceneGsap.scale * layerGsap.scale,
    rotation: sceneGsap.rotation + layerGsap.rotation,
  };
  const style: CSSProperties = {
    position: "absolute",
    left: `${layer.x}%`,
    top: `${layer.y}%`,
    width: `${layer.width}%`,
    height: `${layer.height}%`,
    opacity,
    transform: `translate(${translateX}%, ${translateY}%) translate(${gsapMotion.x}px, ${gsapMotion.y}px) rotate(${layer.rotation + gsapMotion.rotation}deg) scale(${scale * gsapMotion.scale})`,
    transformOrigin: "left top",
    willChange: layer.gsap || scene.gsap ? "transform" : undefined,
  };
  return <div style={style}>{children}</div>;
}

function TextRenderer({ layer }: { layer: TextLayerDsl }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = animationProgress(
    frame,
    fps,
    layer.timing.fromMs,
    layer.animation.delayMs,
    layer.animation.durationMs,
    layer.animation.easing,
  );
  const visibleText =
    layer.animation.type === "typewriter"
      ? layer.content.slice(0, Math.ceil(layer.content.length * Math.max(0.02, progress)))
      : layer.content;
  return (
    <div
      style={{
        color: layer.color,
        fontSize: layer.fontSize,
        fontWeight: layer.fontWeight,
        lineHeight: 1.08,
        letterSpacing: layer.letterSpacing,
        textAlign: layer.align,
        fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
        textShadow: "0 8px 32px rgba(0,0,0,.28)",
        display: "flex",
        alignItems: "flex-end",
        height: "100%",
      }}
    >
      <span style={{ width: "100%" }}>{visibleText}</span>
    </div>
  );
}

function SvgRenderer({ layer }: { layer: SvgLayerDsl }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durationFrames = (layer.timing.toMs / 1000) * fps;
  const progress = interpolate(frame, [0, Math.max(1, durationFrames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const common = {
    width: "100%",
    height: "100%",
    overflow: "visible" as const,
  };
  if (layer.variant === "orbit") {
    return (
      <svg viewBox="0 0 240 240" style={common}>
        {[0, 1, 2, 3].map((ring) => (
          <circle
            key={ring}
            cx="120"
            cy="120"
            r={32 + ring * 24}
            fill="none"
            stroke={layer.color}
            strokeWidth={ring === 0 ? layer.strokeWidth * 2 : layer.strokeWidth}
            opacity={(1 - ring * 0.17) * layer.intensity}
            strokeDasharray={`${420 * progress} 900`}
            transform={`rotate(${progress * 18 + ring * 7} 120 120)`}
          />
        ))}
        <line
          x1={120 - 100 * Math.cos(progress * Math.PI)}
          y1={120 - 40}
          x2={120 + 100 * Math.cos(progress * Math.PI)}
          y2={120 + 40}
          stroke={layer.color}
          strokeWidth={layer.strokeWidth}
          opacity={0.35 * layer.intensity}
        />
        <circle cx="120" cy="120" r={9 + progress * 4} fill={layer.color} />
      </svg>
    );
  }
  if (layer.variant === "wave") {
    const offset = progress * 70;
    return (
      <svg viewBox="0 0 400 220" style={common}>
        {[0, 1, 2].map((line) => (
          <path
            key={line}
            d={`M0 ${110 + line * 22} C 70 ${45 + line * 22 + Math.sin(offset / 24) * 20}, 130 ${180 - line * 15}, 210 ${105 + line * 12} S 350 ${60 + line * 18}, 400 ${105 + line * 10}`}
            fill="none"
            stroke={layer.color}
            strokeWidth={layer.strokeWidth * (line === 1 ? 1.4 : 0.8)}
            opacity={(0.72 - line * 0.2) * layer.intensity}
          />
        ))}
      </svg>
    );
  }
  if (layer.variant === "grid") {
    return (
      <svg viewBox="0 0 400 300" style={common}>
        {Array.from({ length: 11 }, (_, index) => (
          <line
            key={`v-${index}`}
            x1={index * 40}
            x2={index * 40}
            y1="0"
            y2="300"
            stroke={layer.color}
            strokeWidth={layer.strokeWidth}
            opacity={layer.intensity * 0.5}
          />
        ))}
        {Array.from({ length: 8 }, (_, index) => (
          <line
            key={`h-${index}`}
            x1="0"
            x2="400"
            y1={index * 40}
            y2={index * 40}
            stroke={layer.color}
            strokeWidth={layer.strokeWidth}
            opacity={layer.intensity * 0.5}
          />
        ))}
      </svg>
    );
  }
  if (layer.variant === "particles") {
    return (
      <svg viewBox="0 0 300 300" style={common}>
        {Array.from({ length: 34 }, (_, index) => {
          const angle = (index / 34) * Math.PI * 2 + progress * 2.8;
          const radius = 45 + ((index * 37) % 95);
          return (
            <circle
              key={index}
              cx={150 + Math.cos(angle) * radius}
              cy={150 + Math.sin(angle) * radius}
              r={1.5 + (index % 3)}
              fill={layer.color}
              opacity={(0.28 + (index % 5) * 0.12) * layer.intensity}
            />
          );
        })}
      </svg>
    );
  }
  const radius = 82;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 220 220" style={common}>
      <circle cx="110" cy="110" r={radius} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="9" />
      <circle
        cx="110"
        cy="110"
        r={radius}
        fill="none"
        stroke={layer.color}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${circumference * progress} ${circumference}`}
        transform="rotate(-90 110 110)"
      />
      <text x="110" y="120" textAnchor="middle" fill={layer.color} fontSize="31" fontWeight="600">
        {Math.round(progress * 100)}%
      </text>
    </svg>
  );
}

function ImageRenderer({
  layer,
  composition,
}: {
  layer: ImageLayerDsl;
  composition: CompositionDsl;
}) {
  const asset = composition.assets.find((item) => item.id === layer.assetId);
  if (!asset) return null;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        borderRadius: layer.borderRadius,
        position: "relative",
      }}
    >
      <Img
        src={asset.src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: layer.fit,
          filter:
            layer.treatment === "duotone"
              ? "saturate(.65) contrast(1.15)"
              : "saturate(.9)",
        }}
      />
      {layer.treatment !== "none" && (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(circle, transparent 24%, rgba(0,0,0,.62) 100%)",
            borderRadius: layer.borderRadius,
          }}
        />
      )}
    </div>
  );
}

function VideoRenderer({
  layer,
  composition,
}: {
  layer: VideoLayerDsl;
  composition: CompositionDsl;
}) {
  const { fps } = useVideoConfig();
  const asset = composition.assets.find(
    (item) => item.id === layer.assetId && item.type === "video",
  );
  if (!asset) return null;
  const trimBefore = Math.max(0, Math.round((layer.trimStartMs / 1000) * fps));
  const layerFrames = Math.max(
    1,
    Math.round(((layer.timing.toMs - layer.timing.fromMs) / 1000) * fps),
  );
  const trimmedFrames =
    layer.trimEndMs > layer.trimStartMs
      ? Math.round(((layer.trimEndMs - layer.trimStartMs) / 1000) * fps)
      : layerFrames;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        borderRadius: layer.borderRadius,
        background: "#05080c",
      }}
    >
      <OffthreadVideo
        src={asset.src}
        trimBefore={trimBefore}
        durationInFrames={Math.max(1, Math.min(layerFrames, trimmedFrames))}
        playbackRate={layer.playbackRate}
        muted={layer.muted}
        volume={layer.muted ? 0 : layer.volume}
        pauseWhenBuffering
        style={{
          width: "100%",
          height: "100%",
          objectFit: layer.fit,
        }}
      />
    </div>
  );
}

function ChartRenderer({ layer }: { layer: ChartLayerDsl }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durationFrames = (layer.timing.toMs / 1000) * fps;
  const progress = interpolate(frame, [0, Math.max(1, durationFrames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const max = Math.max(1, ...layer.data.map((item) => Math.abs(item.value)));
  if (layer.chartType === "donut") {
    const total = layer.data.reduce((sum, item) => sum + Math.abs(item.value), 0);
    const portions = layer.data.map(
      (item) => Math.abs(item.value) / Math.max(1, total),
    );
    const offsets = portions.map((_, index) =>
      portions
        .slice(0, index)
        .reduce((sum, portion) => sum + portion, 0),
    );
    return (
      <svg viewBox="0 0 300 220" style={{ width: "100%", height: "100%" }}>
        {layer.data.map((item, index) => {
          const portion = portions[index];
          const start = offsets[index];
          const color = item.color ?? [layer.accent, "#79a9ff", "#ffbc66"][index % 3];
          return (
            <circle
              key={item.label}
              cx="110"
              cy="110"
              r="74"
              fill="none"
              stroke={color}
              strokeWidth="24"
              pathLength="100"
              strokeDasharray={`${portion * 100 * progress} 100`}
              strokeDashoffset={start * -100}
              transform="rotate(-90 110 110)"
            />
          );
        })}
        <text x="110" y="118" textAnchor="middle" fill="#f2f6f2" fontSize="24" fontWeight="600">
          {Math.round(progress * 100)}%
        </text>
        {layer.data.map((item, index) => (
          <g key={item.label} transform={`translate(215 ${42 + index * 25})`}>
            <circle r="4" fill={item.color ?? [layer.accent, "#79a9ff", "#ffbc66"][index % 3]} />
            <text x="10" y="4" fill="#aebcc7" fontSize="10">{item.label}</text>
          </g>
        ))}
      </svg>
    );
  }
  const bottom = 185;
  const chartWidth = 270;
  const chartHeight = 135;
  if (layer.chartType === "line") {
    const points = layer.data.map((item, index) => ({
      x: 22 + (index / Math.max(1, layer.data.length - 1)) * chartWidth,
      y: bottom - (Math.abs(item.value) / max) * chartHeight * progress,
    }));
    return (
      <svg viewBox="0 0 320 220" style={{ width: "100%", height: "100%" }}>
        <line x1="20" y1={bottom} x2="310" y2={bottom} stroke="rgba(255,255,255,.15)" />
        <polyline
          points={points.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke={layer.accent}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((point, index) => (
          <g key={layer.data[index].label}>
            <circle cx={point.x} cy={point.y} r="5" fill={layer.accent} />
            <text x={point.x} y={209} textAnchor="middle" fill="#92a3af" fontSize="9">
              {layer.data[index].label}
            </text>
          </g>
        ))}
      </svg>
    );
  }
  const barWidth = Math.min(44, 220 / layer.data.length);
  return (
    <svg viewBox="0 0 320 220" style={{ width: "100%", height: "100%" }}>
      <line x1="20" y1={bottom} x2="310" y2={bottom} stroke="rgba(255,255,255,.15)" />
      {layer.data.map((item, index) => {
        const x = 28 + index * (270 / layer.data.length) + 8;
        const barHeight = (Math.abs(item.value) / max) * chartHeight * progress;
        const color = item.color ?? [layer.accent, "#79a9ff", "#ffbc66"][index % 3];
        return (
          <g key={item.label}>
            <rect
              x={x}
              y={bottom - barHeight}
              width={barWidth}
              height={barHeight}
              rx="5"
              fill={color}
              opacity=".85"
            />
            {layer.showValues && (
              <text x={x + barWidth / 2} y={bottom - barHeight - 8} textAnchor="middle" fill="#dfe7e5" fontSize="9">
                {Math.round(item.value * progress)}
              </text>
            )}
            <text x={x + barWidth / 2} y={207} textAnchor="middle" fill="#92a3af" fontSize="9">
              {item.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function CanvasRenderer({ layer }: { layer: CanvasLayerDsl }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;

  useEffect(() => {
    const handle = delayRender("Drawing Canvas animation layer");
    let continued = false;
    const nextPaint = requestAnimationFrame(() => {
      continued = true;
      continueRender(handle);
    });
    return () => {
      cancelAnimationFrame(nextPaint);
      if (!continued) continueRender(handle);
    };
  }, [frame, layer.id, layer.variant]);

  return (
    <CanvasLayer
      timeMs={timeMs}
      variant={layer.variant}
      color={layer.color}
      secondaryColor={layer.secondaryColor}
      density={layer.density}
      speed={layer.speed}
      lineWidth={layer.lineWidth}
      intensity={layer.intensity}
      seed={layer.seed}
      borderRadius={layer.borderRadius}
    />
  );
}

function LayerRenderer({
  layer,
  scene,
  composition,
}: {
  layer: SceneLayerDsl;
  scene: SceneDsl;
  composition: CompositionDsl;
}) {
  return (
    <AnimationShell scene={scene} layer={layer}>
      {layer.type === "text" ? (
        <TextRenderer layer={layer} />
      ) : layer.type === "svg" ? (
        <SvgRenderer layer={layer} />
      ) : layer.type === "image" ? (
        <ImageRenderer layer={layer} composition={composition} />
      ) : layer.type === "video" ? (
        <VideoRenderer layer={layer} composition={composition} />
      ) : layer.type === "chart" ? (
        <ChartRenderer layer={layer} />
      ) : (
        <CanvasRenderer layer={layer} />
      )}
    </AnimationShell>
  );
}

function Background({ scene }: { scene: SceneDsl }) {
  const background =
    scene.background.type === "solid"
      ? scene.background.colors[0]
      : `linear-gradient(${scene.background.angle}deg, ${scene.background.colors.join(", ")})`;
  return (
    <AbsoluteFill style={{ background }}>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 78% 18%, rgba(255,255,255,.09), transparent 23%)",
        }}
      />
      <AbsoluteFill
        style={{
          boxShadow: `inset 0 0 ${Math.round(220 * scene.background.vignette)}px rgba(0,0,0,.7)`,
        }}
      />
    </AbsoluteFill>
  );
}

function SceneStage({
  scene,
  composition,
  index,
}: {
  scene: SceneDsl;
  composition: CompositionDsl;
  index: number;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const cameraProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing:
      scene.camera.easing === "linear"
        ? Easing.linear
        : scene.camera.easing === "easeIn"
          ? Easing.in(Easing.cubic)
          : scene.camera.easing === "easeOut"
            ? Easing.out(Easing.cubic)
            : Easing.inOut(Easing.cubic),
  });
  const scale = interpolate(cameraProgress, [0, 1], [scene.camera.from.scale, scene.camera.to.scale]);
  const x = interpolate(cameraProgress, [0, 1], [scene.camera.from.x, scene.camera.to.x]);
  const y = interpolate(cameraProgress, [0, 1], [scene.camera.from.y, scene.camera.to.y]);
  const transitionFrames = Math.max(1, (scene.transition.durationMs / 1000) * fps);
  const transitionProgress = interpolate(frame, [0, transitionFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const slideOffset =
    scene.transition.type === "slide"
      ? scene.transition.direction === "left"
        ? (1 - transitionProgress) * 100
        : scene.transition.direction === "right"
          ? (1 - transitionProgress) * -100
          : 0
      : 0;
  const verticalOffset =
    scene.transition.type === "slide" && scene.transition.direction === "up"
      ? (1 - transitionProgress) * 100
      : scene.transition.type === "slide" && scene.transition.direction === "down"
        ? (1 - transitionProgress) * -100
        : 0;
  const opacity =
    scene.transition.type === "fade" || scene.transition.type === "iris"
      ? transitionProgress
      : 1;
  const clipPath =
    scene.transition.type === "wipe"
      ? scene.transition.direction === "left" || scene.transition.direction === "right"
        ? `inset(0 ${scene.transition.direction === "left" ? (1 - transitionProgress) * 100 : 0}% 0 ${scene.transition.direction === "right" ? (1 - transitionProgress) * 100 : 0}%)`
        : `inset(${scene.transition.direction === "up" ? (1 - transitionProgress) * 100 : 0}% 0 ${scene.transition.direction === "down" ? (1 - transitionProgress) * 100 : 0}% 0)`
      : scene.transition.type === "iris"
        ? `circle(${transitionProgress * 75}% at 50% 50%)`
        : undefined;
  return (
    <AbsoluteFill
      style={{
        opacity,
        clipPath,
        transform: `translate(${slideOffset}%, ${verticalOffset}%)`,
        overflow: "hidden",
      }}
    >
      <Background scene={scene} />
      <AbsoluteFill
        style={{
          transform: `scale(${scale}) translate(${x}%, ${y}%)`,
          transformOrigin: "center center",
          overflow: "hidden",
        }}
      >
        {scene.layers
          .slice()
          .sort((left, right) => left.y + left.width - (right.y + right.width))
          .map((layer) => (
            <LayerRenderer
              key={layer.id}
              layer={layer}
              scene={scene}
              composition={composition}
            />
          ))}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          right: "5%",
          bottom: "4%",
          color: "rgba(230,240,237,.45)",
          fontSize: 13,
          letterSpacing: 2,
          fontFamily: '"Segoe UI", sans-serif',
        }}
      >
        {String(index + 1).padStart(2, "0")} / {String(composition.scenes.length).padStart(2, "0")}
      </div>
    </AbsoluteFill>
  );
}

export function KnowledgeComposition({
  composition,
}: {
  composition: CompositionDsl;
}) {
  const { fps } = useVideoConfig();
  const sceneDurations = composition.scenes.map((scene) =>
    Math.max(1, Math.round((scene.durationMs / 1000) * fps)),
  );
  const sceneOffsets = sceneDurations.map((_, index) =>
    sceneDurations
      .slice(0, index)
      .reduce((sum, duration) => sum + duration, 0),
  );
  return (
    <AbsoluteFill style={{ background: "#06090c" }}>
      {composition.audioTracks.map((track) => {
        const asset = composition.assets.find(
          (item) => item.id === track.assetId,
        );
        if (!asset) return null;
        const from = Math.max(
          0,
          Math.round((track.fromMs / 1000) * fps),
        );
        const durationInFrames = Math.max(
          1,
          Math.round(((track.toMs - track.fromMs) / 1000) * fps),
        );
        return (
          <Sequence
            key={track.id}
            from={from}
            durationInFrames={durationInFrames}
          >
            <Audio
              src={asset.src}
              volume={track.volume}
              loop={track.loop}
            />
          </Sequence>
        );
      })}
      {composition.scenes.map((scene, index) => {
        const durationInFrames = sceneDurations[index];
        const from = sceneOffsets[index];
        return (
          <Sequence
            key={scene.id}
            from={from}
            durationInFrames={durationInFrames}
            premountFor={fps}
          >
            <SceneStage scene={scene} composition={composition} index={index} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
