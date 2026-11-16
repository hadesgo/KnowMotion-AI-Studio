# KnowMotion AI Studio 实现审计

> 审计更新：2026-11-16（第三轮重新审计 + 第四轮真实服务验收，基线提交 `c327fd7`；第五轮补充像素级身份验证与角色锁，基线提交 `9df7669`）
>
> 基线：原始《项目开发总提示词》、`docs/ARCHITECTURE.md`、`docs/AGENT_WORKFLOW.md`、`docs/REMOTION_ENGINE.md`、`docs/MVP_ACCEPTANCE.md`、`docs/LOCAL_MODEL_RUNTIMES.md` 及最新运行时代码。
> 判定原则：代码、持久化数据、自动化测试或真实产物可证明的，才算已实现；只有 UI、提示词或设计文档的不算。

## 1. 总体结论

截至 `c327fd7`，应用已经具备一条可运行的知识动画制作主线：

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

仍未覆盖的是第三方云端凭据路径（OpenAI/Anthropic/Gemini）与九 Agent 全流程实跑；云端通道目前依然只有实现与单元测试，没有真实 Key 的在线记录。

**发布判断：不通过。** 基础工程可构建，原有主链路测试基本健康，但第三轮审计发现 3 个 P1 问题：局部重绘遮罩语义相反、跨项目素材复制存在本地文件路径穿越、远程 URL 私网/DNS/重定向校验不完整。修复并完成对应回归测试前，不应将当前版本判定为发布级完成。

## 2. 阶段完成度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：Tauri 桌面框架 | 完成 | 窗口、React、Zustand、WebView、SQLite 迁移、项目锁、目录、Provider 配置和 NSIS 构建已接通 |
| Phase 2：AI 内容创作 | 框架完成，真实调用待验收 | 九个 Agent、DAG 和 GGUF 本地通道已实现；没有执行外部真实 LLM 端到端测试 |
| Phase 3：素材生成 | 部分完成 | 本地 SVG、图片导入、OpenAI Images、stable-diffusion.cpp、文件落盘与清单已实现；局部重绘遮罩方向存在 P1 缺陷 |
| Phase 4：Remotion 动画 | 主体完成 | Scene DSL、组件库、Player、单场景和整片预览可用 |
| Phase 5：音频和渲染 | 完成工程闭环 | SAPI/OpenAI Compatible/audio.cpp TTS、ASR、字幕、音乐、持久渲染 Job、离线 sidecar、进度、取消、验证和安装包已实现；本地服务生命周期、GPU 租约和空闲卸载已托管 |
| Phase 6：完整 AI 工作流 | 大部分完成 | 审批、局部重跑、自动重试、自然语言场景 Patch、图片/TTS/ASR/RAG/网页正文入口已实现；真实外部服务尚未在线验收 |
| Phase 7：本地模型运行时 | 部分完成 | 三种 GGUF 类运行时支持按需下载、固定版本和归档校验；正式模型包、服务自动启动、显存租约和空闲卸载仍未闭环 |

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
- 前端当前生成透明底、笔迹不透明的 PNG 遮罩；后端只接受 data URL、PNG、1 B–8 MiB。该方向与 OpenAI Images edits 的“透明区域可编辑”约定相反，已列为 P1，参见第 4.1 节。
- 源图只接受项目内登记的图片素材（project.json → src → 安全相对路径），不接受外部 URL。
- OpenAI Compatible：复用现有手写 multipart 构造器调用 `/images/edits`（model/prompt/n/size/image/mask），解析 b64_json 或 url，返回 `mode=openai-edits`。
- stable-diffusion.cpp 与外部 API 都使用 multipart `images/edits`，源图与遮罩在内存中构造后提交；两条通道都需要在遮罩语义修复后重新做真实服务验收。
- 结果作为新素材写入 `assets/images`，带 `inpaint { sourceAssetId, mode, coverage, seed, anchorLabel, fingerprint }`；不覆盖原图，可继续采用到场景或收进设定集。
- 浏览器预览无 Provider 时禁用提交；本地 SVG 草案会提示先转为位图，避免把 SVG 发给需要位图的 Provider。

