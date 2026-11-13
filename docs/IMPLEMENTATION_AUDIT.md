# KnowMotion AI Studio 实现审计

> 审计更新：2026-11-13（第二轮实施后）
>
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

第二轮实施已经补齐发布闭环的主要工程能力：

- SQLite 迁移、`tasks`、`render_jobs`、`usage_records`、`artifact_refs`、`knowledge_chunks` 已接入。
- 正式渲染改为持久 Job，支持真实 JSONL 进度、取消、重启中断恢复、FFprobe、SHA-256、原子提交和渲染元数据。
- 构建阶段生成固定 Node sidecar、Chrome Headless Shell、FFmpeg/FFprobe、完整 Remotion 依赖和 `runtime-manifest.json`；Worker 已用随包资源完成真实 smoke render。
- NSIS 安装包已实际生成；当前仍未做 Authenticode 签名、更新器签名和干净 Windows VM 验收。
- 图片生成已支持 OpenAI Compatible 与 ComfyUI，TTS、ASR、Embedding/RAG、网页正文抓取已有 Rust 实现。
- Data URL 素材会落入 `assets/images` 或 `assets/audio`，项目 JSON 成为恢复事实来源；复制、归档删除、缺失扫描和 ZIP 包导入导出已接通。

仍不能宣称“所有外部服务均已在线验收”：当前没有可用 LLM/图片/TTS/ASR/Embedding 凭据，相关网络路径只有结构和单元测试，没有真实付费/私有服务端到端记录。

## 2. 阶段完成度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：Tauri 桌面框架 | 完成 | 窗口、React、Zustand、WebView、SQLite 迁移、项目锁、目录、Provider 配置和 NSIS 构建已接通 |
| Phase 2：AI 内容创作 | 框架完成，真实调用待验收 | 九个 Agent 和 DAG 已实现；没有执行外部真实 LLM 端到端测试 |
| Phase 3：素材生成 | 完成核心能力 | 本地 SVG、图片导入、OpenAI Images、ComfyUI、文件落盘与清单已实现 |
| Phase 4：Remotion 动画 | 主体完成 | Scene DSL、组件库、Player、单场景和整片预览可用 |
| Phase 5：音频和渲染 | 完成工程闭环 | SAPI/云端 TTS、ASR、字幕、音乐、持久渲染 Job、离线 sidecar、进度、取消、验证和安装包已实现 |
| Phase 6：完整 AI 工作流 | 大部分完成 | 审批、局部重跑、自动重试、自然语言场景 Patch、图片/TTS/ASR/RAG/网页正文入口已实现；真实外部服务尚未在线验收 |

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

### 3.7 持久任务、渲染与发布

- `render_start` 返回 `jobId/taskId`，持久写入 `tasks`、`render_jobs`。
- Node Worker 以 stdout JSONL 输出 `started/progress/completed/error/canceled`。
- Rust 通过 Tauri `render.progress` 转发真实百分比、已渲染帧和编码帧。
- `render_cancel` 通过 stdin 触发 Remotion 官方 `cancelSignal`，超时后终止进程。
- 每个渲染 Job 使用独立 Windows Job Object；设置 `KILL_ON_JOB_CLOSE` 和 64 进程上限，取消超时后通过 `TerminateJobObject` 回收 Node、Chrome、FFmpeg 整棵树。
- 应用重启时，未完成渲染转为 `interrupted`，临时文件可重新发起。
- 成功渲染先写 `.partial.mp4`，FFprobe 验证视频流和时长，计算 SHA-256，原子重命名后再提交数据库。
- 输出旁挂 JSON 元数据，`artifact_refs` 与 `usage_records` 可追溯。
- `renderer:prepare` 生成固定 Node、Chrome Headless Shell、FFmpeg/FFprobe、Remotion 依赖和哈希 manifest。
- `renderer:smoke` 已用随包资源生成 966,517 字节真实 MP4 并通过。
- Canvas smoke 已用随包 Renderer 生成 980,685 字节 MP4；抽帧确认 `network` 图层实际进入 H.264 成片。
- GSAP smoke 已用随包 Renderer 生成 991,445 字节 MP4；`orbit` 运动与 Canvas 图层共同进入最终成片。
- Windows Job Object 两项真实进程树测试通过：显式 `TerminateJobObject` 与关闭最后一个 Job 句柄都会终止后代进程。
- NSIS `0.1.0` 安装包已实际生成，包含离线渲染资源。
- Release EXE 在 Windows 上完成运行时 manifest 校验并稳定启动；Windows 主线程栈设为 8 MB，避免 release 构建启动时栈溢出。

