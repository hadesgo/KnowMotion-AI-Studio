import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const executable = process.env.KNOWMOTION_LLAMA_SERVER ??
  path.join(projectRoot, "src-tauri/resources/llama/llama-server.exe");
const modelPath = process.env.KNOWMOTION_GGUF_TEST_MODEL;

if (!modelPath) {
  throw new Error(
    "Set KNOWMOTION_GGUF_TEST_MODEL to an existing .gguf model before running this smoke test.",
  );
}

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const child = spawn(
  executable,
  [
    "--model",
    modelPath,
    "--alias",
    "knowmotion-smoke",
    "--ctx-size",
    "512",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--n-gpu-layers",
    "0",
    "--device",
    "none",
    "--jinja",
    "--no-webui",
  ],
  {
    cwd: path.dirname(executable),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let logs = "";
child.stdout.on("data", (chunk) => {
  logs = (logs + chunk.toString()).slice(-16_384);
});
child.stderr.on("data", (chunk) => {
  logs = (logs + chunk.toString()).slice(-16_384);
});

const deadline = Date.now() + 300_000;
let ready = false;
try {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited with ${child.exitCode}:\n${logs}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (child.exitCode !== null) {
    throw new Error(`llama-server exited with ${child.exitCode}:\n${logs}`);
  }
  if (!ready) {
    throw new Error(`llama-server did not become ready:\n${logs}`);
  }
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "knowmotion-smoke",
        messages: [
          { role: "system", content: "Answer concisely." },
          { role: "user", content: "Reply with hello." },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`llama-server returned ${response.status}: ${body}`);
  }
  const parsed = JSON.parse(body);
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`llama-server returned no content: ${body}`);
  }
  const manifest = JSON.parse(
    await readFile(
      path.join(projectRoot, "src-tauri/resources/llama/runtime-manifest.json"),
      "utf8",
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      llamaCpp: manifest.version,
      output: content,
      usage: parsed.usage ?? null,
    }),
  );
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}
