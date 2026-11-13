import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  drawCanvasAnimation,
  type CanvasAnimationConfig,
} from "./canvasAnimation";

export interface CanvasLayerProps extends CanvasAnimationConfig {
  className?: string;
  timeMs: number;
  borderRadius?: number;
}

export function CanvasLayer({
  className,
  timeMs,
  borderRadius = 0,
  variant,
  color,
  secondaryColor,
  density,
  speed,
  lineWidth,
  intensity,
  seed,
}: CanvasLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawCanvasAnimation(canvas, timeMs, {
      variant,
      color,
      secondaryColor,
      density,
      speed,
      lineWidth,
      intensity,
      seed,
    });
  }, [
    color,
    density,
    intensity,
    lineWidth,
    secondaryColor,
    seed,
    speed,
    variant,
    timeMs,
  ]);

  const style: CSSProperties = {
    width: "100%",
    height: "100%",
    display: "block",
    borderRadius,
  };
  return (
    <canvas
      ref={canvasRef}
      width={960}
      height={540}
      className={className}
      style={style}
      aria-hidden="true"
    />
  );
}
