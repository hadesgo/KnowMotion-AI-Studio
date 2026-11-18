import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import {
  compositionSchema,
  type CompositionDsl,
} from "../src/remotion/schema";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const compositionPath = path.resolve(
  argument("--composition", "examples/llm-context/composition.json")!,
);
const outputDirectory = path.resolve(
  argument("--out-dir", "renders/llm-context-qa/stills")!,
);
const frames = argument("--frames", "255,525,750,975,1230,1515")!
  .split(",")
  .map(Number)
  .filter((frame) => Number.isInteger(frame) && frame >= 0);

const composition = compositionSchema.parse(
  JSON.parse(await readFile(compositionPath, "utf8")) as CompositionDsl,
);
const serveUrl = await bundle({
  entryPoint: path.join(root, "src/remotion/index.ts"),
});
const selectedComposition = await selectComposition({
  serveUrl,
  id: "KnowledgeVideo",
  inputProps: { composition },
});
await mkdir(outputDirectory, { recursive: true });
for (const [index, frame] of frames.entries()) {
  const output = path.join(
    outputDirectory,
    `scene-${String(index + 1).padStart(2, "0")}.png`,
  );
  await renderStill({
    serveUrl,
    composition: selectedComposition,
    inputProps: { composition },
    frame: Math.min(frame, composition.durationInFrames - 1),
    output,
  });
  console.log(`Rendered frame ${frame} -> ${output}`);
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