### 3.8 项目文件与迁移

- `project.json` 在加载时优先于 SQLite 状态，外部修改可通过重启重新导入。
- Data URL 图片/音频按文件签名校验后写入 `assets/images` 或 `assets/audio`，并生成带 MIME、大小和 SHA-256 的 `assets/manifest.json`。
- 项目写操作使用 `.lock` 防止同项目并发覆盖，过期锁可恢复。
- 自动保存按约 450 ms debounce 合并，项目文档写入仍使用临时文件 + flush + 原子替换。
- 删除项目把完整目录移动到 `.archive/{projectId}-{timestamp}`，随后删除索引。
- 复制项目会复制本地素材，不再依赖原项目的 `kmasset` URL。
- ZIP 导出排除 `cache`，校验所有素材；ZIP 导入校验 CRC、路径穿越并以新项目 ID 原子落地。
- 每次保存写入结构化修订目录，素材由稳定 assetId 和相对路径引用。

### 3.9 多能力 Provider

- OpenAI Compatible Images、ComfyUI 标准 Checkpoint 工作流图片生成。
- OpenAI Compatible TTS 与 Windows SAPI 双路径。
- OpenAI Compatible ASR，使用 multipart 上传项目内音频，并保存时间片段。
- OpenAI Compatible Embedding；知识片段按字符窗口切块并写入 `knowledge_chunks`。
- 项目内余弦相似度检索返回来源、片段和分数。
- 网页来源抓取包含 URL 协议/私网校验、重定向上限、5 MB 限制、正文提取和浏览器式脚本标签剔除。
- 图片、TTS、ASR、Embedding 的密钥仍只从系统凭据库读取。

### 3.10 生产日志与脱敏

- Rust 后台线程通过有界队列写入结构化 JSONL，避免渲染和网络线程同步写盘。
- `knowmotion.log` 达到 5 MiB 时轮转为 `knowmotion.{n}.log`，保留 7 份历史并删除 30 天以前文件。
- 每条记录包含 UTC 毫秒时间、级别、target、message 和可选结构化字段；单条字段与消息有大小上限。
- 统一脱敏器递归处理结构化字段，并覆盖 Authorization/Bearer、x-api-key、Cookie、API Key、密码、token、URL 用户信息/查询参数、私钥块和 Data URL。
- WebView 的 `console.error`、`console.warn`、全局 error 与 unhandled rejection 通过 `write_webview_log` 进入同一后端脱敏器。
- Rust panic hook、渲染生命周期、Provider 调用、Workflow 事件、媒体合成和知识检索均接入统一管线。
- 渲染 stderr 采用 256 KiB 滚动尾部缓冲，既持续排空子进程管道，又避免无上限内存占用。

### 3.11 组件测试与桌面 E2E

