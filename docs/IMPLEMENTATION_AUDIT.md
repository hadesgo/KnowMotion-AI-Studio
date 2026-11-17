# KnowMotion AI Studio 实现审计

> 审计更新：2026-11-17 第七轮（`ac67f5d` 平台完整性提交后的全量复验：门禁实跑、陈旧结论修订、IPC 门禁行尾缺陷修复；并为 Blackwell 补入 CUDA 13 运行时备选，见 3.22）
>
> 基线：原始《项目开发总提示词》、`docs/ARCHITECTURE.md`、`docs/AGENT_WORKFLOW.md`、`docs/REMOTION_ENGINE.md`、`docs/MVP_ACCEPTANCE.md`、`docs/LOCAL_MODEL_RUNTIMES.md` 及最新运行时代码。
> 判定原则：代码、持久化数据、自动化测试或真实产物可证明的，才算已实现；只有 UI、提示词或设计文档的不算。

## 1. 总体结论

截至 `ac67f5d`（2026-11-17 平台完整性提交），应用已经具备一条可运行的知识动画制作主线：

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

第二轮实施和后续素材、设定集、视频、本地模型提交已经补齐大部分工程能力：

- SQLite 迁移、`tasks`、`render_jobs`、`usage_records`、`artifact_refs`、`knowledge_chunks` 已接入。
- 正式渲染改为持久 Job，支持真实 JSONL 进度、取消、重启中断恢复、FFprobe、SHA-256、原子提交和渲染元数据。
- 构建阶段生成固定 Node sidecar、Chrome Headless Shell、FFmpeg/FFprobe、完整 Remotion 依赖和 `runtime-manifest.json`；Worker 已用随包资源完成真实 smoke render。
- NSIS 安装包和干净 Windows VM 安装/离线渲染 smoke 已实际执行；当前仍未做 Authenticode 签名、时间戳和 signed updater。
- 图片生成已支持 OpenAI Compatible 与 stable-diffusion.cpp，TTS、ASR、Embedding/RAG、网页正文抓取已有 Rust 实现。
- Data URL 素材会落入 `assets/images` 或 `assets/audio`，项目 JSON 成为恢复事实来源；复制、归档删除、缺失扫描和 ZIP 包导入导出已接通。
- llama.cpp、audio.cpp、stable-diffusion.cpp 已接入按需运行时下载、SHA-256 归档校验及 CUDA/Vulkan 选择；三种运行时均可由统一本地模型调度器按需拉起或复用回环服务。

第四轮补充了真实服务端到端验收：在 RTX 5070 上用本机真实模型和三个固定版本运行时（llama.cpp / audio.cpp / stable-diffusion.cpp）跑通了 LLM、Embedding、TTS、ASR、Image 五项能力，判定基于可解析 JSON、向量语义排序、WAV 时长、TTS→ASR 闭环和 PNG 尺寸/哈希，产物与报告见 `docs/REAL_SERVICE_ACCEPTANCE.md`。因此“真实模型服务完全没跑过”不再成立。

第五轮之后又补了 P0 收口（见 3.19）：局部重绘遮罩语义、跨项目素材路径两个 P1 已修复并有回归用例；九 Agent 全流程已用真实本地 LLM 跑通（723 s / 9 次调用 / 三个审批节点）；局部重绘的本地通道有了真实服务验收。

仍未覆盖的是第三方云端凭据路径（OpenAI/Anthropic/Gemini）：`real_cloud_acceptance` 与云端局部重绘用例已就绪，但需要真实 Key 才能执行。

第七轮（本节下方 3.21）只做复验，不新增功能：`c327fd7` 之后的 `ac67f5d` 已经落地 修订去重与保留、ZIP 预算、IPC 契约生成、CI 门禁、SBOM 与签名发布链路，本轮把这些逐项对着代码和真实命令重跑了一遍。结论是**代码事实与上一版审计基本一致，但有两处必须改口**：一是 `npm run ipc:check` 在 Windows 默认 Git 配置（`core.autocrlf=true`）下对干净工作区直接报 stale，而它是 `test.yml` 与 `release.yml` 的第一道门禁；二是 `src/services/desktop.ts` 里有一个调用不存在命令 `desktop_storage_path` 的死函数。两者都已修，见 4.10、4.11。同时订正了第二、五节里几条已经过期的结论（局部重绘 P1 状态、本地运行时完整性、Phase 7 闭环度）。

**发布判断：仍不通过，阻断项只由外部依赖和平台缺口两部分构成。** 原有 3 个 P1 已全部修复并回归；外部依赖是“云端 Key 验收”和“Authenticode 签名 + 签名后干净 VM 复验”；平台缺口是 4.12 列出的云端 LLM 通路验收与 Anthropic/Gemini 请求级测试，其中 Mock HTTP 部分不需要凭据就能补，真实云端仍需 Key。

## 2. 阶段完成度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：Tauri 桌面框架 | 完成 | 窗口、React、Zustand、WebView、SQLite 迁移、项目锁、目录、Provider 配置和 NSIS 构建已接通 |
| Phase 2：AI 内容创作 | 完成（本地通道）/ 云端待验收 | 九个 Agent、DAG 与 GGUF 本地通道已实现并有全流程真实验收（3.19）；云端 LLM 通路仍无凭据验收（4.12） |
| Phase 3：素材生成 | 基本完成 | 本地 SVG、图片导入、OpenAI Images、stable-diffusion.cpp、批量队列、局部重绘、文件落盘与清单已实现；原遮罩方向 P1 已修复并有像素级与真实服务双重验收 |
| Phase 4：Remotion 动画 | 主体完成 | Scene DSL、组件库、Player、单场景和整片预览可用 |
| Phase 5：音频和渲染 | 完成工程闭环 | SAPI/OpenAI Compatible/audio.cpp TTS、ASR、字幕、音乐、持久渲染 Job、离线 sidecar、进度、取消、验证和安装包已实现；本地服务生命周期、GPU 租约和空闲卸载已托管 |
| Phase 6：完整 AI 工作流 | 大部分完成 | 审批、局部重跑、自动重试、自然语言场景 Patch、图片/TTS/ASR/RAG/网页正文入口已实现；本地真实服务已跑通，云端仍未在线验收 |
| Phase 7：本地模型运行时 | 基本完成 | 三种 GGUF 类运行时按需下载、固定版本、逐文件哈希与损坏自动重装、自动启动、启动强制 smoke、显存租约和空闲卸载均已闭环；缺的是“有模型权重且有 GPU 的机器上重跑一次真实采样” |

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

- OpenAI Compatible、Anthropic、Gemini、Ollama 四类 LLM HTTP Adapter，以及 GGUF/llama.cpp 本地 LLM Adapter。
- audio.cpp 提供 TTS/ASR，stable-diffusion.cpp 提供图片生成和编辑入口。
- 网络超时、429/5xx 重试、错误响应脱敏。
- LLM Provider 连接检测执行真实生成请求；audio.cpp/stable-diffusion.cpp 当前主要检测能力端点，不保证指定模型已经加载。
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

- OpenAI Compatible Images 与 stable-diffusion.cpp 图片生成。
- OpenAI Compatible TTS 与 Windows SAPI 双路径。
- OpenAI Compatible ASR，使用 multipart 上传项目内音频，并保存时间片段。
- Embedding 双通道：OpenAI Compatible `/v1/embeddings`，或本地 GGUF 模型（`GGUF` Provider 由 llama.cpp `--embeddings` 托管，`base_url` 可填模型文件或模型目录）；知识片段按字符窗口切块并写入 `knowledge_chunks`。
- 项目内余弦相似度检索返回来源、片段和分数。
- 网页来源抓取包含 URL 协议/私网校验、重定向上限、5 MB 限制、正文提取和浏览器式脚本标签剔除。
- 图片、TTS、ASR 与云端 Embedding 的密钥仍只从系统凭据库读取；本地 GGUF Embedding 不读凭据库，走回环服务自签密钥。

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

### 3.12 Windows 干净 VM smoke

