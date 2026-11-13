import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function findEdge() {
  const candidates = [
    process.env.KNOWMOTION_EDGE_BINARY,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("Microsoft Edge was not found. Set KNOWMOTION_EDGE_BINARY.");
  }
  return executable;
}

function edgeVersion(executable) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

export async function ensureMsEdgeDriver() {
  if (process.platform !== "win32") {
    throw new Error("Desktop E2E currently requires Windows and msedgedriver.");
  }
  try {
    execFileSync("msedgedriver.exe", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return "msedgedriver.exe";
  } catch {
    // Download an exact driver matching the installed Edge version.
  }

  const edge = findEdge();
  const version = edgeVersion(edge);
  const destination = path.join(
    projectRoot,
    "node_modules/.cache/knowmotion-e2e/msedgedriver",
    version,
  );
  const executable = path.join(destination, "msedgedriver.exe");
  if (existsSync(executable)) return executable;

  await mkdir(destination, { recursive: true });
  const archive = path.join(destination, "edgedriver.zip");
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  console.log(`Downloading Microsoft Edge Driver ${version}...`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archive),
  );
  execFileSync("tar.exe", ["-xf", archive, "-C", destination], {
    windowsHide: true,
  });
  await rm(archive, { force: true });
  if (!existsSync(executable)) {
    throw new Error(`msedgedriver extraction failed at ${destination}`);
  }
  const size = (await stat(executable)).size;
  if (size === 0) throw new Error("msedgedriver download is empty.");
  return executable;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  console.log(await ensureMsEdgeDriver());
}
