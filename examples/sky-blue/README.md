# 天空为什么是蓝色的？MVP

该示例用于验证 KnowMotion 第一条端到端视频流程。

规格：

- 约 60 秒。
- 16:9，1920×1080，30 FPS。
- 六个场景、五种视觉风格。
- Windows Huihui 中文语音旁白。
- 内嵌字幕。
- 15 秒程序化氛围音乐，在视频时间轴中循环。
- H.264 视频与 AAC 音频。

生成旁白、音乐、Composition 和 MP4：

```bash
npm run mvp:render
```

输出：

```text
renders/sky-blue-mvp.mp4
examples/sky-blue/composition.json
examples/sky-blue/audio/*.wav
```

在桌面应用中，旁白和音乐可以通过“音频与字幕”页面重新生成。完整 MP4 可从 Remotion Studio 直接提交给 Renderer；用户修改场景后再次渲染即可更新成片。
