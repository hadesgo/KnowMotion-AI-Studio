# 自动化测试

## 测试层级

| 层级 | 工具 | 覆盖范围 |
|---|---|---|
| 前端逻辑 | Node test + tsx | Composition/Scene DSL 校验、Canvas 与 GSAP 确定性 |
| 组件 | Vitest + Testing Library + jsdom | 受控控件、Modal 键盘与焦点、进度可访问性、新建项目流程 |
| Rust | cargo test | 存储、迁移、Agent、Provider、Canvas/GSAP 归一化、日志脱敏、轮转、Job Object 进程树 |
| 真实服务验收 | cargo test --ignored + 本地模型 | LLM / Embedding / TTS / ASR / Image 五项真实运行时端到端 |
| 桌面 E2E | tauri-driver + WebDriverIO + msedgedriver | 真实 Tauri release 应用、页面导航、Canvas 操作与重启持久化 |

## 组件测试

```bash
npm run test:components
```

测试 DOM 环境在 `tests/components/setup.ts` 中提供 Testing Library cleanup、matchMedia、ResizeObserver 和 Canvas 2D mock。组件测试不连接真实 Provider，也不写用户项目目录。

## 真实本地服务验收

```bash
npm run acceptance:runtimes   # 首次准备：按固定版本与 SHA-256 安装三个运行时
npm run acceptance:services   # 用本机真实模型跑五项能力验收
npm run acceptance:inpaint    # 局部重绘两条通道（stable-diffusion.cpp 真实服务）
npm run acceptance:workflow   # 九 Agent Research → Quality 全流程
```

用例都在 `src-tauri/src/acceptance.rs`，带 `#[ignore]`，因此普通 `cargo test` 不会触发。它们需要本机已下载模型、已安装运行时和一块能跑 Vulkan 的 GPU，不进 CI。产物与 JSON 报告写入 `src-tauri/target/acceptance/`：

- `real_service_acceptance`：LLM / Embedding / TTS / ASR / Image 五项能力，可用 `KNOWMOTION_ACCEPTANCE_ONLY=LLM,TTS` 只跑部分。
- `real_inpaint_acceptance`：真实源图 + 遮罩走 `execute_inpaint`，按“遮罩内像素变化显著、遮罩外基本不变”判定方向；云端 OpenAI 通道需要 `KNOWMOTION_ACCEPTANCE_OPENAI_KEY`（缺失时标记为 skipped，不计失败）。
- `real_workflow_acceptance`：从空的验收项目启动完整九 Agent DAG，自动通过三个审批节点，最后校验步骤全绿、`provider_calls ≥ 9`、场景/字幕/质量报告齐全。

判定标准、实测数据与限制见 `docs/REAL_SERVICE_ACCEPTANCE.md`。

## 遮罩像素测试

`tests/mask-canvas.test.ts` 不 mock canvas：用 Skia 实现（`@napi-rs/canvas`）当作浏览器 canvas，走真实绘制路径，再把产出的 PNG 解码回来逐像素断言：

- alpha 遮罩：涂抹处 `alpha = 0`、其余 `alpha = 255`，且没有半透明残留（OpenAI Images edits 约定）；
- 亮度遮罩：涂抹处纯白、其余纯黑（stable-diffusion.cpp 原生 `img_gen` 约定）；
- 光栅化面积与解析覆盖率 `maskCoverage` 的误差 < 0.02。


## 桌面 E2E

```bash
npm run test:e2e:desktop:full
```

完整命令执行：

1. 构建前端、离线渲染运行目录和 Tauri release EXE。
2. 读取本机 Edge `ProductVersion`。
3. 使用匹配版本的 `msedgedriver`，缓存于 `node_modules/.cache`。
4. 启动 `tauri-driver`。
5. 在临时 `KNOWMOTION_E2E_DATA_DIR` 中运行测试。
6. 删除 WebDriver 会话并重新启动应用，验证 SQLite 项目恢复。

已有最新 release EXE 时，可直接运行：

```bash
npm run test:e2e:desktop
```

自定义路径：

```powershell
$env:KNOWMOTION_E2E_APP_EXE = "D:\builds\knowmotion-ai-studio.exe"
$env:KNOWMOTION_TAURI_DRIVER = "C:\Users\me\.cargo\bin\tauri-driver.exe"
$env:KNOWMOTION_EDGE_BINARY = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run test:e2e:desktop
```

失败时 `e2e-artifacts/desktop-e2e-failure.png` 和 `.html` 会保留页面现场；每次运行会先清理上次诊断文件。

## CI

`.github/workflows/test.yml` 在 Windows runner 上安装 Node 24、Rust、npm 依赖和 `tauri-driver`，随后依次运行 Rust 测试、前端与组件测试、Lint 和完整桌面 E2E。失败时上传 E2E 截图和 DOM。

## Windows 干净 VM smoke

`windows-clean-vm-smoke` job 在全新的 `windows-latest` VM 中构建 NSIS，然后执行：

```powershell
.\scripts\windows-vm\run-install-smoke.ps1 `
  -InstallerPath <NSIS路径> `
  -ResultPath .\e2e-artifacts\windows-clean-vm-result.json `
  -EnforceOffline
```

验证阶段：

1. 确认机器没有既有 KnowMotion 安装。
2. 静默安装并校验 20 个 runtime 文件哈希。
3. 为 Node、Chrome、FFmpeg、FFprobe 和应用进程添加外网络阻断规则。
4. 使用安装目录内运行时渲染 1.5 秒视频，FFprobe 校验 H.264 视频流与时长。
5. 启动应用并检查结构化日志初始化标记。
6. 静默卸载并检查关键运行文件消失。
7. 在 finally 中移除防火墙规则、停止残留进程并写入 JSON 证据。

本机启用 Windows Sandbox 后，可使用自动拉起脚本：

```powershell
npm run test:smoke:windows:sandbox
```

Sandbox 配置禁用网络，并将安装包、smoke 脚本与结果目录映射到一次性桌面环境。没有 Sandbox 时脚本会明确失败，不会退化成非干净测试。
