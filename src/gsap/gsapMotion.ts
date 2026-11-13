import { gsap } from "gsap";

export type GsapMotionPreset =
  | "float"
  | "breathe"
  | "sway"
  | "orbit"
  | "elasticReveal";

export interface GsapMotionConfig {
  preset: GsapMotionPreset;
  intensity: number;
  speed: number;
}

export interface GsapMotionValues {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

const RESTING: GsapMotionValues = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
};

/**
 * Evaluates a paused GSAP timeline at a Remotion frame-derived time.
 * This avoids the realtime ticker, so Player and Renderer produce identical values.
 */
export function evaluateGsapMotion(
  config: GsapMotionConfig | undefined,
  timeMs: number,
): GsapMotionValues {
  if (!config || config.intensity <= 0) return { ...RESTING };

  const target = { ...RESTING };
  const intensity = Math.min(1, Math.max(0, config.intensity));
  const speed = Math.min(3, Math.max(0.05, config.speed));
  const timeline = gsap.timeline({ paused: true });

  switch (config.preset) {
    case "float":
      timeline
        .to(target, {
          y: -8 - intensity * 18,
          x: intensity * 7,
          rotation: intensity * 1.2,
          duration: 0.5,
          ease: "sine.inOut",
        })
        .to(target, {
          y: 0,
          x: 0,
          rotation: 0,
          duration: 0.5,
          ease: "sine.inOut",
        });
      break;
    case "breathe":
      timeline
        .to(target, {
          scale: 1 + intensity * 0.055,
          duration: 0.5,
          ease: "sine.inOut",
        })
        .to(target, {
          scale: 1,
          duration: 0.5,
          ease: "sine.inOut",
        });
      break;
    case "sway":
      timeline
        .to(target, {
          x: intensity * 34,
          rotation: intensity * 1.6,
          duration: 0.28,
          ease: "power2.inOut",
        })
        .to(target, {
          x: -intensity * 34,
          rotation: -intensity * 1.6,
          duration: 0.44,
          ease: "power2.inOut",
        })
        .to(target, {
          x: 0,
          rotation: 0,
          duration: 0.28,
          ease: "power2.inOut",
        });
      break;
    case "orbit": {
      const radiusX = 8 + intensity * 28;
      const radiusY = 4 + intensity * 17;
      timeline
        .to(target, {
          x: radiusX,
          y: 0,
          rotation: intensity * 2,
          duration: 0.25,
          ease: "none",
        })
        .to(target, {
          x: 0,
          y: radiusY,
          rotation: 0,
          duration: 0.25,
          ease: "none",
        })
        .to(target, {
          x: -radiusX,
          y: 0,
          rotation: -intensity * 2,
          duration: 0.25,
          ease: "none",
        })
        .to(target, {
          x: 0,
          y: -radiusY,
          rotation: 0,
          duration: 0.25,
          ease: "none",
        });
      break;
    }
    case "elasticReveal":
      target.y = intensity * 34;
      target.scale = 1 - intensity * 0.12;
      target.rotation = -intensity * 3;
      timeline.to(target, {
        y: 0,
        scale: 1,
        rotation: 0,
        duration: 1,
        ease: "elastic.out(1, .55)",
      });
      break;
  }

  const elapsedSeconds = Math.max(0, timeMs) / 1000;
  const progress =
    config.preset === "elasticReveal"
      ? Math.min(1, elapsedSeconds / 0.9)
      : (elapsedSeconds * speed) % 1;
  timeline.progress(progress);
  timeline.kill();
  return {
    x: target.x,
    y: target.y,
    scale: target.scale,
    rotation: target.rotation,
  };
}
