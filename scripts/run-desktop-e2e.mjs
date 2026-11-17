import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";
import { ensureMsEdgeDriver } from "./ensure-msedgedriver.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const tauriDriver =
  process.env.KNOWMOTION_TAURI_DRIVER ??
  path.join(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
const appBinary = path.resolve(
  process.env.KNOWMOTION_E2E_APP_EXE ??
    path.join(projectRoot, "src-tauri/target/release/knowmotion-ai-studio.exe"),
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForDriver(port, driverProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (driverProcess.exitCode !== null) {
      throw new Error(`tauri-driver exited with code ${driverProcess.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return;
    } catch {
      // Driver is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for tauri-driver.");
}

async function launchSession(port) {
  return remote({
    logLevel: "error",
    hostname: "127.0.0.1",
    port,
    path: "/",
    automationProtocol: "webdriver",
    connectionRetryCount: 1,
    capabilities: {
      browserName: "wry",
      "tauri:options": {
        application: appBinary,
        args: [],
      },
    },
  });
}

async function waitForText(browser, selector, text) {
  await browser.waitUntil(
    async () => (await browser.$(selector).getText()).includes(text),
    {
      timeout: 20_000,
      timeoutMsg: `Timed out waiting for ${selector} to contain ${text}`,
    },
  );
}

function agentOutput(agent) {
  const scene = {
    id: "scene-e2e",
    title: "可复核的知识主线",
    narration:
      "这是一段用于桌面端到端验收的真实中文旁白，覆盖审批、媒体生成、取消与重启恢复。",
    description: "验证完整工作流、人工审批和持久化恢复。",
    visualPrompt: "深色编辑设计，知识网络与高亮文字，真实桌面验收",
    shotType: "Explainer",
    transition: "柔光淡入",
    duration: 180,
    accent: "#c8ff65",
    motionPreset: "pushIn",
    visualMode: "programmatic",
    layers: [
      {
        id: "layer-e2e-title",
        type: "text",
        name: "验收标题",
        content: "平台完整性验收",
        x: 8,
        y: 18,
        width: 78,
        height: 20,
        opacity: 1,
        start: 0,
        end: 180,
        color: "#f3f7f4",
        fontSize: 54,
      },
      {
        id: "layer-e2e-canvas",
        type: "canvas",
        name: "知识网络",
        content: "",
        x: 48,
        y: 35,
        width: 46,
        height: 54,
        opacity: 0.9,
        start: 0,
        end: 180,
        color: "#79a9ff",
        secondaryColor: "#c8ff65",
        canvasVariant: "network",
        density: 64,
        speed: 1,
        lineWidth: 1.8,
        intensity: 0.85,
        seed: 41,
      },
    ],
  };
  switch (agent) {
    case "director":
      return {
        summary: "E2E 大纲已生成",
        changes: [
          {
            tool: "replaceOutline",
            input: {
              sections: [
                {
                  id: "outline-e2e",
                  eyebrow: "01 · VERIFY",
                  title: "平台完整性",
                  body: "审批、媒体、恢复与发布产物",
                  seconds: 180,
                },
              ],
            },
          },
        ],
      };
    case "script":
    case "storyboard":
      return {
        summary: "E2E 分镜已生成",
        changes: [{ tool: "replaceScenes", input: { scenes: [scene] } }],
      };
    case "asset":
      return {
        summary: "E2E 本地素材草案已生成",
        changes: [
          {
            tool: "generateSceneAssets",
            input: {
              briefs: [
                {
                  sceneId: "scene-e2e",
                  title: "平台完整性",
                  prompt: "深色编辑设计中的知识网络",
                  style: "Editorial science",
                  kind: "illustration",
                },
              ],
            },
          },
        ],
      };
    case "animation":
      return {
        summary: "E2E 动画图层已应用",
        changes: [{ tool: "patchScenes", input: { scenes: [scene] } }],
      };
    case "audio":
      return {
        summary: "E2E 字幕与时间轴已生成",
        changes: [
          {
            tool: "replaceSubtitles",
            input: {
              cues: [
                {
                  id: "subtitle-e2e",
                  sceneId: "scene-e2e",
                  start: 0,
                  end: 12,
                  text: "平台完整性验收",
                },
              ],
            },
          },
          {
            tool: "replaceTimeline",
            input: {
              clips: [
                {
                  id: "clip-e2e",
                  track: "video",
                  sceneId: "scene-e2e",
                  label: "平台完整性",
                  start: 0,
                  duration: 180,
                  color: "#79a9ff",
                },
              ],
            },
          },
        ],
      };
    case "quality":
      return {
        summary: "E2E 质量检查通过",
        changes: [
          {
            tool: "setQualityReport",
            input: {
              report: {
                score: 100,
                status: "pass",
                findings: [],
                summary: "自动化验收通过",
              },
            },
          },
        ],
      };
    default:
      return { summary: "E2E 研究与规划输入已核对", changes: [] };
  }
}

async function startMockServices() {
  const runtimeArchive = storedZip([
    {
      name: "llama-server.exe",
      data: Buffer.from("KnowMotion E2E runtime fixture\n"),
    },
  ]);
  const runtimeSha256 = sha256(runtimeArchive);
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/runtime/")) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": runtimeArchive.length,
      });
      response.end(runtimeArchive);
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const system = payload.messages?.find(
          (message) => message.role === "system",
        )?.content;
        const agent =
          String(system).match(/Agent:\s*[^\n]+\(([a-z_]+)\)/)?.[1] ??
          "research";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: payload.model ?? "e2e-local",
            message: {
              role: "assistant",
              content: JSON.stringify(agentOutput(agent)),
            },
            prompt_eval_count: 100,
            eval_count: 100,
            done: true,
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "E2E route not found" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(11434, "127.0.0.1", resolve);
  });
  return { server, runtimeSha256 };
}

async function invokeTauri(browser, command, args = {}) {
  const result = await browser.executeAsync(
    (commandName, commandArgs, done) => {
      globalThis.window.__TAURI_INTERNALS__.invoke(commandName, commandArgs).then(
        (value) => done({ value }),
        (error) => done({ error: String(error) }),
      );
    },
    command,
    args,
  );
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function approveAllWorkflowGates(browser) {
  for (const label of ["大纲审批", "分镜审批", "最终内容审批"]) {
    await waitForText(browser, ".approval-panel", label);
    await browser.$("button=批准并继续").click();
  }
  await browser.waitUntil(
    async () => {
      const label = await browser
        .$('svg[aria-label^="已完成"]')
        .getAttribute("aria-label");
      return label === "已完成 9/9";
    },
    { timeout: 90_000, timeoutMsg: "Workflow did not reach 9/9 completed steps" },
  );
}

async function main() {
  if (!existsSync(appBinary)) {
    throw new Error(
      `Desktop E2E app is missing at ${appBinary}. Run npm run build and cargo build --release first.`,
    );
  }
  const edgeDriver = await ensureMsEdgeDriver();
  const mockServices = await startMockServices();
  const port = await freePort();
  const nativePort = await freePort();
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "knowmotion-e2e-"));
  const artifactDirectory = path.join(projectRoot, "e2e-artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    rm(path.join(artifactDirectory, "desktop-e2e-failure.png"), { force: true }),
    rm(path.join(artifactDirectory, "desktop-e2e-failure.html"), { force: true }),
    rm(path.join(artifactDirectory, "desktop-e2e-driver.log"), { force: true }),
  ]);
  let browser;
  let driver;
  let driverLogs = "";
  let exportedDiagnostics = "";

  try {
    driver = spawn(
      tauriDriver,
      [
        "--port",
        String(port),
        "--native-port",
        String(nativePort),
        "--native-driver",
        edgeDriver,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          TAURI_WEBVIEW_AUTOMATION: "true",
          KNOWMOTION_E2E_DATA_DIR: dataDirectory,
          KNOWMOTION_E2E_RUNTIME_BASE_URL: "http://127.0.0.1:11434/runtime",
          KNOWMOTION_E2E_RUNTIME_SHA256: mockServices.runtimeSha256,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    driver.stdout.setEncoding("utf8").on("data", (chunk) => {
      driverLogs += chunk;
    });
    driver.stderr.setEncoding("utf8").on("data", (chunk) => {
      driverLogs += chunk;
    });
    await waitForDriver(port, driver);

    const uniqueTopic = `桌面自动化知识 ${Date.now()}`;
    const projectTitle = `${uniqueTopic}：E2E`;

    browser = await launchSession(port);
    await waitForText(browser, "h1", "今天想把什么讲清楚？");
    const installed = await invokeTauri(browser, "ensure_local_runtime", {
      runtime: "llama.cpp",
    });
    assert.equal(installed.alreadyInstalled, false);
    await writeFile(installed.executablePath, "corrupted runtime fixture", "utf8");
    const repaired = await invokeTauri(browser, "ensure_local_runtime", {
      runtime: "llama.cpp",
    });
    assert.equal(repaired.repairPerformed, true);
    assert.equal(
      (await readFile(repaired.executablePath, "utf8")).trim(),
      "KnowMotion E2E runtime fixture",
    );

    await browser.$('input[aria-label="视频知识主题"]').setValue(uniqueTopic);
    await browser.$("button=开始策划").click();
    await waitForText(browser, "h1", "开始一支新的知识动画");

    const titleInput = browser.$('input[placeholder="给这支视频一个工作标题"]');
    await titleInput.setValue(projectTitle);
    await browser.$("button=创建并进入策划").click();
    await waitForText(browser, "h1", "把主题变成一个值得看完的故事");
    assert.match(await browser.getUrl(), /\/projects\/[^/]+\/plan/);
    const projectId = (await browser.getUrl()).match(/\/projects\/([^/]+)\//)?.[1];
    assert.ok(projectId, "project id was not present in the route");

    await browser.$('a[href$="/workflow"]').click();
    await waitForText(
      browser,
      "h1",
      "让 AI 接管创作流程，但把决定权留在你手里",
    );
    await browser.$("button=运行完整工作流").click();
    await approveAllWorkflowGates(browser);

    await browser.$('a[href$="/animation"]').click();
    await waitForText(browser, "h1", "让每个信息在正确的时刻出现");
    await browser.$('button[aria-label="添加 Canvas 动画图层"]').click();
    await browser.waitUntil(
      async () => (await browser.getPageSource()).includes("Canvas 粒子流"),
      {
        timeout: 20_000,
        timeoutMsg: "Canvas layer was not added to the animation editor",
      },
    );
    await browser.$('a[href$="/audio"]').click();
    await waitForText(browser, "h1", "让声音和文字跟着画面呼吸");
    await browser.$("button=生成全部旁白").click();
    await waitForText(browser, "body", "本地旁白 WAV 已生成");
    await browser.$("button=生成背景音乐").click();
    await waitForText(browser, "body", "背景音乐已生成");
    const audioFiles = await readdir(
      path.join(dataDirectory, "projects", projectId, "assets/audio"),
    );
    assert.ok(
      audioFiles.some((name) => name.endsWith(".wav")),
      "real WAV assets were not written to the project",
    );

    await browser.$('a[href$="/remotion"]').click();
    await waitForText(browser, "h1", "结构化场景，进入真实视频时间轴");
    const renderButton = browser.$("button=渲染完整 MP4");
    await browser.waitUntil(async () => renderButton.isEnabled(), {
      timeout: 30_000,
      timeoutMsg: "Render button never became enabled",
    });
    await renderButton.click();
    const cancelButton = browser.$("button=取消渲染");
    await browser.waitUntil(async () => cancelButton.isEnabled(), {
      timeout: 30_000,
      timeoutMsg: "Persistent render job did not start",
    });
    await cancelButton.click();
    await waitForText(browser, "body", "MP4 渲染已取消");

    exportedDiagnostics = await invokeTauri(browser, "export_diagnostics");
    assert.ok(
      (await readFile(exportedDiagnostics)).length > 100,
      "remote diagnostics bundle is empty",
    );

    await browser.deleteSession();
    browser = undefined;

    browser = await launchSession(port);
    await waitForText(browser, "h1", "今天想把什么讲清楚？");
    await waitForText(browser, "body", projectTitle);
    await writeFile(
      path.join(artifactDirectory, "desktop-e2e-result.json"),
      JSON.stringify(
        {
          ok: true,
          projectId,
          scenarios: {
            workflowApprovals: 3,
            runtimeFailureRecovery: true,
            realNarrationAndMusic: true,
            renderCanceled: true,
            restartRecovery: true,
          },
          diagnosticsBundle: path.basename(exportedDiagnostics),
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`Desktop E2E passed: ${projectTitle}`);
  } catch (error) {
    await cp(dataDirectory, path.join(artifactDirectory, "desktop-e2e-data"), {
      recursive: true,
      force: true,
    }).catch(() => {});
    if (browser) {
      try {
        await browser.saveScreenshot(
          path.join(artifactDirectory, "desktop-e2e-failure.png"),
        );
        const pageSource = await browser.getPageSource();
        await rm(path.join(artifactDirectory, "desktop-e2e-failure.html"), {
          force: true,
        });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          path.join(artifactDirectory, "desktop-e2e-failure.html"),
          pageSource,
          "utf8",
        );
      } catch {
        // Preserve the original test failure.
      }
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(artifactDirectory, "desktop-e2e-driver.log"),
      driverLogs,
      "utf8",
    ).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.deleteSession().catch(() => {});
    if (driver) {
      driver.kill();
      await new Promise((resolve) => {
        driver.once("exit", resolve);
        setTimeout(resolve, 2_000);
      });
    }
    if (exportedDiagnostics) {
      await rm(exportedDiagnostics, { force: true }).catch(() => {});
    }
    await new Promise((resolve) => mockServices.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
