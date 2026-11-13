# KnowMotion AI Studio 实现审计

> 审计日期：2026-11-13  
> 基线：原始《项目开发总提示词》、`docs/ARCHITECTURE.md`、`docs/AGENT_WORKFLOW.md`、`docs/REMOTION_ENGINE.md`、`docs/MVP_ACCEPTANCE.md`  
> 判定原则：代码、持久化数据、自动化测试或真实产物可证明的，才算已实现；只有 UI、提示词或设计文档的不算。

## 1. 总体结论

当前应用已经具备一条可运行的知识动画制作主线：

```text
创建项目
→ 编辑/保存项目
→ 配置与测试 LLM Provider
→ 九 Agent 结构化工作流
→ 审批、暂停、恢复、重试、局部重跑、撤销
→ Scene DSL
→ Remotion Player 预览
→ 本地中文旁白与背景音乐
→ H.264/AAC MP4 渲染
→ SQLite + 项目目录恢复
```

但“真实 AI 全流程”和“可安装、离线、可取消的生产渲染运行时”尚未完成：

- 当前机器没有可用 LLM 凭据或 Ollama，因此真实 AI 请求没有完成端到端验收。
- 图片生成、ASR、Embedding/RAG、ComfyUI 只有能力入口或数据结构，没有后端实现。
- Remotion 正式渲染依赖项目源码、系统 Node 和 Remotion 自动管理的 Chrome，不是架构要求的固定版本 sidecar。
- 当前渲染没有流式进度事件、取消、进程树监管、断点恢复和发布级打包。

## 2. 阶段完成度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：Tauri 桌面框架 | 大部分完成 | 窗口、React、Zustand、WebView、SQLite、项目目录和 Provider 配置已接通 |
| Phase 2：AI 内容创作 | 框架完成，真实调用待验收 | 九个 Agent 和 DAG 已实现；没有执行外部真实 LLM 端到端测试 |
| Phase 3：素材生成 | 部分完成 | 本地 SVG 和图片导入可用；真正 AI 图片/ComfyUI Provider 未实现 |
| Phase 4：Remotion 动画 | 主体完成 | Scene DSL、组件库、Player、单场景和整片预览可用 |
| Phase 5：音频和渲染 | 部分完成 | SAPI 旁白、字幕、音乐和 MP4 已真实生成；渲染 sidecar、取消和进度未完成 |
| Phase 6：完整 AI 工作流 | 部分完成 | 审批、局部重跑、自然语言场景 Patch 已实现；Web 研究、视觉生成和自动成片闭环不完整 |

## 3. 已实现

### 3.1 桌面与 UI

- Tauri 2 + React 19 + TypeScript + Vite。
- Tailwind CSS v4；页面和组件专属 CSS 已拆分。
- Windows 无边框透明圆角窗口。
- 自定义标题栏：产品图标、名称、项目上下文、AI、设置、新建、导出、最小化、最大化、关闭。
- 标题栏拖动、双击最大化、边缘缩放。
- Dashboard、新建项目、Agent 工作流、策划、脚本、分镜、素材、动画、Remotion Studio、时间轴、音频字幕、渲染、模型配置。
- 浏览器预览模式可运行；桌面模式启用 SQLite、keyring、SAPI 和 Renderer。

### 3.2 项目持久化

- 创建、编辑、删除和复制项目 UI。
- Zustand 状态持久化。
- Tauri 桌面模式写入 SQLite `app_state`、`projects`、`providers`。
- 自动生成项目目录：
  - `project.json`
  - `script/outline.json`
  - `script/narration.json`
  - `storyboard/scenes.json`
  - `assets/manifest.json`
  - `animation/timeline.json`
  - `subtitles/captions.json`
- 保存 WAV 旁白和 WAV 背景音乐到项目目录。
- 项目重启恢复已验证；蓝天示例项目在第二次启动后仍可打开。

### 3.3 Provider

- OpenAI Compatible、Anthropic、Gemini、Ollama 四类 LLM HTTP Adapter。
- 网络超时、429/5xx 重试、错误响应脱敏。
- Provider 连接检测执行真实请求，不是本地假检测。
- 不同 Agent 独立指定 Provider 和模型覆盖。
- API Key 写入系统 keyring，不写入项目 JSON、SQLite 或日志。
- 模型路由持久化到 Workflow Run。

### 3.4 Agent 与 Workflow

- 统一异步 `Agent` Trait。
- 九个 Agent：
  - Research
  - Director
  - Script
  - Storyboard
  - Art Director
  - Asset
  - Animation
  - Audio
  - Quality
