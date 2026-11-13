import type {
  AspectRatio,
  CreateProjectInput,
  OutlineSection,
  Scene,
  TimelineClip,
  VideoProject,
} from "../types";
import { makeId, nowIso } from "../utils";

const accents = ["#c8ff65", "#79a9ff", "#ffbc66", "#9de7d7", "#a78bfa"];

export const contentTypes = [
  "知识科普",
  "科学原理",
  "技术解析",
  "历史故事",
  "自然科学",
  "AI 技术",
];

export const visualStyles = [
  "编辑部极简",
  "电影感纪录片",
  "干净信息图",
  "复古科学杂志",
  "未来主义数据",
];

export function createLayer(
  type: "text" | "shape" | "canvas",
  index = 0,
): Scene["layers"][number] {
  if (type === "canvas") {
    return {
      id: makeId("layer"),
      type,
      name: `Canvas 动画 ${index + 1}`,
      content: "",
      x: 48,
      y: 8,
      width: 44,
      height: 46,
      opacity: 0.9,
      start: 0,
      end: 100,
      color: "#79a9ff",
      secondaryColor: "#c8ff65",
      fontSize: 42,
      canvasVariant: "particleFlow",
      density: 64,
      speed: 1,
      lineWidth: 1.8,
      intensity: 0.85,
      seed: index * 997 + 41,
    };
  }
  return {
    id: makeId("layer"),
    type,
    name: type === "text" ? `文字图层 ${index + 1}` : `图形图层 ${index + 1}`,
    content: type === "text" ? "新的画面文字" : "",
    x: type === "text" ? 12 : 68,
    y: type === "text" ? 64 : 20,
    width: type === "text" ? 62 : 20,
    height: type === "text" ? 18 : 20,
    opacity: 1,
    start: 0,
    end: 100,
    color: type === "text" ? "#f3f7f4" : "#c8ff65",
    fontSize: 42,
    shape: type === "shape" ? "circle" : undefined,
  };
}

export function createScene(
  title: string,
  narration: string,
  duration = 5,
  index = 0,
): Scene {
  const accent = accents[index % accents.length];
  return {
    id: makeId("scene"),
    title,
    narration,
    description: `用清晰的视觉层级解释「${title}」，让关键信息在 2 秒内被识别。`,
    visualPrompt: `Editorial knowledge animation about ${title}, dark teal atmosphere, precise scientific detail, cinematic composition`,
    shotType: index === 0 ? "Hook" : "Explainer",
    transition: index % 2 === 0 ? "柔光淡入" : "横向推移",
    duration,
    accent,
    layers: [
      {
        ...createLayer("text", 0),
        name: "主标题",
        content: title,
        x: 8,
        y: 66,
        width: 72,
        height: 20,
        fontSize: 48,
      },
    ],
  };
}

export function createTimeline(scenes: Scene[]): TimelineClip[] {
  let cursor = 0;
  const clips: TimelineClip[] = [];
  scenes.forEach((scene, index) => {
    clips.push({
      id: makeId("clip"),
      track: "video",
      sceneId: scene.id,
      label: `${String(index + 1).padStart(2, "0")} ${scene.title}`,
      start: cursor,
      duration: scene.duration,
      color: scene.accent,
    });
    clips.push({
      id: makeId("clip"),
      track: "narration",
      sceneId: scene.id,
      label: `旁白 · ${scene.title}`,
      start: cursor + 0.2,
      duration: Math.max(1, scene.duration - 0.5),
      color: "#a78bfa",
    });
    cursor += scene.duration;
  });
  return clips;
}