- 提供 `scripts/windows-vm/run-install-smoke.ps1`，可在任意干净 Windows 主机/VM 执行。
- 脚本拒绝已有 KnowMotion 安装，静默安装 NSIS 并定位实际布局。
- 校验应用、Node、Chrome、FFmpeg/FFprobe、Renderer 与 runtime manifest 的 SHA-256 哈希。
- 使用安装目录内固定运行时离线渲染 1.5 秒 H.264，通过 FFprobe 校验视频流与时长并计算成品 SHA-256。
- 启动安装后的应用，验证进程保持运行且生产 JSONL 日志出现 `Desktop services initialized`。
- 静默卸载后验证 EXE、Node、Chrome、FFmpeg 和 Renderer Worker 等关键运行文件已移除。
- `-EnforceOffline` 可在管理员 VM 中为安装应用和渲染二进制添加入站外网络阻断，测试结束自动移除防火墙规则。
- 提供 Windows Sandbox 自动编排脚本；本机未启用 Sandbox 时明确失败并提示改用干净 VM。
- GitHub Actions 使用全新 Windows runner 构建 NSIS，并执行强制离线安装 smoke。
- 实际本机验收：20 个 runtime 文件校验通过；离线视频 127,085 字节、1.5 秒、SHA-256 `7C799D0EEDDB87AE56E20531F9F48D548B7CCF6BDB79C32DE4D8A2CE1D4E3B28`；启动与卸载均通过。
- smoke 发现并修复了 FFmpeg/FFprobe 单独复制而未携带 compositor DLL 的发布缺陷；现在 15 个 DLL 一并打包并纳入哈希 manifest。

### 3.13 设定集：角色一致性、场景一致性与参考图管理

- 项目新增三组设定数据：`characters`（角色）、`locations`（场景/环境）、`styleLock`（全局风格锁定）；镜头通过 `characterIds`、`locationId` 绑定，旧项目在 store 迁移和 `merge` 时自动回填为空，不需要手工迁移。
- 参考图不另建文件管线：仍存放在 `project.assets` 中并带 `reference { role, entityId, label, weight, locked, notes }`，因此继续复用既有的 Data URL 校验、`assets/images` 落盘、`assets/manifest.json`、哈希、复制、ZIP 导出和 `kmasset` 地址重写。
- 一致性引擎 `src/services/consistency.ts`：
  - 双 32 位 FNV-1a 稳定哈希生成 16 位指纹。
  - 指纹覆盖风格描述/调色板、角色名/外观/服装/调色板、场景名/环境/光线/时段/调色板，以及参与生成的参考图 assetId。
  - 种子优先取设定卡上手填的 seed，否则由指纹派生；同一锚点重复解析得到完全相同的提示词、指纹和种子。
  - `[CONSISTENCY LOCK]` 指令块按“风格 → 角色（镜头内顺序）→ 场景 → 参考图声明”固定顺序拼接，重复调用幂等；负向词按风格/角色/场景去重合并。
- 素材快照：每次生成把 `fingerprint / anchorLabel / seed / prompt / negativePrompt / referenceAssetIds / conditioning` 写进 `asset.consistency`。设定或参考图一旦修改，指纹变化，旧素材被判定为 `stale`，而不是静默沿用。
- 审计报告：`consistencyReport` 逐镜头输出 `consistent / stale / unapplied / unanchored`，并给出锚点覆盖率评分。该评分是结构判定，不声称是图像相似度。
- 设定集工作区（`/projects/:id/canon`）：角色卡与场景卡的外观/环境/光线/时段/调色板编辑、手填种子、参考图上传（≤2MB）、权重 0.1–1、强制参考开关、删除、矢量参考草案生成、一键应用到全部镜头、逐镜头绑定、状态胶囊、锚点指令与指纹预览。
- 图片素材页接入：按当前镜头锚点组装提示词、负向词和种子后生成；结果带指纹入库；已有图片可通过“收进设定集”转为角色/场景/风格参考图；锚点变化时在画廊顶部显示“素材已过期”。
- 后端 `generate_project_images` 扩展 `negativePrompt / seed / references / anchorLabel / consistencyFingerprint`：
  - 参考图只接受项目内素材或 data URL，单张 ≤8 MiB、最多 3 张，读取后做文件头 MIME 校验。
  - 本地图片通过 stable-diffusion.cpp 生成；自第 3.18 节起，参考图可经 ControlNet/IP-Adapter/img2img 进入采样，`referenceMode` 记录实际生效的通道。
  - OpenAI Compatible 通道没有像素级参考入口，参考图只通过锚点提示词传递，如实返回 `referenceMode=prompt`。
  - 参考图上传失败会降级为纯提示词条件并写警告日志，`referenceMode` 反映实际执行的路径。
- 明确的边界：`consistencyReport` 是结构判定；像素级身份验证由 3.18 的独立引擎承担，两者不要混为一谈。

### 3.14 批量图片队列与局部重绘

- 新增 `image_jobs` 持久表和对应的 `tasks` 记录（`kind='image'`）；每个任务保存完整 `ImageGenerationRequest`、Provider、锚点名、attempt/max_attempts、结果 JSON 和 assetIds。
- 入队限制：单批最多 24 个任务，队列深度上限 64，必须属于同一项目；所有任务校验 project/scene id、prompt 和 Provider 能力。
- 队列 worker：应用启动即运行，600 ms 轮询；最多 2 个任务并发；用 SQLite 事务原子领取 pending 任务（`UPDATE ... WHERE status='pending'`），避免重复执行。
- 状态机：`pending → running → completed / failed / canceled / interrupted`。网络、429、5xx 等可重试错误自动重试一次（max_attempts=2）；失败、取消、中断都支持手动重试（重置 attempt）。
- 取消：pending 立即取消；running 标记取消，Provider 返回后丢弃结果并写 `canceled`，不会把已取消任务重新排队。
- 重启恢复：启动时把 running 任务转为 `interrupted` 并保留 pending；已生成素材仍在 `assets/images` 和结果 JSON 中，可人工重试。
- 事件：`image.job.changed` 携带完整任务视图（含素材 JSON）；前端队列 Hook 监听事件并回填素材库，回填前检查项目已有 assetId，避免重复；历史任务在 zustand hydration 完成后合并，避免初始示例项目覆盖真实素材判断。
- 批量界面：镜头多选（默认选中未生成素材的镜头）、每镜头 1/2/4 张、锚点开关、任务预览数量、实时队列（进行中/等待/完成/失败）、取消、重试、清理已结束。
- 批量结果与单次生成共用 `execute_image_generation`，并在素材 JSON 中写入 `consistency` 快照；因此批量产出的素材同样能判定设定漂移。

局部重绘：

- 交互：在图片上直接涂抹遮罩，笔刷 10–140 px、撤销、清空、实时遮罩覆盖率；遮罩坐标按图片归一化，窗口缩放不漂移。
- 遮罩按通道分别生成（`buildMaskCanvases` 一次产出两份，尺寸等于源图）：
  - `alphaMaskDataUrl`：不透明底 + `destination-out` 擦除笔迹，再二值化 alpha（128 阈值）。**透明 = 可重绘**，对应 OpenAI Images edits（见 4.1 修复记录）。
  - `luminanceMaskDataUrl`：黑底白笔迹。**白 = 可重绘**，对应 stable-diffusion.cpp 原生接口。
- 源图只接受项目内登记的图片素材（project.json → src → 安全相对路径 + `ensure_within` 规范化校验），不接受外部 URL。
- OpenAI Compatible：复用现有手写 multipart 构造器调用 `/images/edits`（model/prompt/n/size/image/mask），解析 b64_json 或 url，返回 `mode=openai-edits`。
- stable-diffusion.cpp：走原生 `POST /sdcpp/v1/img_gen`（`init_image` + `mask_image` + `strength`），异步任务轮询 `/sdcpp/v1/jobs/{id}`，返回 `mode=sdcpp-native-inpaint`。这条路径才真正保住遮罩外像素；`/v1/images/edits` 会把整幅重画，仅作为旧运行时的降级路径（`mode=openai-edits-fallback`，写警告日志）。
- 遮罩校验：必须是 PNG、与源图同尺寸；OpenAI 通道额外要求 alpha 通道（color type 4/6）。尺寸不一致会被明确拒绝，不会静默缩放。
- 结果作为新素材写入 `assets/images`，带 `inpaint { sourceAssetId, mode, coverage, seed, anchorLabel, fingerprint }`；不覆盖原图，可继续采用到场景或收进设定集。
- 浏览器预览无 Provider 时禁用提交；本地 SVG 草案会提示先转为位图，避免把 SVG 发给需要位图的 Provider。

边界：文字自动选区是本机高对比文字带分析（浏览器提供 `TextDetector` 时优先使用），不是 OCR，也不会返回文字内容；复杂纹理背景仍可能需要手工补画。队列并发固定为 2，未按 Provider 单独限流。稳定扩散通道要求运行时提供 `--llm_vision`（Qwen Image 2.1 的编辑需要 Qwen3-VL 视觉权重），调度器会自动发现 `mmproj*.gguf` 并传入。

### 3.15 视频素材图层与视频剪辑

