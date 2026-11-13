export type CanvasAnimationVariant =
  | "particleFlow"
  | "waveform"
  | "network"
  | "orbitTrails";

export interface CanvasAnimationConfig {
  variant: CanvasAnimationVariant;
  color: string;
  secondaryColor?: string;
  density: number;
  speed: number;
  lineWidth: number;
  intensity: number;
  seed: number;
}

const WIDTH = 960;
const HEIGHT = 540;

export function drawCanvasAnimation(
  canvas: HTMLCanvasElement,
  timeMs: number,
  config: CanvasAnimationConfig,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.save();
  context.globalCompositeOperation = "lighter";
  const time = (timeMs / 1000) * config.speed;
  const duration = Math.max(1, config.density);

  switch (config.variant) {
    case "particleFlow":
      drawParticleFlow(context, time, duration, config);
      break;
    case "waveform":
      drawWaveform(context, time, duration, config);
      break;
    case "network":
      drawKnowledgeNetwork(context, time, duration, config);
      break;
    case "orbitTrails":
      drawOrbitTrails(context, time, duration, config);
      break;
  }
  context.restore();
}

function drawParticleFlow(
  context: CanvasRenderingContext2D,
  time: number,
  density: number,
  config: CanvasAnimationConfig,
) {
  const random = seededRandom(config.seed);
  context.lineCap = "round";
  for (let index = 0; index < density; index += 1) {
    const originX = random() * WIDTH;
    const originY = random() * HEIGHT;
    const phase = random() * Math.PI * 2;
    const size = 0.7 + random() * config.lineWidth;
    const points = traceFlow(originX, originY, time, phase, 5);
    context.beginPath();
    context.strokeStyle =
      index % 4 === 0
        ? config.secondaryColor ?? config.color
        : config.color;
    context.lineWidth = size;
    context.globalAlpha =
      config.intensity * (0.08 + (index % 7) * 0.035);
    points.forEach((point, pointIndex) => {
      if (pointIndex === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
    const head = points.at(-1);
    if (head) {
      context.beginPath();
      context.fillStyle = context.strokeStyle;
      context.globalAlpha = config.intensity * (0.22 + size * 0.1);
      context.arc(head.x, head.y, Math.max(1.2, size * 0.8), 0, Math.PI * 2);
      context.fill();
    }
  }
}

function traceFlow(
  originX: number,
  originY: number,
  time: number,
  phase: number,
  count: number,
) {
  const points = [];
  let x = originX;
  let y = originY;
  for (let index = 0; index < count; index += 1) {
    const angle =
      Math.sin(y * 0.011 + time * 0.7 + phase) * Math.PI * 0.9 +
      Math.cos(x * 0.008 - time * 0.45) * Math.PI * 0.55;
    const step = 12 + index * 4;
    points.push({ x, y });
    x = wrap(x + Math.cos(angle) * step, WIDTH);
    y = wrap(y + Math.sin(angle) * step, HEIGHT);
  }
  return points;
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  time: number,
  density: number,
  config: CanvasAnimationConfig,
) {
  const center = HEIGHT * 0.52;
  for (let line = 0; line < 4; line += 1) {
    context.beginPath();
    context.strokeStyle =
      line === 1 ? config.secondaryColor ?? config.color : config.color;
    context.lineWidth = Math.max(0.5, config.lineWidth * (line === 1 ? 1.4 : 0.65));
    context.globalAlpha = config.intensity * (0.5 - line * 0.08);
    for (let x = 0; x <= WIDTH; x += 8) {
      const envelope =
        0.22 +
        Math.abs(Math.sin((x / WIDTH) * Math.PI * (2 + density * 0.02))) * 0.78;
      const y =
        center +
        line * 22 -
        44 +
        Math.sin(x * 0.018 + time * 2.1 + line * 0.8) *
          66 *
          envelope +
        Math.sin(x * 0.006 - time * 1.3) * 18;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  const barCount = Math.round(18 + density * 0.55);
  const spacing = WIDTH / barCount;
  for (let index = 0; index < barCount; index += 1) {
    const height =
      10 +
      Math.abs(Math.sin(index * 0.73 + time * 2.8)) *
        (32 + density * 0.35);
    context.globalAlpha = config.intensity * 0.18;
    context.fillStyle =
      index % 5 === 0 ? config.secondaryColor ?? config.color : config.color;
    context.fillRect(
      index * spacing + spacing * 0.3,
      center - height / 2,
      Math.max(1.5, spacing * 0.35),
      height,
    );
  }
}

function drawKnowledgeNetwork(
  context: CanvasRenderingContext2D,
  time: number,
  density: number,
  config: CanvasAnimationConfig,
) {
  const random = seededRandom(config.seed);
  const nodes = Array.from({ length: density }, (_, index) => ({
    x: 36 + random() * (WIDTH - 72) + Math.sin(time * 0.45 + index) * 8,
    y: 32 + random() * (HEIGHT - 64) + Math.cos(time * 0.38 + index) * 8,
    radius: 1.5 + random() * (index % 9 === 0 ? 4.2 : 2.3),
  }));

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      const first = nodes[left];
      const second = nodes[right];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (distance > 112) continue;
      context.beginPath();
      context.strokeStyle =
        (left + right) % 7 === 0
          ? config.secondaryColor ?? config.color
          : config.color;
      context.lineWidth = config.lineWidth * 0.35;
      context.globalAlpha =
        config.intensity * (1 - distance / 112) * 0.3;
      context.moveTo(first.x, first.y);
      context.lineTo(second.x, second.y);
      context.stroke();
    }
  }

  nodes.forEach((node, index) => {
    const pulse = 0.55 + Math.sin(time * 1.8 + index) * 0.25;
    context.beginPath();
    context.fillStyle =
      index % 6 === 0 ? config.secondaryColor ?? config.color : config.color;
    context.globalAlpha = config.intensity * pulse;
    context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    context.fill();
  });
}

function drawOrbitTrails(
  context: CanvasRenderingContext2D,
  time: number,
  density: number,
  config: CanvasAnimationConfig,
) {
  const centerX = WIDTH * 0.5;
  const centerY = HEIGHT * 0.5;
  const orbitCount = Math.max(3, Math.round(density / 12));
  context.lineCap = "round";
  for (let orbit = 0; orbit < orbitCount; orbit += 1) {
    const radiusX = 62 + orbit * (18 + density * 0.18);
    const radiusY = radiusX * (0.38 + (orbit % 3) * 0.08);
    const rotation = time * (0.17 + orbit * 0.018);
    context.beginPath();
    context.strokeStyle =
      orbit % 3 === 0 ? config.secondaryColor ?? config.color : config.color;
    context.lineWidth = config.lineWidth * 0.32;
    context.globalAlpha = config.intensity * 0.12;
    context.ellipse(centerX, centerY, radiusX, radiusY, rotation, 0, Math.PI * 2);
    context.stroke();

    const trails = density > 80 ? 3 : 2;
    for (let trail = 0; trail < trails; trail += 1) {
      for (let segment = 0; segment < 34; segment += 1) {
        const angle =
          time * (0.7 + orbit * 0.13) -
          segment * 0.018 +
          trail * (Math.PI * 2 / trails);
        const x = centerX + Math.cos(angle) * radiusX;
        const y = centerY + Math.sin(angle) * radiusY;
        context.beginPath();
        context.fillStyle =
          orbit % 3 === 0
            ? config.secondaryColor ?? config.color
            : config.color;
        context.globalAlpha =
          config.intensity * (1 - segment / 34) * 0.5;
        context.arc(x, y, Math.max(0.6, config.lineWidth * (1 - segment / 42)), 0, Math.PI * 2);
        context.fill();
      }
    }
  }
}

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function wrap(value: number, maximum: number) {
  return ((value % maximum) + maximum) % maximum;
}
