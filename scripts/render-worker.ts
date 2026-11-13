import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { bundle } from "@remotion/bundler";
import {
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import { compositionSchema, type CompositionDsl } from "../src/remotion/schema";

interface RenderManifest {
  jobId: string;
  entryPoint: string;
  compositionId: string;
  inputProps: { composition: CompositionDsl };
  output: {
    path: string;
    codec: "h264";
    videoBitrate: string;
  };
  runtime?: {
    browserExecutable?: string;
    ffmpegExecutable?: string;
    chromeMode?: "headless-shell" | "chrome-for-testing";
    concurrency?: number;
    timeoutMs?: number;
  };
}

const emit = (payload: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

let renderCanceled = false;

async function loadManifest(manifestPath: string): Promise<RenderManifest> {
  const manifest = JSON.parse(
    await readFile(path.resolve(manifestPath), "utf8"),
  ) as RenderManifest;
  if (
    !manifest.jobId ||
    !manifest.entryPoint ||
    !manifest.compositionId ||
    !manifest.output?.path
  ) {
    throw new Error("Render manifest is missing required fields.");
  }
  manifest.inputProps.composition = compositionSchema.parse(
    manifest.inputProps.composition,
  );
  return manifest;
}

async function run() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Renderer requires a job manifest path.");
  }

  const { cancelSignal, cancel } = makeCancelSignal();
  readline
    .createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (line.trim().toLowerCase() === "cancel") {
        renderCanceled = true;
        cancel();
      }
    });

  const manifest = await loadManifest(manifestPath);
  emit({ type: "started", jobId: manifest.jobId, stage: "bundling" });

  const serveUrl = await bundle({
    entryPoint: path.resolve(manifest.entryPoint),
  });
  const inputProps = manifest.inputProps;
  const composition = await selectComposition({
    serveUrl,
    id: manifest.compositionId,
    inputProps,
  });

  let lastEmission = 0;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: manifest.output.codec,
    outputLocation: manifest.output.path,
    videoBitrate: manifest.output.videoBitrate,
    concurrency: manifest.runtime?.concurrency ?? 1,
    browserExecutable: manifest.runtime?.browserExecutable,
    ffmpegExecutable: manifest.runtime?.ffmpegExecutable,
    chromeMode: manifest.runtime?.chromeMode,
    timeoutInMilliseconds: manifest.runtime?.timeoutMs,
    cancelSignal,
    overwrite: true,
    logLevel: "error",
    onProgress: (progress) => {
      const now = Date.now();
      if (progress.progress < 1 && now - lastEmission < 250) return;
      lastEmission = now;
      emit({
        type: "progress",
        percent: Math.round(progress.progress * 10_000) / 100,
        renderedFrames: progress.renderedFrames,
        encodedFrames: progress.encodedFrames,
        stage: progress.stitchStage,
      });
    },
  });

  emit({
    type: "completed",
    output: manifest.output.path,
  });
}

run().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown renderer failure";
  emit({
    type: renderCanceled ? "canceled" : "error",
    message: message.slice(0, 4000),
  });
  process.exitCode = 1;
});