- 数据模型：`Asset.kind` 增加 `video`，记录 `durationMs / width / height / bytes / mimeType`；`SceneLayer` 增加 `video` 类型与 `assetId / trimStart / trimEnd / fit / volume / muted / playbackRate / borderRadius`。
- 导入：新增 `import_project_video`，只接受 mp4/m4v/webm/mov/ogv，读取文件头校验容器与扩展名一致，拒绝大于 128 MiB 的文件；复制到 `assets/videos/{assetId}.{ext}`，返回 kmasset URL 与 bytes；前端用 `<video>` 探测时长与分辨率并回写素材。
- Remotion：新增 `videoLayerSchema`；项目素材集合纳入 video；`editorVideoLayers` 把场景视频图层编译为 `trimStartMs / trimEndMs / fit / volume / muted / playbackRate`；`SceneRenderer` 使用 `OffthreadVideo`（`trimBefore` + `durationInFrames`）渲染，Player 与 Renderer 共用同一图层；`compositionSchema` 校验引用素材必须是视频、出点必须晚于入点。
- 渲染素材注入：`hydrate_composition_assets` 把视频转成 data URL；单文件超过 24 MB 直接报错，提示压缩或裁剪，避免静默失败或把整段长视频塞进内存。
- 视频素材工作区：导入、素材库、播放器、入点/出点（可用播放头定位）、适配（裁切/完整/拉伸）、0.5–2× 速度、音量与静音、插入当前镜头或全部镜头、引用镜头跳转。
- 动画编辑器：图层栏新增视频图层按钮与类型图标；检查器可修改素材、入出点、适配、速度、音量、静音；场景预览在入点处取首帧。
- 边界：没有多轨 NLE、转场/蒙版/关键帧、代理转码和音频波形；视频图层只在场景内编辑，时间轴仍是场景级；mov 是否可解码取决于 Chrome/Remotion，导入时会提示；导入上限 128 MiB、渲染嵌入上限 24 MiB。

### 3.16 本地模型运行时

- `ensure_local_runtime` 支持 llama.cpp `b12359`、audio.cpp `v0.9.5` 和 stable-diffusion.cpp `master-1106-532d2c1`。
- 运行时按需下载到应用数据目录 `runtimes/`，不随 NSIS 安装包分发。
- 使用 `nvidia-smi` 的驱动版本和计算能力选择 CUDA 12.4、CUDA 13 或 Vulkan 归档；CUDA 通道同时下载对应运行库。选择优先级是 12.4（存量机器不重新下载）→ CUDA 13（Blackwell 唯一可用 CUDA，需驱动 ≥ R620）→ Vulkan。
- 每个归档在解压前校验固定 SHA-256，单个归档设置 1 GiB 下载上限；安装使用 staging 目录后重命名。
- GGUF Provider 通过应用拉起的 `llama-server` 执行推理，使用随机回环端口、临时 API Key、Windows Job Object 和结构化日志。
- `LocalModelScheduler` 统一管理三种本地运行时的 GPU 租约、进程状态、启动健康检查和空闲卸载；显存租约默认保留 896 MiB，并允许在 768–1024 MiB 范围内由环境变量调整。
- audio.cpp 根据 Provider 的模型路径动态生成 `max_loaded_models: 1` 配置并自动启动；stable-diffusion.cpp 从模型目录发现扩散模型、文本编码器和 VAE，以启动参数预载并等待模型 ready。
- `docs/LOCAL_MODEL_RUNTIMES.md` 已更新为实际自动启动和生命周期协议。运行时二进制就绪与模型文件就绪仍是两个独立状态。

### 3.17 真实本地服务端到端验收

- `src-tauri/src/acceptance.rs` 提供 `real_service_acceptance` 用例（`#[ignore]`，不进 CI）。它通过应用自身代码发起全部请求：`GGUF` Provider 走 `llama-server`，`OpenAI Compatible` 走 `/v1/embeddings`，`audio.cpp` Provider 由 `LocalModelScheduler` 生成配置并拉起 `audiocpp_server`，`stable-diffusion.cpp` Provider 自动发现三个模型组件并拉起 `sd-server`。
- 判定是产物级的，不是“HTTP 200”：LLM 必须产出可解析且字段完整的 JSON；Embedding 必须维度一致且语义排序成立（相关句比无关句高 0.02 以上）；TTS 必须是 `hound` 可解析且时长 > 1.5 s 的 WAV；ASR 直接识别 TTS 产物并要求字符重合率 ≥ 0.4；Image 必须返回尺寸匹配的 PNG 并记录 SHA-256。
- 实测结果（2026-11-16，RTX 5070 12 GB，全部五项一次通过）：LLM 35.9 s / 136 输入 token / 269 输出 token；Embedding 1.5 s / 768 维 / 相关 0.8213 vs 无关 0.6357；TTS 6.3 s / 8 800 ms WAV；ASR 5.6 s / 字符重合率 1.000；Image 62.7 s / 768×768 PNG 713 281 字节。
- `scripts/acceptance/install-local-runtimes.mjs` 按 `local_runtime.rs` 的固定版本与 SHA-256 安装三个运行时，避免验收依赖手工解压。`npm run acceptance:runtimes` 与 `npm run acceptance:services` 是对外入口。
- 本轮同时修掉一个真实缺陷：固定版本 CUDA 12.4 归档无法为 Blackwell（计算能力 10.x/12.x）生成 kernel，原 `cuda_available()` 只校验下限会在 RTX 50 系上选中不可用后端；当时改为按计算能力上限回退 Vulkan，并补了 `cuda_asset_selection_excludes_blackwell` 测试。第七轮后该缺陷已按根因解决：llama.cpp `b12359` 与 audio.cpp `v0.9.5` 都发布了 CUDA 13 归档（13.5 / 13.3），新增 `RuntimeAcceleration::Cuda13` 作为 12.4 与 Vulkan 之间的备选，Blackwell 且驱动 ≥ R620 时改用 CUDA 13，不再退回 Vulkan；stable-diffusion.cpp 没有发布 CUDA 13 归档，仍走 Vulkan。
- 明确的边界：本轮验收脚本自行拉起本地 Embedding 服务；其后 Embedding 已由 `LocalModelScheduler` 托管（`GGUF` Provider + `--embeddings`，见 3.9）。ASR 无时间片段（模型只返回文本与推理耗时）；局部重绘两条通道和九 Agent 全流程不在本轮范围内。

### 3.18 像素级身份验证与角色锁

- 像素引擎 `src/services/identity.ts`（纯函数，不依赖 DOM、模型或网络）：
  - 任意尺寸 RGBA 缓冲先按面积平均重采样到 64×64 工作网格。
  - 四组独立签名：8×8 单元 × 8 方向的梯度方向直方图（逐单元 L2 + 截断）、8×8 单元平均亮度（零均值单位方差）、4×4×4 RGB 直方图、256 位感知哈希（16×16 块均值中位数阈值）。
  - 人脸区域：肤色 RGB 规则与 YCbCr 规则同时成立才算皮肤，按行/列投影取外接框并校验面积与长宽比；框内取 4×4 单元 × 8 方向梯度描述子 + 皮肤平均 RGB。没有检出人脸时退回画面中心 60% 区域的同构描述子。
  - 相似度：`0.34 结构 + 0.26 人脸（或中心）+ 0.22 颜色 + 0.18 感知哈希`，各项先做线性校准再截断；判定阈值 `pass ≥ 0.70`、`warn ≥ 0.50`。
  - 多参考图合并：向量平均后重新归一化，感知哈希按位多数表决，得到角色质心；`signatureConsensus` 用两两比较暴露“参考图互相都不像”。
- 取像素与流水线 `src/services/identityPipeline.ts`：`kmasset` 素材以 `crossOrigin=anonymous` 载入 canvas，边长按 256 上限等比缩放后 `getImageData`；按 src 缓存签名。`buildCharacterIdentity` 生成质心，`verifyProjectIdentities` 逐镜头把素材签名与出场角色质心比较、取最高分，结果写入 `asset.identity`（分数、分项、是否检出人脸、角色、参考样本数、检查时间）。
- 角色锁协商 `src/services/characterLock.ts`：`controlnet / ip-adapter / img2img-reference / prompt` 四档，按协议能力协商；权重 `w` 反推强度 `clamp(0.9 - 0.6w, 0.3, 0.85)`（权重越高越贴近参考图）；多角色镜头只把权重最高的角色交给后端并给出警告；降级原因进入请求与界面。
- Rust 侧：
  - `ImageGenerationRequest` 新增 `conditioning { mode, strength, referenceAssetId, controlType, startAt, endAt, lockCount }`，由 `plan_conditioning` 再按协议校验一次，主参考图按“指定 assetId → 权重/强制参考”挑选，单张 ≤8 MiB 且通过文件头校验。
  - ControlNet / IP-Adapter 走 stable-diffusion.cpp 原生异步接口 `POST /sdcpp/v1/img_gen`（`control_image + control_strength + control_type` 或 `ip_adapter_image + ip_adapter_strength`），随后轮询 `GET /sdcpp/v1/jobs/{id}`（700 ms 间隔、900 s 上限），结果取 `result.images[].b64_json`。
  - 运行时缺少原生接口（404/405）时降级到 `POST /sdapi/v1/img2img`（`init_images` + `denoising_strength`），再降级到纯提示词；每一级降级都写入 `degradations` 并进入素材锚点快照与结构化日志。
  - `kmasset` 协议响应补充 `Access-Control-Allow-Origin: *`，让 canvas 能读取项目素材像素（仍只服务 `assets/` 下的项目内文件）。