边界：当前遮罩语义错误；没有遮罩羽化/软边、没有文本自动生成遮罩、没有局部重绘历史对比；队列并发固定为 2，未按 Provider 单独限流；OpenAI 局部重绘的实际可用性仍取决于服务端是否支持 `images/edits`，当前无在线验收记录。

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
- 使用 `nvidia-smi` 的驱动版本和计算能力选择 CUDA 12.4 或 Vulkan 归档；CUDA 通道同时下载对应运行库。
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
- 本轮同时修掉一个真实缺陷：固定版本 CUDA 12.4 归档无法为 Blackwell（计算能力 10.x/12.x）生成 kernel，原 `cuda_available()` 只校验下限会在 RTX 50 系上选中不可用后端；现在按计算能力上限选择 Vulkan，并补了 `cuda_asset_selection_excludes_blackwell` 测试。
- 明确的边界：本地 Embedding 服务仍由验收脚本拉起，调度器没有托管这一类工作负载；ASR 无时间片段（模型只返回文本与推理耗时）；局部重绘两条通道和九 Agent 全流程不在本轮范围内。

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

## 4. 第三轮重新审计发现

### 4.1 P1：局部重绘遮罩语义相反

`src/utils/mask.ts` 中 `buildMaskCanvases` 先清空画布，再把用户笔迹绘制为不透明像素。OpenAI Images edits 约定透明像素表示允许修改区域、不透明像素表示保持不变；当前生成结果会让笔迹区域保持不变，并可能重绘未涂抹区域。

`src-tauri/src/capabilities.rs` 将同一遮罩直接发送给 OpenAI Compatible 和 stable-diffusion.cpp 的 `images/edits` 入口，因此两条通道都可能受影响。现有测试只覆盖覆盖率和包围盒，没有验证 RGBA 语义。

修复要求：

- 先生成不透明背景，再使用 `globalCompositeOperation = "destination-out"` 擦除笔迹；若本地服务采用不同约定，应增加独立 Adapter。
- 对涂抹点和未涂抹点断言 alpha 值。
- 修复后分别使用真实 OpenAI Compatible 和 stable-diffusion.cpp 服务验收。

### 4.2 P1：项目素材来源存在路径穿越

`src-tauri/src/storage.rs` 的 `materialize_asset` 从 `kmasset` URL 中取出 `source_project_id` 后，只校验了相对素材路径，没有对项目 ID 做相同白名单校验。`projects_root.join(source_project_id).join(relative)` 可能接受 `..`、盘符绝对路径或 UNC 路径。

攻击路径是导入经过构造的 `.knowmotion.zip`：其 `project.json` 可将素材来源指向项目目录外的已知文件；导入后触发自动保存时，文件可能被复制到新项目并随后包含在导出包中。

修复要求：

- 对 `source_project_id` 使用项目 ID 白名单校验。
- 规范化源文件与目标文件路径，并确认二者位于允许根目录内。
- 通用导入流程不接受任意跨项目 URL；跨项目复制仅允许出现在显式的“复制项目”流程。
- 增加 `..`、绝对路径、UNC 路径和符号链接回归测试。

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

### 4.4 P2：本地运行时“已安装”不验证文件完整性

`src-tauri/src/local_runtime.rs` 的 `installed_manifest` 只核对 manifest 元数据和 `is_file()`，没有校验可执行文件或周边 DLL。二进制损坏、截断或被替换后，安装入口仍可能返回 `alreadyInstalled=true`，直到实际启动模型时才失败。

manifest 中的 `executable` 相对路径也没有 canonicalize 后限制在对应 runtime 根目录内。应在安装时记录关键文件树或关键二进制哈希，并在每次启动前复验；失败时自动进入可恢复重装，而不是继续报告就绪。

### 4.5 P2：视频资源服务缺少 Range 和完整 MIME

视频导入允许 MP4/M4V/WebM/MOV/OGV，但 `kmasset` 协议处理器会一次性读取整个文件，且只映射 MP4 的 MIME。WebM/MOV/OGV 会返回 `application/octet-stream`，同时缺少 `Range`、`206 Partial Content` 和 `Accept-Ranges`。

该实现可能造成 128 MiB 文件的内存峰值，并使视频播放、拖动和重复加载行为不稳定。应增加流式 Range 响应、完整的视频 MIME 映射和缺失文件缓存策略。

