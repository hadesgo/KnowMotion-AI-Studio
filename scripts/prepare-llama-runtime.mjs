import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LLAMA_VERSION = process.env.KNOWMOTION_LLAMA_VERSION ?? "b12359";
const RELEASE_PACKAGE = `llama-${LLAMA_VERSION}-bin-win-vulkan-x64.zip`;
const DOWNLOAD_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${RELEASE_PACKAGE}`;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const resourcesRoot = path.join(tauriRoot, "resources");
const llamaRoot = path.join(resourcesRoot, "llama");
const cacheRoot = path.join(projectRoot, "node_modules/.cache/llama.cpp");
const archivePath = path.join(cacheRoot, RELEASE_PACKAGE);
const manifestPath = path.join(llamaRoot, "runtime-manifest.json");

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function run(command, args) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `${path.basename(command)} exited with code ${exitCode}`,
    );
  }
}

async function alreadyPrepared() {
  if (
    !(await fileExists(path.join(llamaRoot, "llama-server.exe"))) ||
    !(await fileExists(manifestPath))
  ) {
    return false;
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return (
      manifest.version === LLAMA_VERSION &&
      manifest.package === RELEASE_PACKAGE
    );
  } catch {
    return false;
  }
}

async function downloadArchive() {
  if (await fileExists(archivePath)) {
    return;
  }
  await mkdir(cacheRoot, { recursive: true });
  const partialPath = `${archivePath}.part`;
  console.log(`Downloading llama.cpp ${LLAMA_VERSION} from ${DOWNLOAD_URL}`);
  const response = await fetch(DOWNLOAD_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
    headers: { "User-Agent": "KnowMotion-AI-Studio" },
  });
  if (!response.ok) {
    throw new Error(
      `Unable to download llama.cpp runtime: ${response.status} ${response.statusText}`,
    );
  }
  await writeFile(partialPath, Buffer.from(await response.arrayBuffer()));
  await rename(partialPath, archivePath);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      "The pinned llama.cpp runtime currently supports Windows x64 only.",
    );
  }
  if (await alreadyPrepared()) {
    console.log(`llama.cpp ${LLAMA_VERSION} runtime is already prepared.`);
    return;
  }
  await downloadArchive();
  const extractionRoot = path.join(
    cacheRoot,
    `extracted-${LLAMA_VERSION}`,
  );
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  await run("tar.exe", ["-xf", archivePath, "-C", extractionRoot]);
  if (!(await fileExists(path.join(extractionRoot, "llama-server.exe")))) {
    throw new Error("The llama.cpp archive does not contain llama-server.exe.");
  }

  await rm(llamaRoot, { recursive: true, force: true });
  await mkdir(llamaRoot, { recursive: true });
  await cp(extractionRoot, llamaRoot, { recursive: true });
  const manifest = {
    schemaVersion: "1.0",
    version: LLAMA_VERSION,
    package: RELEASE_PACKAGE,
    source: DOWNLOAD_URL,
    archiveSha256: await sha256(archivePath),
    acceleratedBackend: "vulkan",
    cpuFallback: true,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`Prepared llama.cpp ${LLAMA_VERSION} at ${llamaRoot}.`);
}

await main();
