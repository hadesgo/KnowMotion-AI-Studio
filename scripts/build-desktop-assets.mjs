import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

async function run(args) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`${path.basename(args[0])} exited with code ${code}`);
  }
}

await run([path.join(projectRoot, "node_modules/typescript/bin/tsc"), "-b"]);
await run([path.join(projectRoot, "node_modules/vite/bin/vite.js"), "build"]);
await run([path.join(projectRoot, "scripts/prepare-render-runtime.mjs")]);