- Vitest + Testing Library + jsdom 覆盖共享 Segmented、Modal 键盘操作、Progress 可访问性和新建项目表单流程。
- Tauri WebDriver 使用 `tauri-driver` + 与已安装 Edge 完全匹配的 `msedgedriver` 启动真实 release 应用。
- 桌面 E2E 使用 `KNOWMOTION_E2E_DATA_DIR` 隔离 SQLite、项目和日志，不接触用户应用数据。
- 自动化流程覆盖 Dashboard 输入主题、新建项目、进入策划、动画编辑、添加 Canvas 图层、打开 Remotion Studio。
- E2E 会关闭并重启真实桌面应用，再从 Dashboard 验证新项目已由 SQLite 恢复。
- 失败时保存页面截图与 DOM，成功时清理旧诊断文件；应用会话、WebDriver 和临时数据在 finally 中回收。
- GitHub Actions Windows workflow 运行 Rust、Node 单元测试、组件测试、Lint、构建与桌面 E2E。

## 4. 部分实现

| 功能 | 当前状态 | 缺口 |
|---|---|---|
| 真实 AI 内容生成 | Agent 和 HTTP Adapter 已完成 | 当前无外部 Key/Ollama，未完成真实模型端到端验收 |
| Research Agent | 来源候选、正文抓取、Embedding 与项目内检索 | 尚无搜索引擎 API、自动引用核验和跨项目知识库；抓取正文仍需人工核验 |
| 图片生成 | OpenAI Images、ComfyUI、上传与 SVG 均可用 | ComfyUI 仅覆盖标准 Checkpoint 文本生图工作流，Reference/ControlNet 未配置 |
| 素材保存 | Data URL 与生成结果会落盘并记录哈希 | 外部远程 URL 尚未下载成本地资产 |
| TTS | SAPI 与 OpenAI Compatible TTS 可用 | 情绪/角色模板、独立云端 Adapter 和真实服务验收仍缺 |
| 字幕 | 已知旁白与云端 ASR 听写 | ASR 依赖服务返回 segment；无时间片段时回退按场景均分 |
| 项目保存 | debounce、项目锁、文档和修订目录已接通 | 仍是项目级状态合并；文档级 revision/expectedRevision 冲突协议未启用 |
| 项目版本 | Agent 修订与保存快照 | 手动 UI 编辑没有同等全局 undo/redo 栈 |
| 项目复制 | 本地素材与项目数据可复制 | 数据库工作流/渲染历史不复制到新项目 |
| 项目导出 | 含素材、渲染和修订的 ZIP 包 | 无独立迁移工具和跨设备自动升级 |
| 渲染 | 持久 Job、进度、取消、Windows Job Object、离线 runtime、验证和原子提交 | 尚无跨平台进程树容器；当前发行目标是 Windows |
| 4K/60 FPS | Composition 与 Renderer 支持参数 | UI 只验证了 1080P；没有 4K/60 实测和资源限制 |
| 动画组件 | 文本、SVG、图片、图表、Canvas 2D 与确定性 GSAP 已实现 | 没有专用视频图层 |
| 质量检查 | `status=fail` 在 UI 与 Rust 渲染入口双重阻断 | 没有自动修复、逐项修复按钮或可配置发布规则 |
| 错误恢复 | Agent 自动指数退避重试；App 重启安全暂停/中断 | 尚无租约调度器和统一 `tasks` worker 消费器 |
| 用量统计 | LLM token、图片数、音频时长写入 `usage_records` | 无价格表、成本估算、额度与预算限制 |
| IPC 契约 | Rust/TS 手工定义对应类型 | 没有使用 Specta/Tauri Specta 自动生成 |
| JSON Schema | 有设计用 Schema 文件 | 与运行时 TS/Rust 模型没有自动生成关系，存在重复定义 |

## 5. 未实现

- 角色一致性、场景一致性、参考图管理。
- 批量图片生成队列、图片局部重绘。
- 视频素材图层与视频剪辑。
- Authenticode 签名、时间戳和 signed updater。
- Windows 干净虚拟机 smoke test。
- 真实外部 LLM/Image/TTS/ASR/Embedding 服务端到端验收。

## 6. 与架构文档不一致的关键项

### 6.1 项目事实来源

`load_studio_state` 在读取 SQLite 状态后，会逐个用磁盘 `project.json` 覆盖内存项目并为本地素材生成受限 `kmasset` URL。因此正常重启可以导入外部修改。仍未实现文件监听；应用运行期间的外部修改需要重新加载窗口。