- 界面：设定集角色卡新增「像素级身份验证与角色锁」面板（建立/重建指纹、验证全部镜头、参考一致度、逐镜头分数与分项、锁模式/控制图类型/主参考图/权重/启停、降级与警告），镜头列表直接显示 `ID xx%` 胶囊。
- 验证：`tests/identity.test.ts` 9 项（同一图 1.0、轻微位移仍通过、不同构图/纯色/条纹判不一致、人脸框居中、质心与参考一致度、阈值、版本不兼容、退化输入）；`tests/character-lock.test.ts` 8 项；`tests/image-requests.test.ts` 新增 2 项请求级断言；Rust 新增 7 项（参考图缺失降级、协议降级、控制图载荷、IP-Adapter 载荷、尺寸解析、任务图像解码、强度截断）。
- 明确的边界：
  - 这是手工设计的视觉描述子，不是训练过的人脸识别网络，也不是 CLIP 语义嵌入；它擅长发现换人/换发型/换配色/换构图这类明显漂移，阈值是经验值而非生物识别置信度。
  - ControlNet / IP-Adapter 需要运行时预先加载对应模型（control-net / ip-adapter 权重）；未加载时服务会返回错误，应用如实上报，不会静默改档。
  - 旧版 stable-diffusion.cpp 运行时没有 `/sdcpp/v1/img_gen` 时自动降级为 img2img 参考重绘。
  - 一个镜头目前只锁一个角色（权重最高者）；多人同框的多角色锁定尚未实现。
  - 本轮没有在真实 GPU 上实跑 ControlNet/IP-Adapter 采样验收，只做了载荷、协商、降级路径的自动化验证；下一次真实服务验收需要补充该项。

### 3.19 P0 修复与全流程真实验收（2026-11-17）

- 第 4.1 节（局部重绘遮罩）与 4.2 节（跨项目素材路径）两个 P1 已修复，修复细节见对应小节。
- 新增 `real_inpaint_acceptance`：合成 512×512 源图 + 竖直遮罩带，走 `execute_inpaint`，按“遮罩内/外平均像素差”判定方向而不是看 HTTP 200。stable-diffusion.cpp 通道实测遮罩内 103.5 / 遮罩外 12.7，`mode=sdcpp-native-inpaint`，54.9 s；改造前走 `/v1/images/edits` 时是 83.8 / 82.9——遮罩等于没生效。产物 `inpaint-sdcpp-{source,mask,mask-luma,result}.png` 与 `inpaint-acceptance-report.json` 在 `src-tauri/target/acceptance/`。
- 新增 `real_workflow_acceptance`：空项目 + Qwen3.8-27B（GGUF / Vulkan，上下文 16384）跑完整九 Agent DAG，自动通过三个审批节点。实测 **723 s、9 次真实 Provider 调用、全部步骤一次通过**；产出 4 段大纲、4 个镜头、4 个素材、8 条字幕、8 个时间线片段；Quality 评分 88 / `warn`（提示来源 URL 未核验、镜头 2 信息密度偏高）。报告 `workflow-acceptance-report.json`，项目快照 `workflow-acceptance-project.json`。
- 为了让全流程真的跑通，顺带修掉四个缺陷：
  1. **结构化请求没有关闭 thinking**：Qwen3 系把 6000 token 预算全花在思维链上，`content` 为空（Storyboard 连续两次 451 s / 435 s 后 `llama.cpp returned no text`）。现在 JSON 模式携带 `chat_template_kwargs.enable_thinking=false`；同一类请求从“450 s 空响应”变成“23 s / 437 token 的有效 JSON”。空响应错误同时补上 `finish_reason`、`completion_tokens`、`reasoning_chars`。
  2. **常驻 LLM 被重复要求显存余量**：工作流第二个 Agent 在“891 MiB free, 896 MiB required”上直接失败。现在同一 Provider 的 `llama-server` 已常驻时跳过余量检查（`llm_runtime_is_resident`），需要新加载模型时才检查。
  3. **本地推理固定 600 s 超时**与 6000 token 输出不匹配：改为 `max(600 s, 180 s + 150 ms × max_tokens)`，并给截断输出加明确提示。
  4. **Agent 草案 SVG 无法落盘**：草案用百分号编码 data URL，存储层只接受 base64，Asset 步骤报 `must use base64 data encoding`。草案改为 base64，存储层同时兼容百分号编码（旧项目），并补回归用例。
- 发布签名链路：新增 `scripts/release/sign-windows.ps1`（signtool + SHA-256 + RFC3161 时间戳 + 即时验签）、`build-signed.ps1`（校验凭据 → 合并 `tauri.signing.conf.json` 构建 → 校验 updater `*.sig` → 输出 SHA-256 报告）、`verify-signature.ps1`，以及 `docs/RELEASE_SIGNING.md`。签名配置**不**写进 `tauri.conf.json`：没有证书时普通构建不受影响，签名构建必须显式 `npm run desktop:build:signed`。当前无证书，尚未执行签名构建与签名后的 VM smoke。
- 仍未完成：第三方云端 Image/TTS/ASR/Embedding 的真实 Key 验收（`real_cloud_acceptance` 已写好，缺 Key 时会明确失败）、局部重绘的云端 channel、Authenticode 签名后的干净 VM 安装/卸载/离线渲染复验。

### 3.20 P1 可靠性与本地模型闭环

- 运行时 manifest 现在记录除 manifest 自身外的逐文件大小与 SHA-256；`installed_executable`、加速后端探测和 `ensure_local_runtime` 都会复验文件树、路径边界和哈希。任一文件缺失、截断、替换都会触发固定归档重下与 staging 原子替换，`RuntimeInstallResult.repairPerformed` 会告知界面。
- 手工放进 `runtimes/<id>/` 的副本（没有 manifest.json）也会被接管：找到期望的可执行文件后补算逐文件哈希，清单标记 `source: hand-placed`、`archives` 留空，归档来源未校验只记日志；之后仍按逐文件哈希严格校验。想要可验证来源用 `ensure_local_runtime(force = true)` 重下载固定归档。
- CUDA 构建缺 `cudart64_*.dll` 时，`runtime_health_issue` 会在启动前给出可读原因（audio.cpp / stable-diffusion.cpp 以 `0xc0000135` 退出；llama.cpp 退回 CPU），不再只报退出码；安装命令新增 `acceleration` 参数，界面提供「改用 Vulkan 重装」绕开本机缺失的 CUDA 运行时。
- 扩散组件发现新增平铺目录启发式：权重四件套直接放在模型目录里（没有 `diffusion_models/` 等子目录）时，按 `*vae*` / `*mmproj*` / `*t5|*clip|*vl*` 归类，剩下的最大权重当扩散主模型。
- 旧版安装路径（`scripts/acceptance/install-local-runtimes.mjs`）写的 manifest 只有归档哈希、没有逐文件列表。这类清单以前被当成「损坏」，每次使用都触发整包重新下载，网络受限时就表现为「模型都装好了、运行时一直检测失败」。现在改为一次性补算逐文件哈希并写回清单（归档哈希原本已逐字节校验过），此后按逐文件哈希严格校验；只有确需回到归档内容时才走 `ensure_local_runtime(force = true)`（界面上的「重新下载运行时 / 重装运行时」）。校验结果按 `runtime@version@installedAt` 在进程内缓存，避免每次本地请求把 100–240 MiB 文件重算一遍。
- audio.cpp 与 stable-diffusion.cpp 由应用自动拉起后不再只检查 `/health`：TTS 必须返回合法非空 WAV，ASR 必须实际处理一个 0.25 s WAV 并返回 JSON 文本字段，扩散服务必须以 256×256、1 step 完成一次 PNG 推理。smoke 只在应用自己启动进程时运行，失败会停止进程并拒绝报告模型就绪；GPU 模式通过后调度器状态显示 `gpuSmokeTested`。
- 图片与视频素材页都会扫描项目清单中的本地文件。缺失图片提供“重新生成当前资产”，尽量复用原提示词、负向词、种子和参考图，创建新素材并替换镜头、角色、场景与风格锁中的旧 assetId；没有 Image Provider 时回退到本地 SVG 候选。缺失视频提供“重新导入当前资产”，替换场景图层与时间轴中的旧 assetId。
- 局部重绘新增 0–64 px 羽化、基于本机像素的自动文字选区，以及跨面板重开的持久重绘谱系对比。历史记录由新素材的 `inpaint.sourceAssetId` 链恢复，可拖动前后分割线并继续编辑任意版本。
- `kmasset` 协议改为单独模块，支持 WebM/MOV/OGV/M4V 等完整媒体 MIME、`GET/HEAD/OPTIONS`、单段 `Range`、`206 Partial Content`、`Content-Range`、`Accept-Ranges` 与 `416`；只按请求区间读取文件，不再为了拖动播放把整段视频读入内存。缺失文件使用 `no-store`，避免恢复后继续命中旧 404 缓存。
- 自动化回归：前端新增羽化真实 alpha/luminance 像素断言、文字带选区与画笔转换测试；Rust 新增逐文件哈希/损坏路径、Range/HEAD/416/MIME 和 smoke WAV 测试。当前执行主机没有可访问的 NVIDIA 设备或本地模型，因此本轮未重跑真实 GPU 推理；既有的 RTX 5070 真实验收记录保留在 `docs/REAL_SERVICE_ACCEPTANCE.md`，下一次在 GPU 主机自动启动本地模型时会执行新的强制 smoke。