### 4.6 P2：修订快照与项目导出持续膨胀

每次项目保存都会在 `revisions/` 下创建毫秒时间戳快照，没有内容去重或清理策略。ZIP 导出会包含全部修订，长期编辑后本地磁盘占用和项目包体积会持续增长。

建议按内容哈希去重，并增加按数量、时间或总容量的保留策略；项目包可以选择只携带最近若干修订。

### 4.7 P2：ZIP 导入缺少资源预算

`import_project_zip` 一次性读取整个包，再把每个条目的数据复制到内存；当前没有压缩包总大小、解压总大小、单文件大小或总条目预算。路径穿越和 CRC 校验已经存在，但异常包仍可能造成高内存占用。

建议在读取前检查元数据，在解压过程中累计限制压缩大小、解压大小和条目数，并在失败时清理 staging 目录。

### 4.8 P3：Rust 质量门禁尚未闭合

本轮执行 `cargo fmt --all -- --check` 失败，`cargo clippy --all-targets -- -D warnings` 报告 6 个错误。当前 CI 主要运行 `cargo test`，没有把格式和严格 Clippy 作为合并门禁。

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

## 5. 部分实现

| 功能 | 当前状态 | 缺口 |
|---|---|---|
| 真实 AI 内容生成 | Agent、HTTP Adapter 和 GGUF 本地 Adapter 已完成 | 当前无外部服务凭据，未完成真实外部模型端到端验收；本地 GGUF 实机测试默认忽略 |
| Research Agent | 来源候选、正文抓取、Embedding 与项目内检索 | 尚无搜索引擎 API、自动引用核验和跨项目知识库；抓取正文仍需人工核验 |
| 图片生成 | OpenAI Images、stable-diffusion.cpp、上传与 SVG 均可用；设定集锚点和参考图已接入；stable-diffusion.cpp 已接入 ControlNet/IP-Adapter 原生像素条件与 img2img 参考锁定 | 局部重绘遮罩语义待修复；OpenAI Compatible 仍只有 prompt 级参考；ControlNet/IP-Adapter 尚无真实 GPU 采样验收 |
| 素材保存 | Data URL 与生成结果会落盘并记录哈希 | 外部远程 URL 尚未下载成本地资产 |
| TTS | SAPI、OpenAI Compatible 与 audio.cpp TTS 已接入 | audio.cpp 支持自动启动和空闲卸载；情绪/角色模板和真实服务验收仍缺 |
| 字幕 | 已知旁白与云端 ASR 听写 | ASR 依赖服务返回 segment；无时间片段时回退按场景均分 |
| 项目保存 | debounce、项目锁、文档和修订目录已接通 | 仍是项目级状态合并；修订无去重/保留策略；文档级 revision/expectedRevision 冲突协议未启用 |
| 项目版本 | Agent 修订与保存快照 | 手动 UI 编辑没有同等全局 undo/redo 栈 |
| 项目复制 | 本地素材与项目数据可复制 | 数据库工作流/渲染历史不复制到新项目 |
| 项目导入导出 | 含素材、渲染和修订的 ZIP 包 | 跨项目素材来源边界待加固；ZIP 导入缺少资源预算；无独立迁移工具和跨设备自动升级 |
| 本地模型运行时 | 三种运行时支持固定版本下载；统一调度器负责 GPU 租约、自动启动、健康检查、互斥和空闲卸载 | 安装后完整性复验偏弱；真实 audio.cpp/stable-diffusion.cpp 模型仍需实机验收 |
| 渲染 | 持久 Job、进度、取消、Windows Job Object、离线 runtime、验证和原子提交 | 尚无跨平台进程树容器；当前发行目标是 Windows |
| 4K/60 FPS | Composition 与 Renderer 支持参数 | UI 只验证了 1080P；没有 4K/60 实测和资源限制 |
| 动画组件 | 文本、SVG、图片、图表、视频、Canvas 2D 与确定性 GSAP 已实现 | 视频仅场景内图层，无多轨剪辑、转场、蒙版；渲染嵌入上限 24 MB |
| 质量检查 | `status=fail` 在 UI 与 Rust 渲染入口双重阻断 | 没有自动修复、逐项修复按钮或可配置发布规则 |
| 错误恢复 | Agent 自动指数退避重试；App 重启安全暂停/中断；本地模型有进程和租约回收 | 尚无统一 `tasks` worker 消费器 |
| 用量统计 | LLM token、图片数、音频时长写入 `usage_records` | 无价格表、成本估算、额度与预算限制 |
| IPC 契约 | Rust/TS 手工定义对应类型 | 没有使用 Specta/Tauri Specta 自动生成 |
| JSON Schema | 有设计用 Schema 文件 | 与运行时 TS/Rust 模型没有自动生成关系，存在重复定义 |

