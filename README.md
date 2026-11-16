# KnowMotion AI Studio

AI-powered knowledge animation studio. 用户从一个知识主题开始，在同一项目上下文中完成内容策划、脚本、分镜、素材、动画、音频字幕和视频预览。

## 当前实现

- Tauri 2 + React 19 + TypeScript + Vite 桌面架构。
- Tailwind CSS v4 负责工具类与设计 Token，桌面界面组件层保留在工作站样式文件中。
- Rust 后端通过 SQLite 保存项目、Provider 元数据和持久化状态。
- 每个项目同步生成独立的 `project.json`、脚本、分镜、素材清单、动画时间轴和字幕目录。
- 16 个工作区界面：Dashboard、新建项目、Agent 工作流、内容策划、脚本、分镜、图片素材、设定集、视频素材、动画、Remotion Studio、时间轴、AI 助手、音频字幕、渲染、模型配置。
- 设定集：角色、场景与全局风格锚点，参考图库与权重，稳定指纹/种子，逐镜头一致性报告与素材过期检测。
- 图片生成支持负向提示词、固定种子和参考图：stable-diffusion.cpp 提供本地生成入口，OpenAI 通道以文字锚点传递参考。
- 持久批量图片队列：按镜头批量入队、最多 2 个并发、实时状态、取消/重试、重启恢复，完成素材自动回填素材库。
- 图片局部重绘：画布遮罩画笔，stable-diffusion.cpp 与 OpenAI `images/edits` 双通道，结果另存为新素材。
- 视频素材与图层：导入 MP4/WebM 等容器，剪出入点/速度/音量后插入镜头；Remotion 用 `OffthreadVideo` 参与 Player 预览与最终渲染。
- 九个持久化 AI Agent 与 DAG Workflow：模型路由、审批、暂停恢复、局部重跑、受控项目工具、修订和撤销。
- 原生 GGUF 本地推理：可直接选择 `.gguf` 模型文件，由 llama.cpp 加载，支持 CPU 与 Vulkan GPU 加速。
- 统一本地模型调度：llama.cpp、audio.cpp 与 stable-diffusion.cpp 共享单一 GPU 租约，按需启动、保留 768–1024 MiB 显存余量，并按空闲阈值卸载模型。
- Remotion Scene/Composition DSL、可复用动画组件、实时 Player 和完整 H.264 渲染。
- 确定性 Canvas 2D 动画图层：粒子流、动态波形、知识网络和轨道拖尾。
- 帧驱动 GSAP 运动：漂浮、呼吸、摆动、环绕和弹性入场，Player 与 Renderer 结果一致。
- 持久渲染 Job、真实 `render.progress`、取消、恢复、FFprobe、SHA-256 与原子提交。
- Windows Job Object 监管 Node/Chrome/FFmpeg 进程树，取消、崩溃或应用退出时不残留渲染子进程。
- 结构化 JSONL 日志、5 MiB 轮转、7 份历史、30 天保留和统一 API Key/Authorization 脱敏。
- 构建时打包固定 Node sidecar、Chrome Headless Shell、FFmpeg/FFprobe，并校验 runtime manifest。
- OpenAI Compatible / stable-diffusion.cpp 图片，audio.cpp 本地 TTS/ASR，OpenAI Compatible TTS/ASR，Embedding/RAG 和网页来源正文抓取。
- 项目文件锁、素材落盘、缺失扫描、可恢复归档删除及含素材的 ZIP 项目包导入导出。
- 浏览器预览支持完整项目持久化、SVG 视觉草案、系统语音试听、字幕导出和真实 WebM 视频录制。
- 桌面版 API Key 不写入 WebView、项目文件或 SQLite，而是保存在系统凭据库。

## 开发

```bash
npm install
npm run dev
```

浏览器预览运行在 `http://127.0.0.1:1420`。

```bash
npm run test:frontend
npm run test:components
cd src-tauri && cargo test
npm run renderer:smoke
npm run test:e2e:desktop:full
npm run test:smoke:windows:sandbox
```

`renderer:smoke` 需要先执行 `npm run renderer:prepare`，会启动随包 Node/Chrome/FFmpeg 渲染一个短视频片段。