### 3.21 第七轮复验（2026-11-17，`ac67f5d`）

本轮不改功能，只把上一版审计的每一条结论对着代码和真实命令复核一遍。结论：`ac67f5d` 声称的平台完整性能力确实存在（IPC 契约生成器、SBOM/updater/签名发布工作流、修订与 ZIP 预算、诊断包、E2E 扩展都在代码里且测试覆盖），但门禁本身有一处会让流水线在第一步就红掉的缺陷。

复核结果：

- **`npm run ipc:check` 在干净工作区失败**：报 `src/generated/ipc.ts is stale`。实际内容与提交一致（`git diff --numstat` 为空），差异只在行尾——生成器写 LF，而 Windows 默认 `core.autocrlf=true` 检出为 CRLF，比较用的却是逐字节相等。该命令是 `test.yml` 与 `release.yml` 的**第一道门禁**，因此在本机默认 Git 配置下必然先于任何测试失败。已修（4.10）：比较前归一化 CRLF→LF，CRLF 与 LF 两种工作区都实测通过。
- **前端存在调用不存在命令的死代码**：`getDesktopStoragePath()` 调用 `desktop_storage_path`，`generate_handler!` 里没有该命令，异常被 `catch` 吞掉后永远返回 `null`，且该函数没有任何调用方。信息本身已由 `desktop_status.storagePath` 提供。已删（4.11）。
- **云端 LLM 通路没有任何验收**：`real_cloud_acceptance` 只覆盖 Embedding / TTS / ASR / Image / Inpaint，且全部是 OpenAI Compatible 协议；Anthropic 与 Gemini 适配器只有 5 项 `parse_response` 解析级单测，没有请求体/端点/请求头的请求级测试（仓库也没有 httpmock 类依赖）。这是本轮新增的最主要剩余工作（4.12）。
- **核对后仍成立的能力**：前端调用的 44 个命令除 `desktop_storage_path` 外全部能在 `generate_handler!` 找到；E2E 脚本确实包含三道审批、真实 WAV 落盘、篡改运行时后自动修复、渲染取消与重启恢复、诊断包导出；`scripts/release/tauri.signing.conf.json` 与三个签名脚本齐备，且签名配置没有混进 `tauri.conf.json`。

