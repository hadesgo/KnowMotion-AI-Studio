import type {
  AspectRatio,
  CreateProjectInput,
} from "../types";

export type ProjectIntent = CreateProjectInput;

const chineseNumbers: Record<string, number> = {
  十五: 15,
  二十: 20,
  二十五: 25,
  三十: 30,
  四十五: 45,
  五十: 50,
  六十: 60,
  九十: 90,
  一百: 100,
  一百二十: 120,
  一百五十: 150,
  一百八十: 180,
};

function clampDuration(value: number): number {
  return Math.min(180, Math.max(15, Math.round(value / 5) * 5));
}

function inferDuration(text: string): number {
  const seconds = text.match(/(\d{2,3})\s*(?:秒|s\b)/i);
  if (seconds) return clampDuration(Number(seconds[1]));

  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min\b)/i);
  if (minutes) return clampDuration(Number(minutes[1]) * 60);

  for (const [label, secondsValue] of Object.entries(chineseNumbers)) {
    if (new RegExp(`${label}\\s*(?:秒|s\\b)`, "i").test(text)) {
      return clampDuration(secondsValue);
    }
    if (new RegExp(`${label}\\s*(?:分钟|分)`, "i").test(text)) {
      return clampDuration(secondsValue * 60);
    }
  }
  return 45;
}

function inferAspectRatio(text: string): AspectRatio {
  if (/(9\s*[:：]\s*16|竖屏|竖向|手机|抖音|快手|reels|shorts)/i.test(text)) {
    return "9:16";
  }
  if (/(1\s*[:：]\s*1|方屏|方形)/i.test(text)) return "1:1";
  return "16:9";
}

function inferLanguage(text: string): string {
  if (/(english|英文|英语)/i.test(text)) return "English";
  if (/(japanese|日文|日语|日本語)/i.test(text)) return "日本語";
  return "简体中文";
}

function inferContentType(text: string): string {
  if (/(人工智能|大模型|语言模型|llm|机器学习|神经网络|算法|ai\b)/i.test(text)) {
    return "AI 技术";
  }
  if (/(历史|朝代|战争|人物|故事|考古)/i.test(text)) return "历史故事";
  if (/(软件|系统|工程|芯片|产品|技术|架构)/i.test(text)) return "技术解析";
  if (/(自然|动物|植物|海洋|宇宙|生态|天气)/i.test(text)) return "自然科学";
  if (/(原理|物理|化学|数学|为什么|如何形成|机制)/i.test(text)) {
    return "科学原理";
  }
  return "知识科普";
}

function inferStyle(text: string): string {
  if (/(极简|简洁|留白|editorial|简约)/i.test(text)) return "编辑部极简";
  if (/(信息图|图表|数据|diagram|infographic)/i.test(text)) return "干净信息图";
  if (/(未来|赛博|科技感|科幻|neon)/i.test(text)) return "未来主义数据";
  if (/(复古|旧报纸|杂志|retro)/i.test(text)) return "复古科学杂志";
  return "电影感纪录片";
}

function inferAudience(text: string): string {
  const explicit = text.match(/(?:面向|适合|给)([^，。；;\n]{2,28})/);
  if (explicit?.[1]) {
    const audience = explicit[1]
      .trim()
      .replace(/(?:观众|用户)$/u, "");
    return audience.endsWith("观众") ? audience : `${audience}观众`;
  }
  if (/(孩子|儿童|小学生)/i.test(text)) return "儿童与青少年观众";
  if (/(专业|工程师|开发者|研究员)/i.test(text)) {
    return "具备专业背景的技术观众";
  }
  return "对世界保持好奇的普通观众";
}

function cleanTopic(text: string): string {
  const firstLine = text
    .split(/[\n。；;]/)
    .map((part) => part.trim())
    .find(Boolean);
  return (firstLine || text.trim()).slice(0, 120);
}

function cleanTitle(topic: string): string {
  return topic
    .replace(/^(请|帮我|制作|生成|做)(一个|一支|一段)?/u, "")
    .replace(
      /^(?:(?:\d+\s*(?:秒|分钟)|横屏|竖屏|方屏|电影感|写实)\s*[：:，,、-]?\s*)+/iu,
      "",
    )
    .replace(
      /(?:，|,)?\s*(?:时长|时间)[^，。,]*$|(?:，|,)?\s*\d+\s*(?:秒|分钟)[^，。,]*$/u,
      "",
    )
    .replace(/[。！？!?]+$/u, "")
    .trim()
    .slice(0, 56) || "新的知识视频";
}

export function inferProjectIntent(
  input: string,
  overrides: Partial<Omit<CreateProjectInput, "brief" | "topic">> = {},
): ProjectIntent {
  const brief = input.trim();
  const topic = cleanTopic(brief || "一个值得讲清楚的知识主题");
  return {
    title: overrides.title?.trim() || cleanTitle(topic),
    topic,
    brief,
    contentType: overrides.contentType || inferContentType(brief),
    audience: overrides.audience?.trim() || inferAudience(brief),
    duration: overrides.duration ?? inferDuration(brief),
    aspectRatio: overrides.aspectRatio ?? inferAspectRatio(brief),
    style: overrides.style || inferStyle(brief),
    language: overrides.language || inferLanguage(brief),
  };
}

export function describeIntent(intent: ProjectIntent): string[] {
  const ratio = {
    "16:9": "横屏 16:9",
    "9:16": "竖屏 9:16",
    "1:1": "方屏 1:1",
  }[intent.aspectRatio];
  return [
    ratio,
    `${intent.duration} 秒`,
    intent.style,
    intent.language,
    `面向${intent.audience}`,
  ];
}