桌面 E2E 使用 Tauri WebDriver 和匹配当前 Edge 版本的 `msedgedriver`。完整命令会自动构建应用；也可先运行 `npm run test:e2e:desktop` 复用已有 release EXE。测试使用隔离的临时应用数据目录，并在重启后验证项目持久化。

Windows 干净 VM smoke 会安装 NSIS、校验 runtime 哈希、离线渲染短视频、启动应用检查日志并静默卸载。当前主机未启用 Windows Sandbox 时，可在干净 VM 中直接运行 `scripts/windows-vm/run-install-smoke.ps1`；CI 使用全新 Windows runner 自动执行。

## 桌面应用

```bash
npm run desktop:dev
```

要求 Windows 已安装 Rust、MSVC Build Tools、Windows 10 SDK 和 WebView2。本地 AI 运行时不再随安装包分发；用户首次选择本地模型时才检测显卡并下载 CUDA 12.4 或 Vulkan 版本。最终用户无需安装 CUDA Toolkit 或 Vulkan SDK。桌面数据写入 Tauri 应用数据目录：

构建会复制约 1 GB 的固定渲染依赖。首次构建若本机尚无 Chrome Headless Shell，`renderer:prepare` 会在构建阶段准备一次；正式安装后的应用不需要用户安装 Node、Chrome 或 FFmpeg。

运行时按需保存到应用数据目录的 `runtimes/`。安装器优先通过 `nvidia-smi` 检测可用的 NVIDIA 驱动与计算能力，满足 CUDA 12.4 条件时下载 CUDA 包及其运行库，否则下载 Vulkan 包。GGUF 使用官方 llama.cpp `llama-server`，不依赖 Ollama。模型文件本身不复制到应用数据目录；Provider 只保存本地文件路径、上下文长度和推理设备偏好。

本地 Provider 可填写 audio.cpp 模型文件/包目录或 stable-diffusion.cpp 模型目录。应用会生成受限的本地服务配置、自动发现扩散模型组件、启动服务并等待健康状态；请求之间由同一 `LocalModelScheduler` 串行化 GPU 工作，audio.cpp 和扩散模型空闲后通过各自 API 卸载，llama.cpp 空闲超过默认 180 秒后停止。

```text
%APPDATA%/com.knowmotion.studio/
├─ studio.sqlite3
├─ logs/
│  ├─ knowmotion.log
│  └─ knowmotion.{1..7}.log
├─ scheduler/          # 应用生成的 audio.cpp 配置
└─ projects/
   └─ {projectId}/
      ├─ project.json
      ├─ script/
      ├─ storyboard/
      ├─ assets/
      ├─ animation/
      ├─ subtitles/
      ├─ renders/
      └─ cache/
```

## 构建

```bash
npm run build
npm run desktop:build
```

桌面构建只准备通用渲染依赖，不预下载 llama.cpp、audio.cpp 或 stable-diffusion.cpp。`npm run llama:prepare` 仍可作为开发者的显式手工工具，但正式构建和应用启动不会自动调用它。

安装包输出位于：

```text
src-tauri/target/release/bundle/nsis/
```

架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，UI 规范见 [docs/UI_DESIGN.md](docs/UI_DESIGN.md)，Agent 系统见 [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md)，动画引擎见 [docs/REMOTION_ENGINE.md](docs/REMOTION_ENGINE.md)。

本地模型运行时、GGUF 模型包和 12 GB 显存配置见
[docs/LOCAL_MODEL_RUNTIMES.md](docs/LOCAL_MODEL_RUNTIMES.md)。

## 第一条端到端示例

项目模板：**天空为什么是蓝色的？**

- 约 60 秒、16:9、1080P。
- 六场景、五种视觉风格。
- 真实 Windows 中文旁白 WAV、字幕和程序化背景音乐。
- Remotion Player 预览。
- Remotion Renderer 导出 H.264/AAC MP4。

```bash
npm run mvp:render
```

输出：[renders/sky-blue-mvp.mp4](renders/sky-blue-mvp.mp4)

MVP 验收明细见 [docs/MVP_ACCEPTANCE.md](docs/MVP_ACCEPTANCE.md)。