本轮实跑快照（2026-11-17 19:30，Windows 11 + 本机 `core.autocrlf=true`）：

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run test:frontend` | 通过 | 51 项 |
| `npm run test:components` | 通过 | 5 个文件 / 14 项 |
| `cargo test --lib` | 通过 | 101 通过 / 0 失败 / 8 忽略（5 个 real 验收 + 2 个 GGUF + 1 个 Windows SAPI） |
| `cargo fmt --check` | 通过 | |
| `cargo clippy --all-targets --all-features -- -D warnings` | 通过 | |
| `npm run lint` | 通过 | `--max-warnings=0` |
| `npm run build` | 通过 | 主包 695.31 kB，仍有 >500 kB 分块警告 |
| `npm run ipc:check` | 修复前失败 / 修复后通过 | 4.10；LF 与 CRLF 工作区均验证 |
| 桌面 E2E | 未在本轮执行 | 需要 release 构建 + WebDriver + WebView2 环境，仍是 CI 门禁 |
| 真实本地服务 / 云端 / 签名发布 | 未在本轮执行 | 依赖 GPU 主机、云端 Key、代码签名证书 |

### 3.22 Blackwell 补齐 CUDA 13 备选（2026-11-17）

3.16 记录的缺陷在根因上解决：上游已经发布 CUDA 13 归档，应用不再让 RTX 50 系退回 Vulkan。

- 新增 `RuntimeAcceleration::Cuda13`（`manifest.json` 里记为 `acceleration: "cuda13"`）。选择顺序：CUDA 12.4 → CUDA 13 → Vulkan。12.4 排在最前，Ampere/Ada 的存量安装不会因为这次改动触发重新下载。
- 固定归档（SHA-256 取自 GitHub Release API 的 asset `digest` 字段，非估算）：

  | 运行时 | CUDA 13 归档 | 字节数 |
  |---|---|---|
  | llama.cpp b12359 | `llama-b12359-bin-win-cuda-13.5-x64.zip` / `cudart-llama-bin-win-cuda-13.5-x64.zip` | 179 546 112 / 426 314 199 |
  | audio.cpp v0.9.5 | `audio-v0.9.5-bin-windows-x64-cuda13.3.zip` / `audio-v0.9.5-cudart-windows-x64-cuda13.3.zip` | 280 869 815 / 575 457 454 |
  | stable-diffusion.cpp | 未发布，继续走 Vulkan | — |

- 门槛：`cuda_13_supports = 驱动主版本 ≥ 620 && 计算能力 ≥ 7.5`。R620 是固定归档里 CUDA 13.5 对应的驱动分支（CUDA 13.x 的 minor version compatibility 下限是 R580，13.5 的新特性要 R620，取更严的一个）；7.5 是 CUDA 13 取消 Maxwell/Pascal/Volta 离线编译后的最低架构。
- `backend_name()` 对两种 CUDA 都返回 `cuda`：`audio.cpp` 与 `stable-diffusion.cpp` 的 `--backend` 只认 `cuda`/`vulkan`，工具链版本属于安装细节，不能透传给服务器进程。
- 纯函数 `select_acceleration(has_cuda13, gpus)` 让判定可测：RTX 5070（驱动 621、算力 12.0）选 CUDA 13；同卡但驱动 R580 退回 Vulkan；Ada（算力 8.9）仍用 12.4；没有 CUDA 13 归档的运行时（stable-diffusion.cpp）继续 Vulkan；多卡时任一卡可用即可。
- 同步更新 `scripts/acceptance/install-local-runtimes.mjs`（同样的判定与固定哈希，`KNOWMOTION_RUNTIME_ACCELERATION` 增加 `cuda13`）、`docs/LOCAL_MODEL_RUNTIMES.md` 与 `README.md`。
- 回归：`cargo test --lib` 104 通过 / 8 忽略（新增 3 项：归档固定、选择逻辑、清单标签与 backend 名称）。
- **未完成的验证**：本机没能把这两个归档真正下载下来做端到端校验。`install-local-runtimes.mjs` 直连 GitHub release 资产连续 26 分钟没有落盘（`response.arrayBuffer()` 全程未完成），改用 `gh-proxy.com` 镜像做 8 MB Range 探测同样在 90 s 内无响应；同一时刻 `api.github.com` 通过工具链可正常访问，说明是 release 资产的下载通道在当前环境被挡，不是哈希逻辑的问题。因此上表的 SHA-256 目前只有 GitHub 上传时计算的 `digest` 这一个来源，尚未在本机用实际字节复算。正常网络下首次安装时 `install-local-runtimes.mjs` 与 `ensure_local_runtime` 都会逐字节比对，哈希若不符会直接报 `Checksum mismatch` 并停止，不会装出半成品。

## 4. 重新审计发现

> 按轮次追加：4.1–4.9 为第三轮，4.10–4.12 为第七轮（2026-11-17）。

### 4.1 P1：局部重绘遮罩语义相反

`src/utils/mask.ts` 中 `buildMaskCanvases` 先清空画布，再把用户笔迹绘制为不透明像素。OpenAI Images edits 约定透明像素表示允许修改区域、不透明像素表示保持不变；当前生成结果会让笔迹区域保持不变，并可能重绘未涂抹区域。

`src-tauri/src/capabilities.rs` 将同一遮罩直接发送给 OpenAI Compatible 和 stable-diffusion.cpp 的 `images/edits` 入口，因此两条通道都可能受影响。现有测试只覆盖覆盖率和包围盒，没有验证 RGBA 语义。

修复要求：

- 先生成不透明背景，再使用 `globalCompositeOperation = "destination-out"` 擦除笔迹；若本地服务采用不同约定，应增加独立 Adapter。
- 对涂抹点和未涂抹点断言 alpha 值。
- 修复后分别使用真实 OpenAI Compatible 和 stable-diffusion.cpp 服务验收。

修复状态：前端改为「先铺不透明底 → `destination-out` 擦出笔迹 → alpha 二值化（阈值 128）」，并额外产出亮度遮罩供本地通道使用；`tests/mask-canvas.test.ts` 用 Skia 真实 canvas 跑真实绘制路径，把 PNG 解码回来逐像素断言（涂抹处 alpha=0、其余 255、无半透明残留、光栅面积与解析覆盖率误差 < 0.02）。

真实服务验收同时暴露了第二个更严重的问题：stable-diffusion.cpp 的 `/v1/images/edits` 不遵守遮罩的保留语义——遮罩外像素也会被整幅重画（实测遮罩内外平均差 83.8 vs 82.9，等于没遮罩）。改为走原生 `/sdcpp/v1/img_gen`（`init_image` + `mask_image` + `strength`）后，同一次验收变成遮罩内 103.5、遮罩外 12.7，遮罩真正生效。因此两条通道现在是独立 Adapter，而不是共用同一个 multipart 请求。另需注意 Qwen Image 2.1 的编辑通道要求 `--llm_vision`（Qwen3-VL 视觉权重），调度器原先没有传，已改为自动发现 `mmproj*.gguf` 并注入。

### 4.2 P1：项目素材来源存在路径穿越

`src-tauri/src/storage.rs` 的 `materialize_asset` 从 `kmasset` URL 中取出 `source_project_id` 后，只校验了相对素材路径，没有对项目 ID 做相同白名单校验。`projects_root.join(source_project_id).join(relative)` 可能接受 `..`、盘符绝对路径或 UNC 路径。

攻击路径是导入经过构造的 `.knowmotion.zip`：其 `project.json` 可将素材来源指向项目目录外的已知文件；导入后触发自动保存时，文件可能被复制到新项目并随后包含在导出包中。

修复要求：

- 对 `source_project_id` 使用项目 ID 白名单校验。
- 规范化源文件与目标文件路径，并确认二者位于允许根目录内。
- 通用导入流程不接受任意跨项目 URL；跨项目复制仅允许出现在显式的“复制项目”流程。
- 增加 `..`、绝对路径、UNC 路径和符号链接回归测试。

修复状态：跨项目复制现在需要项目自带 `duplicatedFrom`，且该字段只由前端「复制项目」写入；`source_project_id` 走 `safe_component` 白名单（仅字母数字与 `-`/`_`），源文件与目标目录都经 `canonicalize` 后确认落在允许根目录内，符号链接逃逸会被拒绝。`import_project_zip` 额外调用 `sanitize_imported_sources`：删除 `duplicatedFrom`，把指向自身旧 ID 的 `kmasset` 地址改写为相对路径，指向其它项目的素材来源直接拒绝导入。回归用例 5 项：非复制流程拒绝、复制流程成功、`..`/编码斜杠/盘符/UNC 四种非法项目 ID、`..` 穿越、符号链接逃逸（无符号链接权限时跳过并打印原因）。

### 4.3 P1：远程资源校验存在 DNS 与重定向绕过（已修复）

`src-tauri/src/capabilities.rs` 的 `validate_public_url` 和 `download_image` 只拒绝字面写的 `localhost` 或私有 IP，没有解析 DNS。因此 `foo.localhost`、`127.0.0.1.nip.io` 或解析到内网地址的域名仍可能通过校验。

图片下载使用默认重定向策略，初始 URL 通过校验后可能跳转到私有地址。研究网页抓取虽然对重定向目标再次执行校验，但也只校验字面主机，无法防止 DNS 解析到内网或 DNS rebinding。

修复要求：

- 解析所有 A/AAAA 记录并拒绝非公网地址。
- 连接时固定已验证的解析结果，避免校验后 DNS rebinding。
- 禁用自动重定向，逐跳校验协议、主机、DNS 和 IP。
- 统一限制响应大小与 Content-Type。
- 增加公网域名解析到回环、私网和链路本地地址的测试。

修复状态：新增 `src-tauri/src/public_url.rs`，研究网页和图片下载共用安全抓取器。解析全部 A/AAAA 地址并拒绝任一非公网结果，使用 `resolve_to_addrs` 固定已验证地址，禁用代理和自动重定向。每个重定向跳重新执行 URL/DNS/IP 校验，限制 5 跳并检测循环；HTTPS→HTTP 降级被拒绝。响应按流读取并限制 5 MiB/25 MiB，研究正文限制可提取的 Content-Type。自动化测试覆盖 IPv4/IPv6 特殊网段、IPv4 映射/兼容形式、私网混合 DNS 结果、相对重定向、凭据 URL 和协议降级。

### 4.4 P2：本地运行时“已安装”不验证文件完整性（已修复）

`src-tauri/src/local_runtime.rs` 的 `installed_manifest` 只核对 manifest 元数据和 `is_file()`，没有校验可执行文件或周边 DLL。二进制损坏、截断或被替换后，安装入口仍可能返回 `alreadyInstalled=true`，直到实际启动模型时才失败。

manifest 中的 `executable` 相对路径也没有 canonicalize 后限制在对应 runtime 根目录内。应在安装时记录关键文件树或关键二进制哈希，并在每次启动前复验；失败时自动进入可恢复重装，而不是继续报告就绪。

修复状态：manifest 已增加 `files[]`（相对 path、bytes、SHA-256），安装完成前对运行时文件树做哈希；读取时先验证 executable 与每个文件仍 canonicalize 在 runtime 根目录内，再校验大小和哈希。旧清单（没有 `files[]`）也被视为需要修复，`ensure_local_runtime` 会从固定归档自动重装。

### 4.5 P2：视频资源服务缺少 Range 和完整 MIME（已修复）

视频导入允许 MP4/M4V/WebM/MOV/OGV，但 `kmasset` 协议处理器会一次性读取整个文件，且只映射 MP4 的 MIME。WebM/MOV/OGV 会返回 `application/octet-stream`，同时缺少 `Range`、`206 Partial Content` 和 `Accept-Ranges`。

该实现可能造成 128 MiB 文件的内存峰值，并使视频播放、拖动和重复加载行为不稳定。应增加流式 Range 响应、完整的视频 MIME 映射和缺失文件缓存策略。

修复状态：`asset_protocol.rs` 支持单段 closed/open/suffix Range、HEAD、206、416、完整媒体 MIME 与恢复友好的缺失缓存。请求有 Range 时只读取所需字节；无 Range 仍由 Tauri 协议回调返回 Vec，但播放器拖动与元数据探测不再整文件读取。

### 4.6 P2：修订快照与项目导出持续膨胀（已修复）

每次项目保存都会在 `revisions/` 下创建毫秒时间戳快照，没有内容去重或清理策略。ZIP 导出会包含全部修订，长期编辑后本地磁盘占用和项目包体积会持续增长。

修复状态：保存快照改为按项目内容 SHA-256 去重，排除只改变 `updatedAt` 的无效重复；默认保留最近 40 份、90 天且总量不超过 128 MiB，同时兼容并清理旧时间戳目录。回归覆盖无内容变化的重复保存、内容变化和数量/容量裁剪。

### 4.7 P2：ZIP 导入缺少资源预算（已修复）

`import_project_zip` 一次性读取整个包，再把每个条目的数据复制到内存；当前没有压缩包总大小、解压总大小、单文件大小或总条目预算。路径穿越和 CRC 校验已经存在，但异常包仍可能造成高内存占用。

修复状态：导入前限制压缩包为 512 MiB，读取中央目录时限制解压总量 1 GiB、单文件 256 MiB、条目数 4096；同时拒绝 ZIP64、重复/大小写碰撞路径、加密条目和声明尺寸不一致。回归使用缩小预算覆盖全部三个累计边界，失败仍会清理 staging 目录。

### 4.8 P3：Rust 质量门禁尚未闭合（已修复）

修复状态：全仓已执行 `cargo fmt`，并修复严格 Clippy 报告；测试 CI 现在要求格式、`--all-targets --all-features -D warnings` Clippy、RustSec `cargo audit`、npm audit 和 IPC 生成物一致性全部通过。

### 4.9 本轮自动化验证

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run build` | 通过 | 主包约 650 KB，存在大于 500 KB 的分块警告 |
| `npm run lint` | 通过 | `--max-warnings=0` |
| 前端单元测试 | 通过 | 23 项通过 |
| 组件测试 | 通过 | 13 项通过 |
| `cargo test` | 通过 | 50 项通过，3 项因缺少真实模型或沙箱外 Windows SAPI 环境跳过 |
| `cargo fmt --check` | 失败 | 存在多处格式差异 |
| `cargo clippy -- -D warnings` | 失败 | 6 个严格 lint 错误 |
| 桌面 E2E | 未在本轮执行 | 需要完整 release 构建与 WebDriver 环境 |
| 真实本地模型服务 | 通过 | 五项能力（LLM/Embedding/TTS/ASR/Image）在 RTX 5070 上以真实模型 + 真实运行时完成端到端验收，详见第 3.17 节 |

