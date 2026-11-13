# KnowMotion AI Studio MVP 验收

## 第一条视频

- 主题：为什么天空是蓝色的？
- 时长：60 秒。
- 比例：16:9。
- 分辨率：1920×1080。
- 帧率：30 FPS。
- 风格：现代趣味科普动画。
- 场景：6 个，覆盖 cinematic、diagram、data、editorial、minimal 五种视觉策略。
- 音频：6 段 Windows Huihui 中文旁白 WAV + 15 秒循环氛围音乐。
- 字幕：逐句烧录到 Remotion Composition。

## 工作流

1. Dashboard 创建或打开项目。
2. 新项目写入 Zustand、SQLite 和独立项目目录。
3. “AI 模型”页面配置实际 Provider；Key 写入系统凭据库。
4. “Agent 工作流”运行 Research → Director → Script → Storyboard → Art → Asset → Animation → Audio → Quality。
5. 大纲、分镜和最终质量节点支持人工审批。
6. Agent 输出通过工具白名单写入项目，并保存前后修订快照。
7. “音频与字幕”生成真实 Windows 中文旁白和 WAV 音乐。
8. 字幕时间线随旁白时长更新。
9. “Remotion Studio”将项目编译为带音轨的 Composition。
10. Player 支持完整视频和单场景预览。
11. Renderer 通过同一 `KnowledgeVideo` 入口导出 H.264/AAC MP4。
12. 场景可在 Animation Editor 中修改，之后重新预览和渲染。

## 验收结果

已验证：

- `npm run build` 通过。
- `cargo test`：10 项通过；Windows SAPI 测试在桌面权限环境单独通过。
- `cargo clippy --all-targets -- -D warnings` 通过。
- Tauri Debug 可执行文件构建成功。
- 五场景 Remotion Composition Schema 校验通过。
- 六场景蓝天 MVP Composition 校验通过。
- 实际生成 6 段中文旁白 WAV。
- 实际生成 15 秒背景音乐 WAV。
- 实际渲染 60.011 秒 MP4。
- 输出流：H.264 1920×1080 30 FPS + AAC stereo。
- 音频非静音检测：mean volume -28.7 dB，max volume -5.1 dB。

产物：

- `renders/sky-blue-mvp.mp4`
- `examples/sky-blue/composition.json`
- `examples/sky-blue/audio/*.wav`

## 真实 AI Provider 验收

代码支持实际网络调用，但项目不会内置或伪造 API Key。验收真实 AI 生成时：

1. 运行 `npm run desktop:dev`。
2. 打开“AI 模型”。
3. 添加 OpenAI Compatible、Anthropic、Gemini 或 Ollama Provider。
4. 输入 API 地址、模型和 Key。
5. 点击“检测”；成功表示后端已实际请求 Provider 并解析响应。
6. 在 Agent Workflow 为每个 Agent 指定 Provider 与模型。
7. 启动工作流并完成审批。

当前机器未配置外部模型凭据，且 Ollama 未监听 `127.0.0.1:11434`，因此没有在验收中发起外部真实 LLM 请求。Provider 协议解析、密钥边界、工具白名单和结构化 Agent 输出已有自动化测试。

## 渲染运行时边界

桌面 Remotion Studio 的 MP4 按钮会把 Composition 交给本地 Node Renderer。开发构建会在项目目录中找到 Node、Remotion 和 Renderer；正式安装包仍需要把固定版本 Node、Chrome Headless Shell 和 FFmpeg 作为 Tauri sidecar/resource 一并打包，以避免依赖用户环境。
