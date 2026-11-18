import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { CompositionDsl } from "../src/remotion/schema";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function renderVideoFile(
  composition: CompositionDsl,
  outputLocation: string,
): Promise<string> {
  const serveUrl = await bundle({
    entryPoint: path.join(projectRoot, "src/remotion/index.ts"),
  });
  const inputProps = { composition };
  const selectedComposition = await selectComposition({
    serveUrl,
    id: "KnowledgeVideo",
    inputProps,
  });
  await mkdir(path.dirname(outputLocation), { recursive: true });
  await renderMedia({
    serveUrl,
    composition: selectedComposition,
    inputProps,
    codec: "h264",
    outputLocation,
    concurrency: 1,
    onProgress: ({ progress }) => {
      process.stdout.write(`\rRendering ${Math.round(progress * 100)}%`);
    },
  });
  process.stdout.write("\n");
  return outputLocation;
}
