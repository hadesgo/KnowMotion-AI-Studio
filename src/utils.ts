import type { AspectRatio, Scene, VideoProject } from "./types";

export function makeId(prefix = "id"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function estimateSpeechSeconds(text: string): number {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return 0;
  return Math.max(1, Math.round(compact.length / 4.2));
}

export function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ratioValue(ratio: AspectRatio): number {
  if (ratio === "9:16") return 9 / 16;
  if (ratio === "1:1") return 1;
  return 16 / 9;
}

export function projectDuration(project: VideoProject): number {
  return project.scenes.reduce((total, scene) => total + scene.duration, 0);
}

export function truncate(text: string, length = 90): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length).trim()}…`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = "text/plain"): void {
  downloadBlob(new Blob([text], { type }), filename);
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function sceneSvg(scene: Scene, width = 1280, height = 720): string {
  const title = escapeXml(scene.title);
  const narration = escapeXml(truncate(scene.narration, 74));
  const accent = escapeXml(scene.accent);
  const asset = scene.assetId ? scene.assetId : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1280 720">
  <defs>
    <radialGradient id="g" cx="80%" cy="18%" r="82%">
      <stop offset="0" stop-color="${accent}" stop-opacity=".7"/>
      <stop offset=".34" stop-color="#173f46" stop-opacity=".55"/>
      <stop offset="1" stop-color="#071018"/>
    </radialGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e9ffd0"/>
      <stop offset="1" stop-color="${accent}" stop-opacity=".2"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="30"/></filter>
  </defs>
  <rect width="1280" height="720" fill="#070b10"/>
  <rect width="1280" height="720" fill="url(#g)"/>
  <circle cx="1050" cy="190" r="128" fill="none" stroke="url(#line)" stroke-width="1.2" opacity=".75"/>
  <circle cx="1050" cy="190" r="78" fill="none" stroke="${accent}" stroke-width="1" opacity=".5"/>
  <circle cx="1050" cy="190" r="26" fill="${accent}" opacity=".9" filter="url(#blur)"/>
  <path d="M760 124h250M785 92h170M812 156h124" stroke="${accent}" stroke-width="2" opacity=".55"/>
  <text x="92" y="310" fill="#9fb0bf" font-family="Segoe UI, sans-serif" font-size="22" letter-spacing="5">KNOWMOTION / ${escapeXml(scene.shotType.toUpperCase())}</text>
  <text x="88" y="392" fill="#f3f7f1" font-family="Segoe UI, sans-serif" font-size="58" font-weight="650">${title}</text>
  <foreignObject x="91" y="430" width="760" height="130">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#a9b8c4;font:24px/1.55 'Segoe UI',sans-serif">${narration}</div>
  </foreignObject>
  <rect x="91" y="608" width="112" height="4" rx="2" fill="${accent}"/>
  <text x="91" y="646" fill="#7f91a1" font-family="Segoe UI, sans-serif" font-size="17">${escapeXml(asset ? "ASSET LINKED" : "VECTOR SCENE")}</text>
</svg>`;
}

export function sceneSvgDataUrl(scene: Scene): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sceneSvg(scene))}`;
}

export interface VisualDraftOptions {
  /** 设定集派生种子：同一锚点每次生成得到同一张草案。 */
  seed?: number;
  /** 优先使用角色/场景调色板。 */
  palette?: string[];
  /** 画面上标注的锚点名称。 */
  anchorLabel?: string;
}

export function createVisualDraftSvg(
  prompt: string,
  style: string,
  index: number,
  options: VisualDraftOptions = {},
): { src: string; accent: string } {
  const palettes = [
    ["#c8ff65", "#0c3540", "#1f6b65"],
    ["#79a9ff", "#112b53", "#4762a8"],
    ["#ffbc66", "#4b2d1c", "#9b6b3d"],
    ["#f3a7ff", "#352046", "#6f4c88"],
  ];
  const seed =
    options.seed ??
    [...`${prompt}${style}${index}`].reduce(
      (total, char) => total + char.charCodeAt(0),
      0,
    );
  const palette = options.palette?.length
    ? [
        options.palette[0],
        options.palette[1] ?? "#0c3540",
        options.palette[2] ?? options.palette[1] ?? "#1f6b65",
      ]
    : palettes[seed % palettes.length];
  const rings = 3 + (seed % 4);
  const angle = seed % 360;
  const title = escapeXml(truncate(prompt || "Visual concept", 35));
  const anchorLine = options.anchorLabel
    ? escapeXml(truncate(options.anchorLabel, 52))
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
    <defs>
      <radialGradient id="bg" cx="${25 + (seed % 55)}%" cy="25%" r="90%">
        <stop offset="0" stop-color="${palette[2]}" stop-opacity=".95"/>
        <stop offset=".5" stop-color="${palette[1]}" stop-opacity=".9"/>
        <stop offset="1" stop-color="#060a0e"/>
      </radialGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="16"/></filter>
    </defs>
    <rect width="960" height="640" fill="url(#bg)"/>
    <g transform="translate(${640 + (seed % 130)} ${250 + (seed % 80)}) rotate(${angle})">
      ${Array.from({ length: rings }, (_, ring) => `<circle r="${40 + ring * 52}" fill="none" stroke="${palette[0]}" stroke-width="${ring === 0 ? 6 : 1.5}" opacity="${0.75 - ring * 0.09}"/>`).join("")}
      <circle r="24" fill="${palette[0]}" filter="url(#glow)"/>
    </g>
    <path d="M0 550 C220 ${390 + (seed % 100)}, 420 ${590 - (seed % 80)}, 960 390 L960 640 L0 640Z" fill="${palette[1]}" opacity=".38"/>
    <text x="64" y="76" fill="${palette[0]}" font-family="Segoe UI, sans-serif" font-size="14" letter-spacing="4">GENERATED VISUAL STUDY</text>
    <text x="64" y="510" fill="#f3f7f4" font-family="Segoe UI, sans-serif" font-size="40" font-weight="600">${title}</text>
    <text x="64" y="550" fill="#9aabba" font-family="Segoe UI, sans-serif" font-size="18">${escapeXml(style)} · local vector draft ${String(index).padStart(2, "0")}</text>
    ${anchorLine ? `<text x="64" y="586" fill="${palette[0]}" font-family="Segoe UI, sans-serif" font-size="16" letter-spacing="1">${anchorLine}</text>` : ""}
  </svg>`;
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    accent: palette[0],
  };
}

export function toSrt(project: VideoProject): string {
  const format = (seconds: number) => {
    const ms = Math.round((seconds % 1) * 1000)
      .toString()
      .padStart(3, "0");
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0");
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    return `00:${m}:${s},${ms}`;
  };
  return project.subtitles
    .map(
      (cue, index) =>
        `${index + 1}\n${format(cue.start)} --> ${format(cue.end)}\n${cue.text}`,
    )
    .join("\n\n");
}