（上表是第三轮的历史快照，最新一次实跑见 3.21。）

### 4.10 P2：IPC 门禁对行尾敏感，Windows 默认配置下必然失败（已修复）

`src-tauri/src/bin/generate-ipc-contract.rs` 的 `check_current` 用 `actual != expected` 直接比较磁盘字符串与生成器输出。生成器始终写 LF，但 Windows 默认 `core.autocrlf=true` 会在检出时把提交的生成物转成 CRLF，于是在干净工作区上 `npm run ipc:check` 直接报 `src/generated/ipc.ts is stale`——内容其实完全一致（`git diff --numstat` 为空可证）。

影响面不小：`npm run ipc:check` 是 `.github/workflows/test.yml` 与 `release.yml` 的第一道门禁，等于在任何转换了行尾的环境里，流水线还没跑到编译就红。

修复：比较前先做 `\r\n → \n` 归一化（`normalize_line_endings`），语义仍是“生成物必须与 Rust DTO 一致”，但不再因检出策略误报。实测：把两个生成物强制改写成 CRLF 后 `ipc:check` 通过，还原为 LF 也通过。

### 4.11 P3：前端调用不存在的 `desktop_storage_path`（已修复）

`src/services/desktop.ts` 的 `getDesktopStoragePath()` 执行 `invoke("desktop_storage_path")`，而 `src-tauri/src/lib.rs` 的 `generate_handler!` 里没有这个命令，异常被 `catch` 吞掉后固定返回 `null`；该函数也没有任何调用方。同样的信息 `desktop_status` 已经以 `storagePath` / `databasePath` / `logDirectory` 返回。

修复：删除该函数，避免后续界面误以为“桌面环境拿不到存储路径”。前端命令名与 `generate_handler!` 现在一一对应（`export_project_json` 仍是只注册未调用的命令，保留给后续导出入口）。

### 4.12 P1：云端 LLM 通路没有任何验收，Anthropic/Gemini 只有解析级单测（未修复）

`src-tauri/src/acceptance.rs` 的 `real_cloud_acceptance` 覆盖 Embedding / TTS / ASR / Image / Inpaint 五项，全部走 OpenAI Compatible 协议与 `KNOWMOTION_ACCEPTANCE_OPENAI_KEY`。它**不包含 LLM 对话通路**，而九 Agent 全流程的真实验收（3.19）跑的是本机 GGUF。

同时，`src-tauri/src/agent/provider.rs` 对 Anthropic（`/v1/messages` + `anthropic-version`）与 Gemini（`models/{model}:generateContent`）只有 5 项 `parse_response` / 配置反序列化单测，没有任何请求级断言：请求体字段、端点拼接、鉴权头、错误体脱敏、超时与重试分支都没有被真实或 Mock HTTP 覆盖。仓库当前也没有 httpmock/wiremock 依赖。

风险：云端 LLM 是产品对外承诺的主要通道之一，一旦 Anthropic/Gemini 的请求体或响应解析与官方契约漂移，现有测试不会报警。

建议补法（前两步不依赖凭据）：

1. 加一个本地 Mock HTTP server（dev-dependency，或手写 tokio `net`），对 OpenAI / Anthropic / Gemini 三种协议各断言一次完整请求：方法、路径、鉴权头、`max_tokens` 与 `max_output_tokens` 映射、JSON 模式字段、错误体重试分类。
2. `real_cloud_acceptance` 增加 LLM 项（一次结构化 JSON 生成，断言可解析且计费字段存在），与现有五项并列计入 `summary.failed`。
3. 有 Key 的机器上补跑一次，结果写进 `docs/REAL_SERVICE_ACCEPTANCE.md`。

## 5. 部分实现

| 功能 | 当前状态 | 缺口 |
|---|---|---|
| 真实 AI 内容生成 | Agent、HTTP Adapter 和 GGUF 本地 Adapter 已完成；九 Agent 全流程已用本机真实 LLM 跑通 | 云端 LLM 通路无验收用例（4.12）；Anthropic/Gemini 只有解析级单测 |
| Research Agent | 来源候选、正文抓取、Embedding 与项目内检索 | 尚无搜索引擎 API、自动引用核验和跨项目知识库；抓取正文仍需人工核验 |
| 图片生成 | OpenAI Images、stable-diffusion.cpp、上传与 SVG 均可用；设定集锚点和参考图已接入；stable-diffusion.cpp 已接入 ControlNet/IP-Adapter 原生像素条件与 img2img 参考锁定；局部重绘两条通道已分别验收 | OpenAI Compatible 仍只有 prompt 级参考；ControlNet/IP-Adapter 尚无真实 GPU 采样验收；多人同框只锁一个角色 |
| 素材保存 | Data URL 与生成结果会落盘并记录哈希 | 外部远程 URL 尚未下载成本地资产 |
| TTS | SAPI、OpenAI Compatible 与 audio.cpp TTS 已接入 | audio.cpp 支持自动启动和空闲卸载；情绪/角色模板和真实服务验收仍缺 |
| 字幕 | 已知旁白与云端 ASR 听写 | ASR 依赖服务返回 segment；audio.cpp 不返回时间片段时回退按场景均分 |
| 项目保存 | debounce、项目锁、内容哈希修订去重、数量/时间/容量保留策略已接通 | 仍是项目级状态合并；文档级 revision/expectedRevision 冲突协议未启用 |
| 项目版本 | Agent 修订与保存快照 | 手动 UI 编辑没有同等全局 undo/redo 栈 |
| 项目复制 | 本地素材与项目数据可复制 | 数据库工作流/渲染历史不复制到新项目 |
| 项目导入导出 | 含素材、渲染和受保留策略约束修订的 ZIP 包 | 跨项目边界与压缩/解压/单文件/条目预算已闭合；无独立迁移工具和跨设备自动升级 |
| 本地模型运行时 | 固定版本下载 + 逐文件哈希 + 损坏自动重装；CUDA 12.4 / CUDA 13 / Vulkan 三档自动选择；统一调度器负责 GPU 租约、自动启动、启动强制 smoke、健康检查、互斥和空闲卸载 | 真实 audio.cpp/stable-diffusion.cpp 采样需在有模型权重且有 GPU 的机器上重跑一次；CUDA 13 归档尚未在本机完成下载与实跑（3.22） |
| 渲染 | 持久 Job、进度、取消、Windows Job Object、离线 runtime、验证和原子提交 | 尚无跨平台进程树容器；当前发行目标是 Windows |
| 4K/60 FPS | Composition 与 Renderer 支持参数 | 渲染页只暴露 720p/1080p 与 30 FPS，无 4K/60 入口与实测，也没有码率/显存资源限制 |
| 动画组件 | 文本、SVG、图片、图表、视频、Canvas 2D 与确定性 GSAP 已实现 | 视频仅场景内图层，无多轨剪辑、转场、蒙版；渲染嵌入上限 24 MB |
| 质量检查 | `status=fail` 在 UI 与 Rust 渲染入口双重阻断 | 没有自动修复、逐项修复按钮或可配置发布规则 |
| 错误恢复 | Agent 自动指数退避重试；App 重启安全暂停/中断；本地模型有进程和租约回收；图片队列有独立 worker | 尚无统一 `tasks` worker 消费器，`tasks` 表仍由渲染与图片队列各自消费 |
| 用量统计 | LLM token、图片数、音频时长写入 `usage_records` | 无价格表、成本估算、额度与预算限制 |
| IPC 契约 | Rust DTO 派生 JSON Schema，生成 TS DTO 与 `docs/schemas/ipc.schema.json`，CI 校验生成物（4.10 修复后门禁在 Windows 默认配置下也可用） | 项目业务对象仍有 TS 领域类型；命令参数映射尚未全部从宏自动枚举 |
| JSON Schema | Remotion Zod 与 IPC Rust DTO 分别作为可执行真源 | 设计型项目 Schema 仍保留兼容说明用途 |

