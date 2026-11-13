# Remotion 程序化动画引擎

## 1. 架构

```mermaid
flowchart LR
    AI[AI Storyboard / Animation Agent] --> Scene[Scene JSON]
    Scene --> Zod[Zod Scene & Composition Schema]
    Zod --> Compiler[Project → Composition Compiler]
    Compiler --> DSL[Composition DSL]
    DSL --> Player[@remotion/player]
    DSL --> Root[Remotion Root]
    Root --> Renderer[@remotion/renderer]
    Renderer --> MP4[H.264 MP4]
```

AI 不生成新的 React 项目或任意 Remotion 代码。AI 和项目编辑器只产生结构化场景数据，统一编译器把场景转换为 Composition DSL，再由固定组件库解释。

## 2. Scene Schema

`SceneDsl` 包含：

- `schemaVersion`、`id`、`title`、`narration`。
- `styleVariant`：`cinematic`、`diagram`、`data`、`editorial`、`minimal`。
- `durationMs`。
- `background`：渐变或纯色、颜色、角度、暗角。
- `camera`：起始和结束的缩放、X/Y 平移与 easing。
- `transition`：`fade`、`slide`、`wipe`、`iris`。
- `layers`：受控图层数组。

所有生成数据由 `src/remotion/schema.ts` 使用 Zod 校验。非法组件类型、时间范围、颜色、素材引用或重复 ID 会被拒绝。

## 3. 图层类型

| 类型 | 参数 | 动画能力 |
|---|---|---|
| `text` | 内容、字号、字重、颜色、对齐、字距 | fade、fadeUp、slideIn、scaleIn、typewriter |
| `svg` | 轨道、波形、网格、粒子、进度环 | 路径绘制、旋转、波形运动、粒子环绕 |
| `image` | `assetId`、cover/contain、圆角、调色 | 淡入、缩放、镜头运动 |
| `chart` | bar、line、donut 与结构化数据 | 柱高增长、折线绘制、环形进度 |

每个图层有独立的 `fromMs` / `toMs` 时间范围、透明度、位置、尺寸、旋转和动画参数。

## 4. Composition Schema

```ts
interface CompositionDsl {
  schemaVersion: "1.0";
  id: string;
  title: string;
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 50 | 60;
  durationInFrames: number;
  assets: CompositionAsset[];
  audioTracks: AudioTrack[];
  scenes: SceneDsl[];
}
```

语义校验额外保证：

- Composition 帧数与场景时长一致。
- 场景 ID 不重复。
- 图片图层引用的 `assetId` 存在。
- 音轨引用的音频素材存在，且不超出 Composition 时长。
- 图层时间不超过场景时长。
- 场景和图层数量受限。

## 5. 组件库

- `KnowledgeComposition`：多场景连续时间轴。
- `SceneStage`：单场景背景、镜头、图层和转场。
- `TextRenderer`：文字动画。
- `SvgRenderer`：程序化 SVG。
- `ImageRenderer`：使用 Remotion `Img` 加载本地或生成素材。
- `ChartRenderer`：数据可视化。
- `AnimationShell`：统一图层入场和透明度。

同一组组件同时服务 Player 和 Renderer，避免预览与成片使用两套实现。

## 6. Player

`RemotionPlayer` 支持：

- 完整 Composition 连续播放。
- 单场景独立播放。
- Play/Pause、回到开头、静音、全屏。
- Remotion Player 自带帧级时间控制。

入口：项目侧栏的 **Remotion Studio**。

## 7. 完整视频渲染

Remotion 入口：`src/remotion/index.ts`，Composition ID 为 `KnowledgeVideo`。

渲染：

```bash
npm run remotion:render -- --composition composition.json --out renders/video.mp4
```

不传 `--composition` 时渲染内置的五场景知识动画示例。

渲染流程：

1. `@remotion/bundler` 打包固定入口。
2. `selectComposition` 校验并读取 Composition。
3. `renderMedia` 使用 H.264 逐帧渲染。
4. 输出 MP4。

项目内验证产物：`renders/knowledge-demo.mp4`。

## 8. 示例项目

示例主题为“为什么夜空是黑色的？”，包含五个不同视觉策略：

1. 电影感开场：图片、轨道 SVG、镜头缓慢推进。
2. 信息图解释：网格、波形与结构化说明。
3. 数据揭示：柱状/折线图与数据动画。
4. 编辑部画面：图片、文字层级与暗角。
5. 极简收束：轨道、短文案和圆形转场。

运行 `npm run remotion:validate` 会检查至少三种风格以及 text、SVG、image、chart 四类图层是否都存在。

## 9. 发布注意

Remotion 的公司与团队使用许可需在商业发布前单独确认。产品代码不代替最终许可证审阅；随应用发布的 Chrome Headless Shell 和 FFmpeg 也需要保留对应许可证与版本清单。

## 10. 第一条端到端视频

“为什么天空是蓝色的？”项目规格：

- 16:9，1920×1080，30 FPS，约 60 秒。
- 六场景、五种视觉策略。
- Windows Huihui 中文语音生成逐场景 WAV 旁白。
- 本地程序化氛围音乐，可在完整时间轴循环。
- Player 内置字幕、旁白与背景音乐。
- H.264/AAC MP4 真实渲染。
