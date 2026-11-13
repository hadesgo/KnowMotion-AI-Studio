import type { CSSProperties } from "react";
import { CanvasLayer } from "../canvas/CanvasLayer";
import type { Asset, AspectRatio, Scene } from "../types";
import "./ScenePreview.css";

export function ScenePreview({
  scene,
  ratio = "16:9",
  asset,
  time,
  showGuides = false,
  className = "",
}: {
  scene?: Scene;
  ratio?: AspectRatio;
  asset?: Asset;
  time?: number;
  showGuides?: boolean;
  className?: string;
}) {
  if (!scene) {
    return (
      <div className={`scene-preview scene-preview--empty ${className}`}>
        <span>NO SCENE SELECTED</span>
      </div>
    );
  }

  const localTime = time ?? 0;
  const progress = Math.min(1, Math.max(0, localTime / Math.max(scene.duration, 0.1)));
  const style = {
    "--scene-accent": scene.accent,
    "--scene-progress": progress,
    aspectRatio: ratio.replace(":", " / "),
    backgroundImage: asset ? `url("${asset.src}")` : undefined,
  } as CSSProperties;

  return (
    <div
      className={`scene-preview ${asset ? "scene-preview--has-asset" : ""} ${className}`}
      style={style}
    >
      <div className="scene-preview__aurora" />
      {!asset && (
        <div className="scene-preview__orbit">
          <span />
          <span />
          <span />
          <i />
        </div>
      )}
      <div className="scene-preview__grain" />
      {showGuides && (
        <div className="scene-preview__guides">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      {scene.layers.map((layer) => {
        const visible = localTime >= layer.start && localTime <= layer.end;
        const entrance = Math.min(1, Math.max(0, (localTime - layer.start) / 0.7));
        if (!visible) return null;
        if (layer.type === "canvas") {
          return (
            <div
              key={layer.id}
              className="scene-layer scene-layer--canvas"
              style={{
                left: `${layer.x}%`,
                top: `${layer.y}%`,
                width: `${layer.width}%`,
                height: `${layer.height}%`,
                opacity: layer.opacity * entrance,
              }}
            >
              <CanvasLayer
                timeMs={localTime * 1000}
                variant={layer.canvasVariant ?? "particleFlow"}
                color={layer.color}
                secondaryColor={layer.secondaryColor}
                density={layer.density ?? 64}
                speed={layer.speed ?? 1}
                lineWidth={layer.lineWidth ?? 1.8}
                intensity={layer.intensity ?? 0.85}
                seed={layer.seed ?? 41}
              />
            </div>
          );
        }
        if (layer.type === "shape") {
          return (
            <span
              key={layer.id}
              className={`scene-layer scene-layer--${layer.shape ?? "rectangle"}`}
              style={{
                left: `${layer.x + Math.sin(progress * Math.PI) * 1.2}%`,
                top: `${layer.y}%`,
                width: `${layer.width}%`,
                height: `${layer.height}%`,
                opacity: layer.opacity * entrance * 0.55,
                background: layer.color,
              }}
            />
          );
        }
        return (
          <div
            key={layer.id}
            className="scene-layer scene-layer--text"
            style={{
              left: `${layer.x}%`,
              top: `${layer.y}%`,
              width: `${layer.width}%`,
              minHeight: `${layer.height}%`,
              opacity: layer.opacity * entrance,
              color: layer.color,
              fontSize: `clamp(14px, ${layer.fontSize / 16}vw, ${layer.fontSize}px)`,
              transform: `translateY(${(1 - entrance) * 14}px)`,
            }}
          >
            {layer.content}
          </div>
        );
      })}
      <div className="scene-preview__meta">
        <span>{scene.shotType}</span>
        <i />
        <span>{scene.duration.toFixed(1)}s</span>
      </div>
    </div>
  );
}