- 结构化 `AgentInput` / `AgentOutput`。
- 固定 DAG 依赖。
- 持久化 Workflow Run、Step、Event、Provider Call。
- 大纲、分镜、最终质量三个审批节点。
- 暂停、恢复、失败重试。
- 从指定步骤局部重跑；恢复该步骤之前的项目快照。
- 每个 Agent 工具调用保存 before/after 修订，支持撤销。
- 应用重启时把 running 步骤重置为 pending，把 Run 安全暂停。
- 工具白名单、场景/图层/字幕/素材/时间范围校验。
- Animation Agent 只允许 `patchScenes`。
- 从“第二个场景”“scene 2”“最后一个场景”解析目标 sceneId。
- 越界修改其他场景会失败。
- 动画 Patch 锁定标题、旁白、描述、视觉提示词、时长和 assetId。
- 允许修改图层、转场、镜头预设和素材表现方式。

### 3.5 Remotion

- Zod `SceneDsl` 和 `CompositionDsl`。
- Scene DSL 校验场景 ID、图层 ID、时间、颜色、素材引用和帧数。
- 可复用组件：
  - 文本
  - SVG
  - 图片
  - 图表
  - 镜头运动
  - 场景转场
- 支持 fade、slide、wipe、iris。
- 支持 `pushIn`、`pullOut`、`panLeft`、`panRight`。
- 支持多场景 Sequence 时间轴。
- Remotion Player 整片预览。
- 单场景独立预览。
- Composition JSON 导出。
- 固定 Remotion 入口 `KnowledgeVideo`。
- 实际通过 `@remotion/renderer` 输出 H.264/AAC MP4。
- 示例项目“为什么天空是蓝色的？”：
  - 6 场景、5 种视觉风格。
  - 1920×1080、30 FPS、60.011 秒。
  - 真实旁白、字幕、背景音乐。
  - 已生成 `renders/sky-blue-mvp.mp4`。

### 3.6 音频与字幕

- Windows Huihui 中文 SAPI 真实合成 WAV。
- 程序化生成 15 秒氛围音乐 WAV。
- 修整场景时长并同步旁白片段。
- 根据旁白生成字幕 Cues。
- Remotion Composition 支持音频轨。
- AAC 立体声输出，已通过非静音检测。

## 4. 部分实现

| 功能 | 当前状态 | 缺口 |
|---|---|---|
| 真实 AI 内容生成 | Agent 和 HTTP Adapter 已完成 | 当前无外部 Key/Ollama，未完成真实模型端到端验收 |
| Research Agent | 可让 LLM 返回来源候选 | 没有网页检索、下载、全文抽取、引用核验或 RAG |
| 图片生成 | 本地 SVG 视觉草案和上传可用 | 没有 OpenAI Images、SDXL、ComfyUI 等 ImageProvider；`illustration` 仍是 SVG 备用 |
| 素材保存 | 清单和部分音频已落盘 | 浏览器上传图片和 Agent SVG 主要以 Data URL 存在项目状态中，没有逐文件写入 `assets/images` |
| TTS | Windows SAPI 可用 | 没有云端 TTS Provider、情绪控制、角色音色、统一 TTS Adapter |
| 字幕 | 根据已知旁白生成时间轴 | 没有 ASR 自动听写 |
| 项目保存 | UI 变更自动持久化 | 每次写入完整状态；没有 debounce、文档级保存、文件锁、修订冲突检测 |
| 项目版本 | Agent 工具有 before/after 修订 | 手动 UI 编辑没有同等版本历史；没有全局用户撤销栈 |
| 项目复制 | 可复制内存项目 | 没有完整复制项目目录、媒体文件和本机渲染历史 |
| 项目导出 | 可导出项目 JSON | 没有包含素材的 ZIP 项目包 |
| 渲染 | MP4 已真实生成 | 没有流式进度、取消、sidecar、进程树回收、部分文件校验和失败恢复 |
| 4K/60 FPS | Composition 与 Renderer 支持参数 | UI 只验证了 1080P；没有 4K/60 实测和资源限制 |
| 动画组件 | 文本、SVG、图片、图表已实现 | 没有专用视频图层；Canvas 和 GSAP 没有独立组件实现 |
| 质量检查 | Quality Agent 写结构化报告 | 没有发布前硬性阻断、自动修复和逐项修复操作 |
| 错误恢复 | Agent 可人工重试、App 重启可恢复 | `maxAttempts` 未自动执行；没有指数退避、租约和通用任务队列 |
| 用量统计 | 记录 Provider、模型、耗时和结果 | 没有 token/图片/音频用量表、成本和预算限制 |
| IPC 契约 | Rust/TS 手工定义对应类型 | 没有使用 Specta/Tauri Specta 自动生成 |
| JSON Schema | 有设计用 Schema 文件 | 与运行时 TS/Rust 模型没有自动生成关系，存在重复定义 |

## 5. 未实现

