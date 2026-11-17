/**
 * Install the three native local-model runtimes that KnowMotion starts on demand.
 *
 * This mirrors `src-tauri/src/local_runtime.rs`:
 *   - same pinned version and archive names,
 *   - same SHA-256 verification before extraction,
 *   - same `<data>/runtimes/<runtime>/manifest.json` layout,
 *   - no archive is extracted unless its hash matches.
 *
 * It exists so a developer machine can be prepared for the real-service
 * acceptance run without launching the desktop UI.
 *
 * Usage:
 *   node scripts/acceptance/install-local-runtimes.mjs [llama.cpp|audio.cpp|stable-diffusion.cpp ...]
 *
 * Environment:
 *   KNOWMOTION_RUNTIME_ROOT          install root (default %APPDATA%/com.knowmotion.studio/runtimes)
 *   KNOWMOTION_RUNTIME_ACCELERATION  cuda | cuda13 | vulkan (default: detected)
 *   KNOWMOTION_GITHUB_MIRROR         optional prefix, e.g. https://gh-proxy.com/
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIMES = [
  {
    id: "llama.cpp",
    version: "b12359",
    executable: "llama-server.exe",
    cuda: [
      {
        name: "llama-b12359-bin-win-cuda-12.4-x64.zip",
        sha256:
          "e9c0abf442e8339c06728366c1ad2c711332f9939c0c00603fb75d85fd44c914",
      },
      {
        name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
        sha256:
          "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      },
    ],
    cuda13: [
      {
        name: "llama-b12359-bin-win-cuda-13.5-x64.zip",
        sha256:
          "1de9ca1ff408d6e348ea0007c6880ad2393311a02e7799bcde26dc16daef03dd",
      },
      {
        name: "cudart-llama-bin-win-cuda-13.5-x64.zip",
        sha256:
          "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba",
      },
    ],
    vulkan: [
      {
        name: "llama-b12359-bin-win-vulkan-x64.zip",
        sha256:
          "e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e",
      },
    ],
  },
  {
    id: "audio.cpp",
    version: "v0.9.5",
    executable: "audiocpp_server.exe",
    cuda: [
      {
        name: "audio-v0.9.5-bin-windows-x64-cuda12.4.zip",
        sha256:
          "81f38a0a62935bdf4b2605541a21d50223b2e12b661887031705dd8a369f844b",
      },
      {
        name: "audio-v0.9.5-cudart-windows-x64-cuda12.4.zip",
        sha256:
          "fa55dfaff1d4b5c6e8fac460d64f380b9df76cd46435f187c39b05700f623a7e",
      },
    ],
    cuda13: [
      {
        name: "audio-v0.9.5-bin-windows-x64-cuda13.3.zip",
        sha256:
          "9d413d8565ad26e1ae33743e9c884e733f1684169be6f8934e1af9ee2e57a872",
      },
      {
        name: "audio-v0.9.5-cudart-windows-x64-cuda13.3.zip",
        sha256:
          "8614040110cc5852b1dd2192e80344295500f4fa7f3199a51c737c2c7549c3dc",
      },
    ],
    vulkan: [
      {
        name: "audio-v0.9.5-bin-windows-x64-vulkan-portable.zip",
        sha256:
          "6c304c9a1e0cfc18b2d3b208b03d40365fec71d094ee4da4f695b2d9e7de29e8",
      },
    ],
  },
  {
    id: "stable-diffusion.cpp",
    version: "master-1106-532d2c1",
    executable: "sd-server.exe",
    cuda: [
      {
        name: "sd-master-532d2c1-bin-win-cuda12-x64.zip",
        sha256:
          "b087219145a382cc1b1e826318289e1f672b9bb6965977734ef0deb85fe2d03a",
      },
      {
        name: "cudart-sd-bin-win-cu12-x64.zip",
        sha256:
          "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
      },
    ],
    // stable-diffusion.cpp master-1106-532d2c1 没有发布 CUDA 13 归档，
    // Blackwell 上继续使用 Vulkan 包。
    cuda13: [],
    vulkan: [
      {
        name: "sd-master-532d2c1-bin-win-vulkan-x64.zip",
        sha256:
          "3e66222c87ca27074e1fd8ce79706eef17a8aaf39949906aa1bee7e060f22ecc",
      },
    ],
  },
];

const releaseRoot = (runtime) => {
  const tag =
    runtime.id === "llama.cpp"
      ? runtime.version
      : runtime.id === "audio.cpp"
        ? runtime.version
        : "master-1106-532d2c1";
  const repo =
    runtime.id === "llama.cpp"
      ? "ggml-org/llama.cpp"
      : runtime.id === "audio.cpp"
        ? "0xShug0/audio.cpp"
        : "leejet/stable-diffusion.cpp";
  return `https://github.com/${repo}/releases/download/${tag}`;
};

const mirrorPrefix = process.env.KNOWMOTION_GITHUB_MIRROR?.trim() ?? "";
const cacheRoot = path.join(
  process.cwd(),
  "node_modules/.cache/knowmotion-runtimes",
);
const installRoot =
  process.env.KNOWMOTION_RUNTIME_ROOT?.trim() ||
  path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"),
    "com.knowmotion.studio",
    "runtimes",
  );

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}: ${stderr}`)),
    );
  });
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }
  log(`  download ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function findFile(root, name, depth = 8) {
  if (depth === 0) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, name, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

// CUDA 12.4 归档最高只编到 compute capability 9.x；CUDA 13 归档最低要求
// Turing（7.5）与 R620 驱动分支（13.5 的新特性要求 R620，13.x 的 minor
// version compatibility 最低是 R580，这里取两者更严的 R620）。
const CUDA12_MAX_COMPUTE = 10;
const CUDA13_MIN_DRIVER = 620;
const CUDA13_MIN_COMPUTE = 7.5;

function cuda12Supports(driverMajor, computeCap) {
  return driverMajor >= 551 && computeCap >= 5 && computeCap < CUDA12_MAX_COMPUTE;
}

function cuda13Supports(driverMajor, computeCap) {
  return driverMajor >= CUDA13_MIN_DRIVER && computeCap >= CUDA13_MIN_COMPUTE;
}

function selectAcceleration(hasCuda13, gpus) {
  if (gpus.some(([driver, compute]) => cuda12Supports(driver, compute))) {
    return "cuda";
  }
  if (
    hasCuda13 &&
    gpus.some(([driver, compute]) => cuda13Supports(driver, compute))
  ) {
    return "cuda13";
  }
  return "vulkan";
}

async function detectGpus() {
  const override = process.env.KNOWMOTION_RUNTIME_ACCELERATION?.trim();
  if (override) {
    if (!["cuda", "cuda13", "vulkan"].includes(override)) {
      throw new Error(
        `KNOWMOTION_RUNTIME_ACCELERATION must be cuda, cuda13 or vulkan (got ${override})`,
      );
    }
    return { override };
  }
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "nvidia-smi",
        ["--query-gpu=driver_version,compute_cap", "--format=csv,noheader"],
        { windowsHide: true },
      );
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(text) : reject(new Error(`exit ${code}`)),
      );
    });
    const gpus = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [driver, compute] = line.split(",").map((value) => value.trim());
        return [
          Number.parseInt((driver ?? "0").split(".")[0], 10),
          Number.parseFloat(compute ?? "0"),
        ];
      })
      .filter(([driver, compute]) => Number.isFinite(driver) && Number.isFinite(compute));
    return { gpus };
  } catch {
    return { gpus: [] };
  }
}

function accelerationFor(runtime, detected) {
  if (detected.override) return detected.override;
  return selectAcceleration(runtime.cuda13.length > 0, detected.gpus ?? []);
}

async function install(runtime, acceleration) {
  const archives = runtime[acceleration];
  if (!archives || archives.length === 0) {
    throw new Error(
      `${runtime.id} has no ${acceleration} archive; use another acceleration`,
    );
  }
  const target = path.join(installRoot, runtime.id);
  const manifestPath = path.join(target, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const executable = path.join(target, manifest.executable);
    if (
      manifest.version === runtime.version &&
      manifest.acceleration === acceleration &&
      existsSync(executable)
    ) {
      log(`${runtime.id}: already installed (${manifest.acceleration})`);
      return;
    }
    log(`${runtime.id}: reinstalling (${manifest.acceleration} -> ${acceleration})`);
  }

  await mkdir(cacheRoot, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  const staging = await mkdtemp(path.join(installRoot, `.${runtime.id}-`));

  for (const archive of archives) {
    const archivePath = path.join(cacheRoot, archive.name);
    await download(`${mirrorPrefix}${releaseRoot(runtime)}/${archive.name}`, archivePath);
    const actual = await sha256(archivePath);
    if (actual !== archive.sha256) {
      throw new Error(
        `Checksum mismatch for ${archive.name}: expected ${archive.sha256}, got ${actual}`,
      );
    }
    log(`  verify ${archive.name} ok`);
    // Use the Windows bsdtar explicitly: the MSYS/Git-Bash `tar` treats
    // "D:/..." as a remote host and fails with "Cannot connect to D:".
    const tar = path.join(process.env.SystemRoot ?? "C:////Windows", "System32", "tar.exe");
    await run(existsSync(tar) ? tar : "tar.exe", ["-xf", archivePath, "-C", staging]);
  }

  const executable = await findFile(staging, runtime.executable);
  if (!executable) {
    throw new Error(`${runtime.id}: archive did not contain ${runtime.executable}`);
  }
  const relative = path.relative(staging, executable);
  const manifest = {
    runtime: runtime.id,
    version: runtime.version,
    acceleration,
    archives: archives.map((archive) => archive.sha256),
    executable: relative.replaceAll("\\", "/"),
    installedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (existsSync(target)) {
    const retired = `${target}.retired-${Date.now()}`;
    await rename(target, retired);
    log(`  previous install moved to ${path.basename(retired)}`);
  }
  await rename(staging, target);
  log(
    `${runtime.id}: installed ${runtime.version} (${acceleration}) -> ${path.join(target, relative)}`,
  );
}

const requested = process.argv.slice(2);
const selected =
  requested.length > 0
    ? RUNTIMES.filter((runtime) => requested.includes(runtime.id))
    : RUNTIMES;
if (selected.length === 0) {
  throw new Error(
    `Unknown runtime. Choose one of: ${RUNTIMES.map((runtime) => runtime.id).join(", ")}`,
  );
}

log(`install root: ${installRoot}`);
const detected = await detectGpus();
if (detected.override) {
  log(`  acceleration: ${detected.override} (KNOWMOTION_RUNTIME_ACCELERATION)`);
} else if (detected.gpus.length === 0) {
  log("  acceleration: vulkan (nvidia-smi unavailable)");
} else {
  log(
    `  gpus: ${detected.gpus
      .map(([driver, compute]) => `driver ${driver} / compute ${compute}`)
      .join(", ")}`,
  );
}
for (const runtime of selected) {
  const acceleration = accelerationFor(runtime, detected);
  log(`  ${runtime.id}: ${acceleration}`);
  await install(runtime, acceleration);
}

const summary = [];
for (const runtime of RUNTIMES) {
  const manifestPath = path.join(installRoot, runtime.id, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  summary.push({
    runtime: runtime.id,
    version: manifest.version,
    acceleration: manifest.acceleration,
    executable: path.join(installRoot, runtime.id, manifest.executable),
  });
}
log(JSON.stringify(summary, null, 2));
