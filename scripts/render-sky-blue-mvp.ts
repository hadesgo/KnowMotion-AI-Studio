import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSkyBlueProject } from "../src/data/demo";
import {
  buildProjectComposition,
  compositionSchema,
} from "../src/remotion/schema";
import { renderRemotionVideo } from "./render-remotion";
import type { Asset, SubtitleCue, TimelineClip } from "../src/types";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mediaDirectory = path.join(root, "examples/sky-blue/audio");
await rm(mediaDirectory, { recursive: true, force: true });
await mkdir(mediaDirectory, { recursive: true });

const project = makeSkyBlueProject();
const powershellScript = path.join(mediaDirectory, "synthesize.ps1");
await writeFile(
  powershellScript,
  String.raw`param([string]$TextPath,[string]$OutputPath,[string]$VoiceName,[int]$Rate)
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath $TextPath
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $VoiceName -and $_.Enabled } | Select-Object -First 1
  if ($null -ne $voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
  $synth.Rate = $Rate
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutputPath, $format)
  $synth.Speak($text)
} finally { $synth.Dispose() }`,
);

const audioAssets: Asset[] = [];
const narrationClips: TimelineClip[] = [];
let cursor = 0;
for (const [index, scene] of project.scenes.entries()) {
  const textPath = path.join(mediaDirectory, `${scene.id}.txt`);
  const audioPath = path.join(mediaDirectory, `${scene.id}.wav`);
  await writeFile(textPath, scene.narration, "utf8");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      powershellScript,
      "-TextPath",
      textPath,
      "-OutputPath",
      audioPath,
      "-VoiceName",
      "Microsoft Huihui Desktop",
      "-Rate",
      "4",
    ],
    { stdio: "inherit" },
  );
  const bytes = await readFile(audioPath);
  const durationMs = wavDurationMs(bytes);
  scene.duration = Math.max(scene.duration, durationMs / 1000 + 0.35);
  const asset: Asset = {
    id: `narration-${scene.id}`,
    sceneId: scene.id,
    name: `旁白 · ${scene.title}`,
    kind: "audio",
    src: `data:audio/wav;base64,${bytes.toString("base64")}`,
    prompt: "Windows SAPI local speech synthesis",
    createdAt: new Date().toISOString(),
    local: true,
    durationMs,
  };
  audioAssets.push(asset);
  narrationClips.push({
    id: `narration-clip-${index}`,
    track: "narration",
    sceneId: scene.id,
    assetId: asset.id,
    label: asset.name,
    start: cursor + 0.15,
    duration: durationMs / 1000,
    color: "#a78bfa",
  });
  cursor += scene.duration;
}

const musicBytes = createAmbientMusic(15);
const musicPath = path.join(mediaDirectory, "ambient-bed.wav");
await writeFile(musicPath, musicBytes);
const musicAsset: Asset = {
  id: "music-ambient-knowledge-bed",
  sceneId: "project",
  name: "Ambient Knowledge Bed",
  kind: "audio",
  src: `data:audio/wav;base64,${musicBytes.toString("base64")}`,
  prompt: "Procedurally generated calm study background",
  createdAt: new Date().toISOString(),
  local: true,
  durationMs: wavDurationMs(musicBytes),
};

const videoClips: TimelineClip[] = [];
let videoCursor = 0;
const subtitles: SubtitleCue[] = [];
for (const [index, scene] of project.scenes.entries()) {
  videoClips.push({
    id: `video-${scene.id}`,
    track: "video",
    sceneId: scene.id,
    label: `${String(index + 1).padStart(2, "0")} ${scene.title}`,
    start: videoCursor,
    duration: scene.duration,
    color: scene.accent,
  });
  const parts = scene.narration
    .split(/(?<=[。！？])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const step = scene.duration / Math.max(1, parts.length);
  parts.forEach((part, partIndex) => {
    subtitles.push({
      id: `subtitle-${scene.id}-${partIndex}`,
      sceneId: scene.id,
      start: videoCursor + 0.15 + partIndex * step,
      end: videoCursor + 0.15 + (partIndex + 1) * step,
      text: part,
    });
  });
  videoCursor += scene.duration;
}

project.assets = [...audioAssets, musicAsset];
project.subtitles = subtitles;
project.timeline = [
  ...videoClips,
  ...narrationClips,
  {
    id: "music-clip",
    track: "music",
    sceneId: "project",
    assetId: musicAsset.id,
    label: musicAsset.name,
    start: 0,
    duration: mediaDuration(project),
    color: "#f0a760",
  },
];

const composition = compositionSchema.parse(
  buildProjectComposition(project),
);
await writeFile(
  path.join(root, "examples/sky-blue/composition.json"),
  JSON.stringify(composition, null, 2),
);
await renderRemotionVideo(
  composition,
  path.join(root, "renders/sky-blue-mvp.mp4"),
);
console.log(
  `Rendered sky-blue MVP: ${composition.durationInFrames} frames, ${composition.audioTracks.length} audio tracks.`,
);

function wavDurationMs(buffer: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error("Invalid WAV file");
  return (dataSize / byteRate) * 1000;
}

function createAmbientMusic(seconds: number): Buffer {
  const sampleRate = 22_050;
  const sampleCount = sampleRate * seconds;
  const data = Buffer.alloc(sampleCount * 2);
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 329.63],
  ];
  const chordSamples = sampleCount / chords.length;
  for (let index = 0; index < sampleCount; index += 1) {
    const chord = chords[Math.min(chords.length - 1, Math.floor(index / chordSamples))];
    const time = index / sampleRate;
    const pad = chord.reduce(
      (sum, frequency, chordIndex) =>
        sum + Math.sin(time * frequency * Math.PI * 2 + chordIndex) * 0.055,
      0,
    );
    const pulse = Math.max(0, Math.sin(time * 0.45 * Math.PI * 2)) * 0.012;
    const edge = Math.min(1, time / 0.8, (seconds - time) / 0.8);
    data.writeInt16LE(Math.round((pad + pulse) * edge * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mediaDuration(projectValue: ReturnType<typeof makeSkyBlueProject>) {
  return projectValue.scenes.reduce((sum, scene) => sum + scene.duration, 0);
}
