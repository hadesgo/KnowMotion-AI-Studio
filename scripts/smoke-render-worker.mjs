import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSampleProject } from "../src/data/demo.ts";
import {
  buildProjectComposition,
  buildSceneComposition,
} from "../src/remotion/schema.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const rendererRoot = path.join(projectRoot, "src-tauri/resources/renderer");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "knowmotion-render-"));

try {
  const full = buildProjectComposition(makeSampleProject());
  const canvasScene = {
    ...full.scenes[0],
    layers: [
      ...full.scenes[0].layers,
      {
        type: "canvas",
        id: "canvas-smoke",
        timing: { fromMs: 0, toMs: full.scenes[0].durationMs },
        animation: {
          type: "fade",
          delayMs: 0,
          durationMs: 300,
          easing: "easeOut",
        },
        opacity: 0.9,
        x: 54,
        y: 8,
        width: 40,
        height: 46,
        rotation: 0,
        variant: "network",
        color: "#c8ff65",
        secondaryColor: "#79a9ff",
        density: 44,
        speed: 1,
        lineWidth: 1.4,
        intensity: 0.9,
        seed: 41,
        borderRadius: 0,
      },
    ],
  };
  const composition = buildSceneComposition(
    canvasScene,
    full.width,
    full.height,
    full.fps,
    full.assets,
  );
  const output = path.join(temporaryRoot, "smoke.partial.mp4");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "1.0",
      jobId: "smoke-job",
      entryPoint: path.join(rendererRoot, "src/remotion/index.ts"),
      compositionId: "KnowledgeVideo",
      inputProps: { composition },
      output: { path: output, codec: "h264", videoBitrate: "2M" },
      runtime: {
        browserExecutable: path.join(
          projectRoot,
          "src-tauri/resources/browser/chrome-headless-shell.exe",
        ),
        ffmpegExecutable: path.join(
          projectRoot,
          "src-tauri/resources/ffmpeg/ffmpeg.exe",
        ),
        chromeMode: "headless-shell",
        concurrency: 1,
        timeoutMs: 120_000,
      },
    }),
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [
      path.join(rendererRoot, "node_modules/tsx/dist/cli.mjs"),
      path.join(rendererRoot, "scripts/render-worker.ts"),
      manifestPath,
    ],
    {
      cwd: rendererRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => {
    child.on("exit", resolve);
  });
  if (exitCode !== 0 || !stdout.includes('"type":"completed"')) {
    throw new Error(
      `Renderer smoke test failed (${exitCode}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  const bytes = await readFile(output);
  if (bytes.length === 0) {
    throw new Error("Renderer smoke test produced an empty file.");
  }
  if (process.env.KNOWMOTION_SMOKE_OUTPUT) {
    await copyFile(output, path.resolve(process.env.KNOWMOTION_SMOKE_OUTPUT));
  }
  console.log(`Renderer worker smoke test passed (${bytes.length} bytes).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
