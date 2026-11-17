# 真实本地服务端到端验收

> 执行时间：2026-11-16 23:36（GMT+8）
> 执行主机：Windows / x86_64 / NVIDIA GeForce RTX 5070 12 GB（驱动 621.24）/ Intel i5-14600KF
> 模型目录：`D:\code\KnowMotion-AI-Studio\models`
> 结论：**LLM、Embedding、TTS、ASR、Image 五项能力全部通过真实模型 + 真实运行时进程验收（5/5）。**

这份文档记录的是"服务真的跑起来了、产物真的能用"的证据，不是接口联调清单。
所有请求都由应用自身的 Rust 代码发出：`GGUF` Provider、`OpenAI Compatible` Provider、
`audio.cpp` Provider 和 `stable-diffusion.cpp` Provider，以及 `LocalModelScheduler`
的 GPU 租约与自动启动逻辑。没有任何 HTTP 请求是测试脚本手写构造的。

## 1. 验收环境与运行时

三个运行时按 `src-tauri/src/local_runtime.rs` 中固定的版本与 SHA-256 安装，
归档哈希与代码常量逐一比对通过：

| 运行时 | 版本 | 归档 SHA-256 | 后端 |
| --- | --- | --- | --- |
| llama.cpp | b12359 | `e8d18c6e…a0d5e` | Vulkan |
| audio.cpp | v0.9.5 | `6c304c9a…29e8` | Vulkan |
| stable-diffusion.cpp | master-1106-532d2c1 | `3e66222c…2ecc` | Vulkan |

加速后端选择是本次验收发现并修复的第一个真实缺陷：RTX 5070 是 Blackwell
（compute capability 12.0），而固定版本 CUDA 12.4 归档最高只能生成 9.x 的
kernel image。原来的 `cuda_available()` 只校验"驱动 ≥ 551 且计算能力 ≥ 5.0"，
因此会在 50 系显卡上选中一个实际无法执行 GPU kernel 的归档。现在
`cuda_12_4_supports()` 同时要求计算能力 < 10.0，Blackwell 自动落到 Vulkan。

实测：`llama-server --list-devices` 返回
`Vulkan0: NVIDIA GeForce RTX 5070 (11943 MiB, 11175 MiB free)`，
`audiocpp_server --list-devices` 同样识别到 Vulkan0。

## 2. 验收结果

| 能力 | 真实模型 | 协议 / 运行时 | 耗时 | 判定证据 |
| --- | --- | --- | --- | --- |
| LLM | `Qwen3.8-27B-UD-IQ2_S.gguf`（8.4 GB） | GGUF / llama.cpp | 35.9 s | 输出可解析 JSON 分镜，字段齐全（`title/narration/keywords`），4 个关键词命中"瑞利散射" |
| Embedding | `embeddinggemma-2-Q8_0.gguf` | OpenAI Compatible / llama.cpp | 1.5 s | 768 维、三向量维度一致；相关句相似度 0.8213 > 无关句 0.6357 |
| TTS | `qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf` | audio.cpp | 6.3 s | 返回合法 WAV，8 800 ms，422 444 字节，voice `serena` |
| ASR | `qwen3-asr-1.7b-q8_0.gguf` | audio.cpp | 5.6 s | 对 TTS 产出的旁白做识别，字符重合率 1.000 |
| Image | `qwen-image-2.1-turbo-Q4_K_M` + `Qwen3-VL-8B-Instruct-Q4_K_M` + `qwen_image_2.1_vae_bf16` | stable-diffusion.cpp | 62.7 s | 768×768 PNG，713 281 字节，SHA-256 `ce44a2cd…5f856`，画面为傍晚海面日落插画 |

产物落在 `src-tauri/target/acceptance/`：

```text
acceptance-report.json   完整报告（环境、运行时、逐项判定、耗时）
llm-storyboard.json      LLM 返回的原始分镜 JSON
embedding-vectors.json   维度、相关性打分与向量前 8 维
narration.wav            Qwen3-TTS 合成的中文旁白
asr-result.json          Qwen3-ASR 的识别文本与时间片段
image-scene.png          Qwen3-Image 生成的场景图
embedding-server.log     嵌入服务启动日志
```