export function makeSampleProject(): VideoProject {
  const scenes = [
    createScene(
      "黑夜，真的是黑色的吗？",
      "你每晚看到的夜空，可能并不是宇宙最真实的样子。我们看到的黑暗，其实藏着一段被忽略的光的故事。",
      5,
      0,
    ),
    createScene(
      "宇宙并非空无一物",
      "如果宇宙里布满恒星，为什么夜空没有被无数星光点亮？这个问题曾让天文学家争论了数百年。",
      7,
      1,
    ),
    createScene(
      "光，也有自己的方向",
      "宇宙膨胀会把遥远星光拉向更长的波长。可见光逐渐变成红外光，最终离开我们眼睛能够感知的范围。",
      8,
      2,
    ),
    createScene(
      "看见人眼看不见的光",
      "现代望远镜不只观察可见光。它们接收红外线、无线电波和微波，把宇宙另一面的信息重新翻译给我们。",
      7,
      3,
    ),
    createScene(
      "黑暗是一张信息地图",
      "所以，夜空的黑暗不是空白。它是时间、距离和宇宙历史共同留下的边界，也是下一场发现的入口。",
      6,
      4,
    ),
  ];

  const outline = [
    {
      id: makeId("outline"),
      eyebrow: "01 · HOOK",
      title: "用一个反直觉问题抓住注意力",
      body: "从“夜空为什么是黑的”切入，制造认知冲突：黑暗不是没有东西，而是我们只看见了宇宙的一小部分。",
      seconds: 5,
    },
    {
      id: makeId("outline"),
      eyebrow: "02 · CONTEXT",
      title: "解释奥伯斯佯谬",
      body: "用最简单的宇宙观提问：如果宇宙无限、恒星无限，为什么星光没有铺满整个天空？",
      seconds: 7,
    },
    {
      id: makeId("outline"),
      eyebrow: "03 · REVEAL",
      title: "揭示红移与宇宙年龄",
      body: "把抽象概念转成可见现象：光在旅行中被拉长，远端星光离开可见范围。",
      seconds: 8,
    },
    {
      id: makeId("outline"),
      eyebrow: "04 · EVIDENCE",
      title: "展示不同波段的宇宙",
      body: "用多波段图像和望远镜画面说明：黑暗不等于空无，只是信息超出了人眼带宽。",
      seconds: 7,
    },
    {
      id: makeId("outline"),
      eyebrow: "05 · TAKEAWAY",
      title: "把黑暗重新定义",
      body: "收束到一句可记住的结论：黑暗是宇宙留给我们的信息边界。",
      seconds: 6,
    },
  ];

  const project: VideoProject = {
    id: "project-demo-night-sky",
    title: "夜空为什么是黑色的？",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stage: "planning",
    isDemo: true,
    settings: {
      topic: "为什么夜空是黑色的？",
      contentType: "科学原理",
      audience: "对宇宙好奇的普通观众",
      duration: 45,
      aspectRatio: "16:9",
      style: "电影感纪录片",
      language: "简体中文",
    },
    outline,
    outlineApproved: true,
    researchSources: [],
    scenes,
    assets: [],
    subtitles: [
      {
        id: makeId("sub"),
        sceneId: scenes[0].id,
        start: 0,
        end: 3.8,
        text: "你每晚看到的夜空，可能并不是宇宙最真实的样子。",
      },
      {
        id: makeId("sub"),
        sceneId: scenes[1].id,
        start: 5.2,
        end: 8.9,
        text: "如果宇宙里布满恒星，为什么夜空没有被点亮？",
      },
      {
        id: makeId("sub"),
        sceneId: scenes[2].id,
        start: 12.2,
        end: 16.8,
        text: "宇宙膨胀，会把遥远星光拉向更长的波长。",
      },
    ],
    timeline: createTimeline(scenes),
    audio: {
      voice: "系统中文语音",
      rate: 0.94,
      volume: 0.82,
      subtitleSize: 32,
      subtitlePosition: "bottom",
    },
    renders: [],
  };
  return project;
}