## 6. 未实现

- 实际 Authenticode 证书、时间戳服务和签名 updater 私钥（构建、验签、清单、干净 VM CI 流程已就绪）。
- 第三方云端 LLM/Image/TTS/ASR/Embedding 服务（OpenAI/Anthropic/Gemini）凭据验收：本地真实服务已完成，云端仍无 Key 记录。
- 云端 LLM 的验收用例本身（4.12）：`real_cloud_acceptance` 不含对话通路，Anthropic/Gemini 也没有请求级测试。
- CLIP 语义嵌入通道（需要具备图像嵌入能力的 Provider，当前只有手工视觉描述子）、多人同框的多角色同时锁定，以及 ControlNet/IP-Adapter 在真实 GPU 上的采样验收。
- 面向手动编辑的全局 undo/redo 栈、成本/额度估算，以及 4K/60 FPS 的 UI 入口与实测（详见第 5 节）。

## 7. 与架构文档不一致的关键项

### 7.1 项目事实来源

`load_studio_state` 在读取 SQLite 状态后，会逐个用磁盘 `project.json` 覆盖内存项目并为本地素材生成受限 `kmasset` URL。因此正常重启可以导入外部修改。仍未实现文件监听；应用运行期间的外部修改需要重新加载窗口。

### 7.2 Remotion 运行方式

Rust 优先启动应用目录中的固定 `node.exe`，加载打包后的 `resources/renderer`，通过 `scripts/render-worker.ts` 输出 JSONL。开发环境才回退到仓库依赖和系统 Node。安装包已经实际包含该运行目录。

### 7.3 浏览器与 FFmpeg

构建阶段复制固定 Chrome Headless Shell、FFmpeg、FFprobe，并写入 runtime manifest 与 SHA-256。渲染服务启动时校验 bundle 内文件；缺少或不匹配会拒绝渲染。Remotion 仍可能在开发机首次准备资源时联网，正式安装包不会在渲染时下载。

### 7.4 SQLite

已实现 `schema_migrations`、`app_state`、`projects`、`providers`、`workflow_runs`、`workflow_steps`、`project_revisions`、`workflow_events`、`provider_calls`、`tasks`、`render_jobs`、`usage_records`、`artifact_refs`、`knowledge_chunks`。

迁移当前使用幂等 schema 事务和版本记录；对外仍是单用户本地应用，没有 schema downgrade。

### 7.5 Schema

Remotion 使用 Zod 强校验；项目保存由 Rust 路径/素材/身份校验和 TS 类型共同约束。`docs/schemas/*.json` 仍然只作为设计契约，尚未从 TS/Rust 模型自动生成或直接参与运行时校验。

### 7.6 本地模型运行时

架构与 README 已明确本地运行时按需下载，不以安装包分发；`docs/LOCAL_MODEL_RUNTIMES.md` 已更新自动启动、GPU 租约和空闲卸载协议。Models 页现在同时显示运行时安装结果与调度器状态，避免把“二进制已就绪”误解为“模型已加载”。

## 8. 端到端验收对照

| 验收项 | 状态 | 说明 |
|---|---|---|
| Windows 桌面启动 | 通过 | Debug 与 release EXE 均已完成启动 smoke test |
| 创建和保存项目 | 通过 | SQLite、项目目录和 JSON 已验证 |
| 配置实际 AI Provider | 本地通道通过，云端未验收 | GGUF 本地通道已实跑；云端 HTTP 路径仍缺实际 Key |
| AI 生成结构化脚本和分镜 | 通过 | 九 Agent 全流程 723 s、9 次真实 LLM 调用、三个审批节点，产出 4 镜头/8 字幕/质量报告，见 3.19 |
| 本地 GGUF 模型推理 | 通过 | Qwen3.8-27B 在 Vulkan 上完成真实结构化生成 |
| Blackwell 上的 CUDA 13 运行时 | 归档与选择逻辑就绪，未实跑 | 2026-11-17 新增 CUDA 13 备选（3.22）；归档哈希取自 GitHub `digest`，本机下载通道被挡，未完成字节级复算与实跑 |
| audio.cpp TTS/ASR | 通过 | Qwen3-TTS 合成 8.8 s 旁白，Qwen3-ASR 识别字符重合率 1.000；ASR 无时间片段 |
| stable-diffusion.cpp 图片生成/编辑 | 通过（本地通道） | 生成 768×768 PNG；局部重绘走原生 `img_gen`，遮罩内 Δ103.5 / 外 Δ12.7 |
| 至少三个动画场景预览 | 通过 | 蓝天项目 6 个场景五风格 |
| 生成真实视频 | 通过 | 60.011 秒 H.264/AAC |
| 离线 Worker smoke render | 通过 | 随包 Node/Chrome/FFmpeg 输出 966,517 字节 MP4 |
| 真实进度与取消 | 通过（E2E 覆盖） | JSONL 与 `render.progress` 已接入；桌面 E2E 已实跑“启动渲染 → 取消 → 导出诊断包”，见 `scripts/run-desktop-e2e.mjs` |
| NSIS 安装包 | 通过 | `195.97 MiB`，已包含 runtime resources |
| 重新打开继续编辑 | 通过 | SQLite 与磁盘目录均有数据 |
| 非模拟渲染进度 | 通过 | Remotion `onProgress` → Worker JSONL → Rust → Tauri event → UI |

## 9. 建议优先级

### P0：发布阻断

| # | 事项 | 状态 |
|---|---|---|
| 1 | 修复局部重绘遮罩方向，增加真实 Canvas alpha 像素测试及两条图片通道验收 | 代码与像素测试完成（`tests/mask-canvas.test.ts` 5 项）；本地通道真实服务通过，云端通道待 Key |
| 2 | 修复跨项目素材来源路径校验，禁止导入包触发项目目录外复制 | 完成（`duplicatedFrom` + 项目 ID 白名单 + canonicalize + 导入清洗，5 项回归） |
| 3 | 用实际 LLM Provider 跑通 Research → Quality | 完成（3.19：723 s / 9 次调用 / 全部一次通过） |
| 4 | 第三方云端 Image/TTS/ASR/Embedding 凭据验收 | 用例就绪（`real_cloud_acceptance`），缺真实 Key |
| 5 | 局部重绘两条通道真实服务验收 | 本地通道通过（3.19）；云端通道已并入第 4 项用例（Inpaint 项） |
| 6 | Authenticode + 签名 updater + 干净 VM 复验 | 脚本与配置就绪（`docs/RELEASE_SIGNING.md`），缺证书与干净 VM |
| 7 | 云端 LLM 通路验收 + Anthropic/Gemini 请求级测试（4.12） | 未开始；Mock 部分不依赖凭据，可先做 |

### P1：可靠性与本地模型闭环

1. 为本地运行时建立关键文件哈希、损坏检测和自动修复。**代码完成，回归通过。**
2. 对自动启动的 audio.cpp/stable-diffusion.cpp 模型完成真实 GPU smoke test。**启动强制 smoke 已完成；当前主机缺模型权重，待具备模型的环境实跑。**
3. 为素材缺失增加“重新生成当前资产”操作。**完成。**
4. 增加遮罩羽化、文本自动选区与重绘历史对比。**完成。**
5. 为 `kmasset` 增加视频 Range 和完整 MIME 支持。**完成。**

### P2：平台完整性

1. 为修订快照增加内容去重和容量/时间保留策略。**完成。**
2. 为 ZIP 导入增加压缩、解压、单文件和条目数预算。**完成。**
3. 生成 IPC TypeScript 类型与 JSON Schema，消除手工重复模型。**完成；4.10 修掉门禁的行尾误报后，该校验在 Windows 默认 Git 配置下才真正可用。**
4. 扩展桌面 E2E 到审批流、真实媒体任务、本地模型安装失败恢复和取消/重启场景。**场景已接入；本地复跑受当前主机 WebView2 GPU/DevTools 环境阻断，CI 中仍是发布门禁。**
5. 将 `cargo fmt --check`、严格 Clippy 和依赖审计纳入 CI。**完成。**
6. 增加发布 CI 日志聚合、远程诊断导出、SBOM 与 signed updater。**完成；真实签名发布仍需仓库 Secrets 中的证书与私钥。**

### P3：体验与长期债

1. 渲染页补 4K/60 FPS 入口，并给码率与显存设上限。**未开始。**
2. 手动编辑接入全局 undo/redo（当前只有 Agent 修订可撤销）。**未开始。**
3. `usage_records` 接价格表，输出成本/额度估算。**未开始。**
4. 统一 `tasks` 消费器，替换渲染与图片队列各自的 worker 逻辑。**未开始，属重构。**
5. 清理 `export_project_json` 这类只注册未调用的命令，或补上界面入口。**待决策。**
