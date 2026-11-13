# KnowMotion AI Studio

AI-powered knowledge animation studio. 用户从一个知识主题开始，在同一项目上下文中完成内容策划、脚本、分镜、素材、动画、音频字幕和视频预览。

## 当前实现

- Tauri 2 + React 19 + TypeScript + Vite 桌面架构。
- Tailwind CSS v4 负责工具类与设计 Token，桌面界面组件层保留在工作站样式文件中。
- Rust 后端通过 SQLite 保存项目、Provider 元数据和持久化状态。
- 每个项目同步生成独立的 `project.json`、脚本、分镜、素材清单、动画时间轴和字幕目录。
- 14 个工作区界面：Dashboard、新建项目、Agent 工作流、内容策划、脚本、分镜、图片素材、动画、Remotion Studio、时间轴、AI 助手、音频字幕、渲染、模型配置。
- 九个持久化 AI Agent 与 DAG Workflow：模型路由、审批、暂停恢复、局部重跑、受控项目工具、修订和撤销。
- 原生 GGUF 本地推理：可直接选择 `.gguf` 模型文件，支持 CPU 与 DirectX 12 GPU 加速。
- Remotion Scene/Composition DSL、可复用动画组件、实时 Player 和完整 H.264 渲染。
- 浏览器预览支持完整项目持久化、SVG 视觉草案、系统语音试听、字幕导出和真实 WebM 视频录制。
- 桌面版 API Key 不写入 WebView、项目文件或 SQLite，而是保存在系统凭据库。

## 开发

```bash
npm install
npm run dev
```

浏览器预览运行在 `http://127.0.0.1:1420`。

## 桌面应用

```bash
npm run desktop:dev
```

要求 Windows 已安装 Rust、MSVC Build Tools、Windows 10 SDK（包含 `dxc.exe`）和 WebView2。GPU 推理使用 DirectX 12，最终用户无需安装 CUDA 或 Vulkan SDK。桌面数据写入 Tauri 应用数据目录：

GGUF 使用内置的 llama-rs 推理引擎，不需要额外安装 Ollama 或 llama.cpp。推理设备可选“自动、GPU、CPU”；自动模式会优先使用 DirectX 12 GPU，检测不到兼容 GPU 时回退 CPU。模型文件本身不复制到应用数据目录；Provider 只保存本地文件路径、上下文长度和推理设备偏好。

```text
%APPDATA%/com.knowmotion.studio/
├─ studio.sqlite3
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

架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，UI 规范见 [docs/UI_DESIGN.md](docs/UI_DESIGN.md)，Agent 系统见 [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md)，动画引擎见 [docs/REMOTION_ENGINE.md](docs/REMOTION_ENGINE.md)。

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