export function makeSkyBlueProject(): VideoProject {
  const sceneSpecs = [
    {
      title: "天空为什么是蓝色的？",
      narration:
        "抬头看晴天，天空几乎总是蓝色。可太阳光明明是白色的，蓝色究竟从哪里来？",
      description:
        "从明亮的蓝天和白色太阳形成反直觉对照，抛出为什么天空是蓝色的问题。",
      prompt:
        "Modern playful science animation, bright blue sky, sun rays entering atmosphere, bold editorial typography",
      accent: "#8ef2ff",
    },
    {
      title: "白光是颜色的合集",
      narration:
        "太阳光看起来是白色，其实混合了红、橙、黄、绿、蓝、靛、紫等许多颜色。",
      description:
        "一束白光通过棱镜分解成连续色谱，颜色依次展开。",
      prompt:
        "White sunlight passing through a glass prism, vivid rainbow spectrum, clean vector infographic",
      accent: "#ffd166",
    },
    {
      title: "空气分子挡住光",
      narration:
        "光进入大气后，会不断撞上氮气、氧气等分子。这些分子比可见光的波长小得多。",
      description:
        "蓝色小分子网络与不同波长的光波相遇，显示尺度差异。",
      prompt:
        "Atmospheric gas molecules and light waves, tiny molecular clusters, educational diagram",
      accent: "#79a9ff",
    },
    {
      title: "蓝光更容易散射",
      narration:
        "红光波长较长，更容易从分子旁穿过；蓝光波长较短，更容易被分子向四面八方散射。",
      description:
        "红波长直线穿过，蓝波长在空气分子间向多个方向散射。",
      prompt:
        "Rayleigh scattering comparison, red path passing through, blue light scattering in all directions",
      accent: "#58c7ff",
    },
    {
      title: "整片天空都在发光",
      narration:
        "你抬头看到的蓝光，来自整片天空向你的眼睛散射；太阳本身仍然包含全部颜色。",
      description:
        "无数散射方向汇聚到观察者眼睛，整片天空成为蓝色光源。",
      prompt:
        "Observer looking at scattered blue sky, rays converging into an eye, modern science illustration",
      accent: "#9fe0ff",
    },
    {
      title: "眼睛偏爱的蓝色",
      narration:
        "紫光虽然也会散射，人眼对蓝光更敏感，天空便呈现明亮而熟悉的蓝色。",
      description:
        "蓝紫色波谱进入人眼响应曲线，蓝色区域被高亮，完成知识结论。",
      prompt:
        "Playful eye sensitivity chart, blue and violet spectrum, warm friendly science animation",
      accent: "#c8ff65",
    },
  ];
  const scenes = sceneSpecs.map((spec, index) => {
    const scene = createScene(spec.title, spec.narration, 10, index);
    scene.description = spec.description;
    scene.visualPrompt = spec.prompt;
    scene.accent = spec.accent;
    scene.shotType = ["Hook", "Explainer", "Diagram", "Evidence", "Reveal", "Takeaway"][
      index
    ];
    scene.transition = ["淡入", "横向推移", "遮罩展开", "擦除", "柔光淡入", "直接切换"][
      index
    ];
    scene.layers = [
      {
        ...createLayer("text", 0),
        name: "主标题",
        content: scene.title,
        x: 8,
        y: 68,
        width: 72,
        height: 18,
        fontSize: index === 0 ? 52 : 45,
      },
    ];
    return scene;
  });
  const outline = sceneSpecs.map((spec, index) => ({
    id: makeId("outline"),
    eyebrow: `${String(index + 1).padStart(2, "0")} · ${
      ["HOOK", "SPECTRUM", "MOLECULES", "SCATTER", "EXPLAIN", "TAKEAWAY"][index]
    }`,
    title: spec.title,
    body: spec.description,
    seconds: 10,
  }));
  const subtitles = scenes.flatMap((scene, sceneIndex) => {
    const parts = scene.narration
      .split(/(?<=[。！？])/)
      .map((text) => text.trim())
      .filter(Boolean);
    const step = scene.duration / Math.max(1, parts.length);
    return parts.map((text, index) => ({
      id: makeId("sub"),
      sceneId: scene.id,
      start: Number((sceneIndex * 10 + index * step).toFixed(2)),
      end: Number((sceneIndex * 10 + (index + 1) * step).toFixed(2)),
      text,
    }));
  });
  return {
    id: "project-mvp-sky-blue",
    title: "天空为什么是蓝色的？",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stage: "script",
    isDemo: true,
    settings: {
      topic: "为什么天空是蓝色的？",
      contentType: "科学原理",
      audience: "对日常科学好奇的年轻观众",
      duration: 60,
      aspectRatio: "16:9",
      style: "现代趣味科普动画",
      language: "简体中文",
    },
    outline,
    outlineApproved: true,
    researchSources: [],
    scenes,
    assets: [],
    subtitles,
    timeline: createTimeline(scenes),
    audio: {
      voice: "Microsoft Huihui Desktop",
      rate: 1.12,
      volume: 0.84,
      subtitleSize: 32,
      subtitlePosition: "bottom",
    },
    renders: [],
  };
}