- 真正的 AI 图片生成 Provider。
- ComfyUI 适配器（UI 可选，但 Rust Provider 不支持）。
- 在线 TTS Provider 与多音色/情绪控制。
- ASR 语音识别。
- Embedding、知识库、向量检索和 RAG。
- Web 研究和引用抓取。
- 角色一致性、场景一致性、参考图管理。
- 批量图片生成队列、图片局部重绘。
- 视频素材图层与视频剪辑。
- Canvas 专用动画组件。
- GSAP 集成。
- 渲染流式进度事件 `render.progress`。
- 渲染取消和 `cancelSignal`。
- Windows Job Object/渲染子进程树监管。
- `.partial.mp4` + FFprobe + SHA-256 + 原子提交。
- 渲染断点恢复。
- 独立 `render_jobs`、`tasks`、`usage_records`、`artifact_refs` 数据库表。
- `schema_migrations` 迁移机制。
- 固定 Node sidecar 的 `externalBin` 配置。
- 随安装包分发固定 Chrome Headless Shell。
- 随安装包分发 FFmpeg/FFprobe 和 runtime manifest。
- 用户机器无需 Node/Chrome/FFmpeg 的离线渲染。
- NSIS 安装包发布验收。
- Authenticode 签名、时间戳和 signed updater。
- Windows 干净虚拟机 smoke test。
- 项目文件锁、损坏修复、缺失素材扫描、ZIP 打包迁移。
- 前端单元测试、组件测试和自动化端到端测试。
- 生产级日志轮转与统一脱敏日志管线。

## 6. 与架构文档不一致的关键项

### 6.1 项目事实来源

文档要求项目 JSON 为可移植内容事实来源，SQLite 是可重建索引。当前打开项目实际优先恢复 Zustand `app_state`；项目目录是同步镜像。外部修改 `project.json` 不会自动导入应用。

### 6.2 Remotion 运行方式

文档要求 Rust 启动固定 Node sidecar，worker 输出 JSONL 进度，并在结束后原子提交文件。当前 Rust 直接查找仓库中的 `node_modules/tsx`，调用系统 `node` 执行源码脚本：

```text
node node_modules/tsx/dist/cli.mjs scripts/render-remotion.ts
```

因此当前 Debug 开发环境可渲染，但安装后的独立应用还不能保证渲染可用。

### 6.3 浏览器与 FFmpeg

架构要求构建时固定并校验 Chrome 和 FFmpeg。当前 Remotion 会在首次渲染时自动下载 Chrome Headless Shell，并使用 Remotion 自带 FFmpeg。没有 runtime manifest 或离线产物校验。

### 6.4 SQLite

已实现 `app_state`、`projects`、`providers`、`workflow_runs`、`workflow_steps`、`project_revisions`、`workflow_events`、`provider_calls`。

文档中的 `schema_migrations`、`tasks`、`render_jobs`、`usage_records`、`artifact_refs` 尚未实现。

### 6.5 Schema

当前运行时强校验使用 Zod 的 Remotion Schema；项目 Schema 主要由 TS 类型和 Rust 工具归一化负责。`docs/schemas/*.json` 没有接入保存和加载流程。

## 7. 端到端验收对照

| 验收项 | 状态 | 说明 |
|---|---|---|
| Windows 桌面启动 | 通过 | Debug EXE 已实际启动 |
| 创建和保存项目 | 通过 | SQLite、项目目录和 JSON 已验证 |
| 配置实际 AI Provider | 实现，未在线验收 | 真实 HTTP 路径已完成，缺实际 Key |
| AI 生成结构化脚本和分镜 | 实现，未在线验收 | Agent 与 Schema 已完成 |
| 至少三个动画场景预览 | 通过 | 蓝天项目 6 个场景五风格 |
| 生成真实视频 | 通过 | 60.011 秒 H.264/AAC |
| 重新打开继续编辑 | 通过 | SQLite 与磁盘目录均有数据 |
| 非模拟渲染进度 | 部分通过 | WebM 与 Renderer 均真实；MP4 UI 无进度事件，只显示真实执行状态 |

## 8. 建议优先级

### P0：形成可发布闭环

1. 使用实际 LLM Provider 完成一次 Research → Quality 全流程验收。
2. 打包固定 Node sidecar、Chrome Headless Shell 和 FFmpeg。
3. Renderer 改为持久 Job + stdout JSONL，实现真实进度、取消和进程树清理。
4. 渲染结束后执行 FFprobe、SHA-256、原子重命名和数据库提交。

### P1：完整素材能力

1. 实现 ImageProvider，将图片需求路由到 OpenAI Images/ComfyUI。
2. 把 Data URL 素材迁移为真实项目文件与 asset manifest。
3. 实现素材缺失检查与重新生成。
4. 接入在线 TTS Provider，并保留 Windows SAPI 作为离线 Provider。

### P2：平台完整性

1. 生成 IPC TypeScript 类型与 JSON Schema。
2. 引入正式 SQLite migrations 和缺失表。
3. 增加前端测试与桌面端 E2E。
4. 完成 NSIS、签名、更新器和干净 Windows VM 验收。