## 6. 未实现

- Authenticode 签名、时间戳和 signed updater。
- 第三方云端 LLM/Image/TTS/ASR/Embedding 服务（OpenAI/Anthropic/Gemini）凭据验收：本地真实服务已完成，云端仍无 Key 记录。
- CLIP 语义嵌入通道（需要具备图像嵌入能力的 Provider，当前只有手工视觉描述子）、多人同框的多角色同时锁定，以及 ControlNet/IP-Adapter 在真实 GPU 上的采样验收。

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
| AI 生成结构化脚本和分镜 | Provider 层通过 | Qwen3.8-27B 产出可解析分镜 JSON；九 Agent 完整编排仍未实跑 |
| 本地 GGUF 模型推理 | 通过 | Qwen3.8-27B 在 Vulkan 上完成真实结构化生成 |
| audio.cpp TTS/ASR | 通过 | Qwen3-TTS 合成 8.8 s 旁白，Qwen3-ASR 识别字符重合率 1.000；ASR 无时间片段 |
| stable-diffusion.cpp 图片生成/编辑 | 生成通过，编辑未验收 | Qwen Image 2.1 生成 768×768 PNG；局部重绘仍受遮罩语义 P1 阻断 |
| 至少三个动画场景预览 | 通过 | 蓝天项目 6 个场景五风格 |
| 生成真实视频 | 通过 | 60.011 秒 H.264/AAC |
| 离线 Worker smoke render | 通过 | 随包 Node/Chrome/FFmpeg 输出 966,517 字节 MP4 |
| 真实进度与取消 | 实现，进行中验收 | JSONL 与 `render.progress` 已接入；完整片长取消只在代码路径验证 |
| NSIS 安装包 | 通过 | `195.97 MiB`，已包含 runtime resources |
| 重新打开继续编辑 | 通过 | SQLite 与磁盘目录均有数据 |
| 非模拟渲染进度 | 通过 | Remotion `onProgress` → Worker JSONL → Rust → Tauri event → UI |

## 9. 建议优先级

### P0：发布阻断

1. 修复局部重绘遮罩方向，并增加真实 Canvas alpha 像素测试及两条图片通道验收。
2. 修复跨项目素材来源的路径校验，禁止导入包触发项目目录外文件复制。
3. 使用实际 LLM Provider 完成一次 Research → Quality 全流程验收（本地 Provider 能力已验收，工作流编排未跑）。
4. 为第三方云端 Image/TTS/ASR/Embedding 补充凭据验收；本地真实服务 smoke test 已完成。
5. 完成局部重绘两条通道的真实服务验收。
6. 配置 Authenticode、签名 updater，并重新执行干净 Windows VM 安装/卸载/离线渲染验收。

### P1：可靠性与本地模型闭环

1. 为本地运行时建立关键文件哈希、损坏检测和自动修复。
2. 对自动启动的 audio.cpp/stable-diffusion.cpp 模型完成真实 GPU smoke test。
3. 为素材缺失增加“重新生成当前资产”操作。
4. 增加遮罩羽化、文本自动选区与重绘历史对比。
5. 为 `kmasset` 增加视频 Range 和完整 MIME 支持。

### P2：平台完整性

1. 为修订快照增加内容去重和容量/时间保留策略。
2. 为 ZIP 导入增加压缩、解压、单文件和条目数预算。
3. 生成 IPC TypeScript 类型与 JSON Schema，消除手工重复模型。
4. 扩展桌面 E2E 到审批流、真实媒体任务、本地模型安装失败恢复和取消/重启场景。
5. 将 `cargo fmt --check`、严格 Clippy 和依赖审计纳入 CI。
6. 增加发布 CI 日志聚合、远程诊断导出、SBOM 与 signed updater。