export function createProject(input: CreateProjectInput): VideoProject {
  const scenes = buildScenesFromOutline(
    [
      {
        id: makeId("outline"),
        eyebrow: "01 · OPEN",
        title: `从一个问题认识${input.topic}`,
        body: `面向${input.audience}，先用一个反直觉问题建立好奇。`,
        seconds: Math.max(4, Math.round(input.duration * 0.16)),
      },
      {
        id: makeId("outline"),
        eyebrow: "02 · EXPLAIN",
        title: "拆解核心原理",
        body: `把${input.topic}拆成三个可以被画面表达的步骤。`,
        seconds: Math.max(6, Math.round(input.duration * 0.28)),
      },
      {
        id: makeId("outline"),
        eyebrow: "03 · REVEAL",
        title: "用一个视觉证据完成转折",
        body: "用图表、过程动画或类比把抽象概念变得可见。",
        seconds: Math.max(6, Math.round(input.duration * 0.3)),
      },
      {
        id: makeId("outline"),
        eyebrow: "04 · TAKEAWAY",
        title: "留下一个清晰的结论",
        body: `让观众带走一句关于${input.topic}的可复述洞见。`,
        seconds: Math.max(4, Math.round(input.duration * 0.18)),
      },
    ],
    input.topic,
    input.style,
  );
  return {
    id: makeId("project"),
    title: input.title || input.topic,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stage: "planning",
    isDemo: false,
    settings: {
      topic: input.topic,
      contentType: input.contentType,
      audience: input.audience,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      style: input.style,
      language: input.language,
    },
    outline: [],
    outlineApproved: false,
    researchSources: [],
    scenes,
    assets: [],
    subtitles: [],
    timeline: createTimeline(scenes),
    audio: {
      voice: "系统中文语音",
      rate: 0.94,
      volume: 0.82,
      subtitleSize: 32,
      subtitlePosition: "bottom",
    },
    renders: [],
  };
}

export function generateOutlineDraft(
  project: VideoProject,
  strategy: string,
): OutlineSection[] {
  const topic = project.settings.topic;
  const audience = project.settings.audience;
  const strategyCopy: Record<string, string> = {
    悬念驱动: "先抛出反常识现象，再用两条证据逐步揭开答案。",
    原理拆解: "从最熟悉的经验出发，将知识拆成原因、过程和结果。",
    故事叙事: "用一次观察或发现串联概念，让人物和目标推动理解。",
  };
  return [
    {
      id: makeId("outline"),
      eyebrow: "01 · HOOK",
      title: `你的直觉可能误解了${topic}`,
      body: `面向${audience}，用一个具体场景制造认知落差。${strategyCopy[strategy] ?? ""}`,
      seconds: Math.max(4, Math.round(project.settings.duration * 0.15)),
    },
    {
      id: makeId("outline"),
      eyebrow: "02 · CONTEXT",
      title: "把问题放回熟悉的经验里",
      body: `先说明人们通常会怎样理解${topic}，再指出这个理解遗漏了什么。画面以对比构图为主。`,
      seconds: Math.max(6, Math.round(project.settings.duration * 0.22)),
    },
    {
      id: makeId("outline"),
      eyebrow: "03 · REVEAL",
      title: "用三个步骤拆开核心机制",
      body: "依次呈现触发条件、关键变化和最终结果。每一步只承载一个视觉动作，避免信息过载。",
      seconds: Math.max(8, Math.round(project.settings.duration * 0.3)),
    },
    {
      id: makeId("outline"),
      eyebrow: "04 · EVIDENCE",
      title: "让抽象知识变成可见证据",
      body: "使用数据图、剖面图或过程动画验证解释。涉及事实时，来源必须进入研究记录并等待人工审核。",
      seconds: Math.max(6, Math.round(project.settings.duration * 0.2)),
    },
    {
      id: makeId("outline"),
      eyebrow: "05 · TAKEAWAY",
      title: "留下可以复述的一句话",
      body: `回到开场的问题：${topic}。用一个清晰、克制、可被记住的结论结束。`,
      seconds: Math.max(4, Math.round(project.settings.duration * 0.13)),
    },
  ];
}

export function buildScenesFromOutline(
  outline: OutlineSection[],
  topic: string,
  style: string,
): Scene[] {
  return outline.map((section, index) => {
    const seedSentence = `${section.title}。${
      index === outline.length - 1
        ? `这就是${topic}留给我们的关键线索。`
        : section.body
    }`;
    const scene = createScene(
      section.title.replace(/^你的直觉可能误解了/, "").slice(0, 28),
      seedSentence,
      section.seconds,
      index,
    );
    scene.visualPrompt = `${style}, knowledge animation about ${topic}, scene: ${section.title}, sophisticated editorial composition, controlled color palette`;
    scene.description = section.body;
    return scene;
  });
}

export function aspectDimensions(ratio: AspectRatio): {
  width: number;
  height: number;
} {
  if (ratio === "9:16") return { width: 1080, height: 1920 };
  if (ratio === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}
