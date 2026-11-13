import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBrowser } from "@remotion/renderer";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const resourcesRoot = path.join(tauriRoot, "resources");
const rendererRoot = path.join(resourcesRoot, "renderer");
const browserRoot = path.join(resourcesRoot, "browser");
const ffmpegRoot = path.join(resourcesRoot, "ffmpeg");
const binariesRoot = path.join(tauriRoot, "binaries");

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function findHeadlessShell() {
  const cacheRoot = path.join(projectRoot, "node_modules/.remotion");
  const candidates = [
    path.join(
      cacheRoot,
      "chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe",
    ),
    path.join(
      cacheRoot,
      "chrome-headless-shell/win64/chrome-headless-shell-win64/headless_shell.exe",
    ),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  await ensureBrowser({ chromeMode: "headless-shell" });
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("Unable to locate a pinned Chrome Headless Shell executable.");
}

async function main() {
  await rm(rendererRoot, { recursive: true, force: true });
  await rm(browserRoot, { recursive: true, force: true });
  await rm(ffmpegRoot, { recursive: true, force: true });
  await mkdir(rendererRoot, { recursive: true });
  await mkdir(browserRoot, { recursive: true });
  await mkdir(ffmpegRoot, { recursive: true });
  await mkdir(binariesRoot, { recursive: true });

  await cp(path.join(projectRoot, "node_modules"), path.join(rendererRoot, "node_modules"), {
    recursive: true,
    dereference: true,
  });
  await cp(path.join(projectRoot, "src"), path.join(rendererRoot, "src"), {
    recursive: true,
  });
  await mkdir(path.join(rendererRoot, "scripts"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "scripts/render-worker.ts"),
    path.join(rendererRoot, "scripts/render-worker.ts"),
  );
  await copyFile(
    path.join(projectRoot, "package.json"),
    path.join(rendererRoot, "package.json"),
  );

  const headlessShell = await findHeadlessShell();
  await copyFile(
    headlessShell,
    path.join(browserRoot, "chrome-headless-shell.exe"),
  );
  const compositorRoot = path.join(
    projectRoot,
    "node_modules/@remotion/compositor-win32-x64-msvc",
  );
  await copyFile(
    path.join(compositorRoot, "ffmpeg.exe"),
    path.join(ffmpegRoot, "ffmpeg.exe"),
  );
  await copyFile(
    path.join(compositorRoot, "ffprobe.exe"),
    path.join(ffmpegRoot, "ffprobe.exe"),
  );

  const nodeTarget = path.join(
    binariesRoot,
    "node-x86_64-pc-windows-msvc.exe",
  );
  await copyFile(process.execPath, nodeTarget);

  const files = [
    nodeTarget,
    path.join(browserRoot, "chrome-headless-shell.exe"),
    path.join(ffmpegRoot, "ffmpeg.exe"),
    path.join(ffmpegRoot, "ffprobe.exe"),
    path.join(rendererRoot, "scripts/render-worker.ts"),
    path.join(rendererRoot, "package.json"),
  ];
  const manifest = {
    schemaVersion: "1.0",
    rendererVersion: "remotion-4.0.543",
    nodeVersion: process.version,
    browserVersion: "chrome-headless-shell-pinned",
    ffmpegVersion: "remotion-compositor-pinned",
    browserExecutable: "browser/chrome-headless-shell.exe",
    ffmpegExecutable: "ffmpeg/ffmpeg.exe",
    ffprobeExecutable: "ffmpeg/ffprobe.exe",
    files: await Promise.all(
      files.map(async (filePath) => ({
        path: path.relative(tauriRoot, filePath).replaceAll("\\", "/"),
        sha256: await sha256(filePath),
      })),
    ),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(resourcesRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Prepared offline renderer runtime at ${resourcesRoot} (${process.version}).`,
  );
}

await main();