### 6.2 Remotion 运行方式

Rust 优先启动应用目录中的固定 `node.exe`，加载打包后的 `resources/renderer`，通过 `scripts/render-worker.ts` 输出 JSONL。开发环境才回退到仓库依赖和系统 Node。安装包已经实际包含该运行目录。

### 6.3 浏览器与 FFmpeg

构建阶段复制固定 Chrome Headless Shell、FFmpeg、FFprobe，并写入 runtime manifest 与 SHA-256。渲染服务启动时校验 bundle 内文件；缺少或不匹配会拒绝渲染。Remotion 仍可能在开发机首次准备资源时联网，正式安装包不会在渲染时下载。

### 6.4 SQLite

已实现 `schema_migrations`、`app_state`、`projects`、`providers`、`workflow_runs`、`workflow_steps`、`project_revisions`、`workflow_events`、`provider_calls`、`tasks`、`render_jobs`、`usage_records`、`artifact_refs`、`knowledge_chunks`。

迁移当前使用幂等 schema 事务和版本记录；对外仍是单用户本地应用，没有 schema downgrade。

### 6.5 Schema

Remotion 使用 Zod 强校验；项目保存由 Rust 路径/素材/身份校验和 TS 类型共同约束。`docs/schemas/*.json` 仍然只作为设计契约，尚未从 TS/Rust 模型自动生成或直接参与运行时校验。

## 7. 端到端验收对照

| 验收项 | 状态 | 说明 |
|---|---|---|
| Windows 桌面启动 | 通过 | Debug 与 release EXE 均已完成启动 smoke test |
| 创建和保存项目 | 通过 | SQLite、项目目录和 JSON 已验证 |
| 配置实际 AI Provider | 实现，未在线验收 | 真实 HTTP 路径已完成，缺实际 Key |
| AI 生成结构化脚本和分镜 | 实现，未在线验收 | Agent 与 Schema 已完成 |
| 至少三个动画场景预览 | 通过 | 蓝天项目 6 个场景五风格 |
| 生成真实视频 | 通过 | 60.011 秒 H.264/AAC |
| 离线 Worker smoke render | 通过 | 随包 Node/Chrome/FFmpeg 输出 966,517 字节 MP4 |
| 真实进度与取消 | 实现，进行中验收 | JSONL 与 `render.progress` 已接入；完整片长取消只在代码路径验证 |
| NSIS 安装包 | 通过 | `195.97 MiB`，已包含 runtime resources |
| 重新打开继续编辑 | 通过 | SQLite 与磁盘目录均有数据 |
| 非模拟渲染进度 | 通过 | Remotion `onProgress` → Worker JSONL → Rust → Tauri event → UI |

## 8. 建议优先级

### P0：形成可发布闭环

1. 使用实际 LLM Provider 完成一次 Research → Quality 全流程验收。
2. 使用真实 Image/TTS/ASR/Embedding 服务完成各能力 smoke test。
3. 完成 Windows Job Object，替换当前 stdin 取消 + 超时 kill 的近似进程树回收。
4. 配置 Authenticode、签名 updater 并在干净 Windows VM 执行安装/卸载/离线渲染验收。

### P1：完整素材能力

1. 为素材缺失增加“重新生成当前资产”操作。
2. 增加角色/参考图一致性和 ComfyUI ControlNet/Reference 工作流。
3. 增加批量图片任务队列和局部重绘。
4. 增加云端 TTS 情绪/角色模板。

### P2：平台完整性

1. 生成 IPC TypeScript 类型与 JSON Schema，消除手工重复模型。
2. 扩展桌面 E2E 到审批流、真实媒体任务和取消/重启恢复场景。
3. 增加发布 CI 日志聚合与远程诊断导出。
4. 增加发布签名、signed updater、SBOM 和 VM smoke test。