## 3. 判定标准

判定不是"HTTP 200 就算过"，每项都有产物级校验：

- **LLM**：响应必须能 `serde_json::from_str` 解析为对象，`narration` 非空，
  `keywords` 为数组；解析失败会把截断后的原文带进失败详情。
- **Embedding**：向量维度非零且全部一致；语义排序必须成立
  （query 与相关句的余弦相似度比无关句高出 0.02 以上），否则视为"服务返回了向量但不可用"。
- **TTS**：响应必须能被 `hound` 解析为 WAV，时长 > 1.5 s，并落盘为项目内素材形态。
- **ASR**：直接吃上一步 TTS 的 WAV，形成闭环；识别文本非空且与原旁白字符重合率 ≥ 0.4。
- **Image**：返回 PNG 签名与 IHDR，宽高必须等于请求尺寸，并记录字节数与 SHA-256。

## 4. 过程中发现的三处真实问题

1. **Blackwell 加速后端误判**（已修复）：见第 1 节，新增
   `local_runtime::tests::cuda_asset_selection_excludes_blackwell`。
2. **OpenAI Compatible 嵌入路径必须带版本前缀**：`request_embeddings` 请求
   `{base}/embeddings`。本地 llama.cpp 的 `/embeddings` 是 legacy 形态
   （裸数组 `[{"index":0,"embedding":[[…]]}]`），只有 `/v1/embeddings` 才返回
   `{"data":[{"embedding":[…]}]}`。原来的错误信息只有一句
   "Embedding response has no data"，无法定位。现在错误信息会带回实际响应结构，
   验收 Provider 也改成与其它 OpenAI 兼容调用一致的 `/v1` 基址。
3. **audio.cpp 的模型 id / family 必须与 GGUF 内嵌 family 完全一致**：
   配置里写 `family: "qwen3-tts"` 会被服务拒绝
   （`GGUF embeds model spec for family 'qwen3_tts', not 'qwen3-tts'`）。
   验收配置改用 `qwen3_tts` / `qwen3_asr`，与 `docs/LOCAL_MODEL_RUNTIMES.md`
   的示例保持一致。

## 5. 已知限制（不影响本次结论）

- **ASR 没有时间片段**：Qwen3-ASR 的 `/v1/audio/transcriptions/details` 只返回
  `{text, language, timing}`，`timing` 是推理耗时而非语音时间戳，因此
  `cues` 为 0，字幕仍走"按场景均分"的回退路径。要拿到逐句时间轴需要
  audio.cpp 的 `qwen3_forced_aligner_0_6b` 强制对齐模型，本机未下载。
- **Embedding 服务由验收脚本拉起**：应用的 `LocalModelScheduler` 目前只托管
  LLM（llama.cpp 对话）、audio.cpp 和 diffusion 三类工作负载，没有"本地
  Embedding 服务"的自动启动入口。验收里嵌入服务由一个受管子进程按
  `llama-server --embeddings` 启动，应用的 Embedding Provider 仍然走真实的
  `/v1/embeddings` 代码路径。把本地嵌入纳入调度器是后续待办。
- **只验收了文生图**：局部重绘两条通道不在本轮（已被第七节的独立验收补齐，本地通道通过，云端通道待 Key）。
- **没有跑完九 Agent 全流程**：本轮验证的是 Provider 能力（已被第七节补齐）。

## 6. 复现步骤

```bash
# 1. 安装三个固定版本运行时（校验 SHA-256 后解压到应用数据目录）
node scripts/acceptance/install-local-runtimes.mjs

# 2. 跑真实服务验收（默认全部五项，约 2 分钟）
npm run acceptance:services

# 只跑其中几项
KNOWMOTION_ACCEPTANCE_ONLY=TTS,ASR npm run acceptance:services

# 换模型目录 / 输出目录 / 图片尺寸
KNOWMOTION_ACCEPTANCE_MODELS=D:/models \
KNOWMOTION_ACCEPTANCE_OUT_DIR=D:/out \
KNOWMOTION_ACCEPTANCE_IMAGE_SIZE=512x512 \
npm run acceptance:services
```

