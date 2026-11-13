import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

async function main() {
  if (!existsSync(appBinary)) {
    throw new Error(
      `Desktop E2E app is missing at ${appBinary}. Run npm run build and cargo build --release first.`,
    );
  }
  const edgeDriver = await ensureMsEdgeDriver();
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
    await browser.$('input[aria-label="视频知识主题"]').setValue(uniqueTopic);
    await browser.$("button=开始策划").click();
    await waitForText(browser, "h1", "开始一支新的知识动画");

    const titleInput = browser.$('input[placeholder="给这支视频一个工作标题"]');
    await titleInput.setValue(projectTitle);
    await browser.$("button=创建并进入策划").click();
    await waitForText(browser, "h1", "把主题变成一个值得看完的故事");
    assert.match(await browser.getUrl(), /\/projects\/[^/]+\/plan/);

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
    await browser.$('a[href$="/remotion"]').click();
    await waitForText(browser, "h1", "结构化场景，进入真实视频时间轴");

    await browser.deleteSession();
    browser = undefined;

    browser = await launchSession(port);
    await waitForText(browser, "h1", "今天想把什么讲清楚？");
    await waitForText(browser, "body", projectTitle);
    console.log(`Desktop E2E passed: ${projectTitle}`);
  } catch (error) {
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
    await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
