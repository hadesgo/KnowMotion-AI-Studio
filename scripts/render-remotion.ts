import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSampleProject } from "../src/data/demo";
import {
  buildProjectComposition,
  compositionSchema,
  type CompositionDsl,
} from "../src/remotion/schema";
import { renderVideoFile } from "./render-video-runtime";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function loadComposition(): Promise<CompositionDsl> {
  const compositionPath = argument("--composition");
  if (!compositionPath) {
    return buildProjectComposition(makeSampleProject());
  }
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(
    await readFile(path.resolve(compositionPath), "utf8"),
  ) as unknown;
  return compositionSchema.parse(raw);
}

export async function renderRemotionVideo(
  composition: CompositionDsl,
  outputLocation: string,
) {
  return renderVideoFile(composition, outputLocation);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const composition = await loadComposition();
  const output = path.resolve(
    argument("--out", path.join(projectRoot, "renders", "knowledge-demo.mp4"))!,
  );
  await renderRemotionVideo(composition, output);
  console.log(`Rendered ${output}`);
}