验收用例是 `src-tauri/src/acceptance.rs` 中的 `real_service_acceptance`，
带 `#[ignore]`，不会拖慢普通 `cargo test`。它依赖真实模型、真实运行时和一块
能跑 Vulkan 的 GPU，因此不进 CI。

## 7. 局部重绘与九 Agent 全流程（2026-11-17）

两项 P0 验收都用 `#[ignore]` 的独立用例，走应用自身代码路径，不是脚本手写 HTTP。

### 7.1 局部重绘（`real_inpaint_acceptance`）

合成一张 512×512 棋盘格源图（左右两半色相不同）+ 竖直遮罩带（可重绘区为 x∈[170,341)），
直接调用 `execute_inpaint`，再把返回的 PNG 解码成像素，比较**遮罩内**与**遮罩外**的平均绝对差：

| 通道 | 走法 | 遮罩内 Δ | 遮罩外 Δ | 耗时 | 判定 |
| --- | --- | --- | --- | --- | --- |
| stable-diffusion.cpp | `/sdcpp/v1/img_gen`（init_image + 亮度遮罩 + strength=1.0） | **103.5** | 12.7 | 54.9 s | 通过 |
| OpenAI Compatible | `/images/edits`（alpha 遮罩） | — | — | — | 缺 Key，标记 skipped |

对照组说明问题所在：同一张图、同一份遮罩，改造前走 `/v1/images/edits` 时是
**遮罩内 83.8 / 遮罩外 82.9**——遮罩内外被同等重画，等于遮罩没生效。现在两条通道各自适配
遮罩方向（OpenAI：透明=重绘；stable-diffusion.cpp：白=重绘），不再共用同一个请求。

### 7.2 九 Agent 全流程（`real_workflow_acceptance`）

空项目 + `Qwen3.8-27B-UD-IQ2_S`（GGUF / Vulkan / ctx 16384），`AgentRuntime` 直接驱动
完整 DAG，三个审批节点自动通过，判定看数据库与项目产物：

| 指标 | 实测 |
| --- | --- |
| Run 状态 | `completed` |
| 总耗时 | 723 s（12.1 分钟，含模型加载与三次审批） |
| Provider 调用 | 9 次，全部成功；所有步骤 `attempt=1` |
| 产出 | 4 段大纲、4 个镜头、4 个本地素材、8 条字幕、8 个时间线片段 |
| Quality Agent | 评分 88，`warn`（来源 URL 未核验、镜头 2 信息密度偏高） |
| 事件 | 23 条 workflow_events |

单步耗时：research 33.7 s、director 30.5 s、script 45.5 s、storyboard 65.5 s、
art_director 85.7 s、asset 33.7 s、animation 177.4 s、audio 61.4 s。

### 7.3 这轮验收暴露并修复的缺陷

1. **思考链吃光 token**：Qwen3 系默认 thinking，结构化请求的 6000 token 全花在推理上，
   `content` 为空（Storyboard 两次 451 s / 435 s 后报 `returned no text`）。关闭
   `enable_thinking` 后同一类请求 23 s 返回 437 token 的有效 JSON。
2. **常驻 LLM 被要求显存余量**：第二个 Agent 在 891 MiB / 896 MiB 上失败。已常驻的
   Provider 现在跳过余量检查。
3. **固定 600 s 推理超时**：与 6000 token 输出不匹配；改为按 `max_tokens` 缩放。
4. **Agent 草案 SVG 无法落盘**：草案用百分号编码 data URL，存储层只收 base64。草案改为
   base64，存储层同时兼容百分号编码。

## 8. 复现（P0 新增项）

```bash
npm run acceptance:inpaint    # 局部重绘，需要本机 stable-diffusion.cpp 运行时
npm run acceptance:workflow   # 九 Agent 全流程，需要本机 GGUF 模型

# 云端通道（需要真实 Key）
KNOWMOTION_ACCEPTANCE_OPENAI_KEY=sk-... npm run acceptance:cloud
```
