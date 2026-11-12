import {
  ArrowLeft,
  Check,
  Clapperboard,
  Clock3,
  Languages,
  MonitorUp,
  Sparkles,
  Users,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading } from "../components/AppShell";
import { Button, Field, Pill, Select, TextInput } from "../components/ui";
import { contentTypes, visualStyles } from "../data/demo";
import { useStudioStore } from "../store/studio";
import type { AspectRatio } from "../types";

const typeCopy: Record<string, string> = {
  知识科普: "清晰、有节奏的通用知识解释",
  科学原理: "用机制、证据和过程建立理解",
  技术解析: "拆解系统、产品与工程原理",
  历史故事: "让时间、人物与因果推动叙事",
  自然科学: "观察自然现象并解释其规律",
  "AI 技术": "解释模型、数据与智能系统",
};

const ratios: { value: AspectRatio; label: string; shape: string; hint: string }[] = [
  { value: "16:9", label: "横屏", shape: "16 / 9", hint: "长视频 · 4K" },
  { value: "9:16", label: "竖屏", shape: "9 / 16", hint: "短视频 · 移动端" },
  { value: "1:1", label: "方屏", shape: "1 / 1", hint: "社交信息流" },
];

export default function NewProject() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const createProject = useStudioStore((state) => state.createProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const initialTopic = params.get("topic") ?? "";
  const [title, setTitle] = useState(
    initialTopic ? `${initialTopic.replace(/[？?](.)?$/, "")}：一次视觉解释` : "",
  );
  const [topic, setTopic] = useState(initialTopic);
  const [contentType, setContentType] = useState("科学原理");
  const [audience, setAudience] = useState("对世界保持好奇的普通观众");
  const [duration, setDuration] = useState(45);
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [style, setStyle] = useState("电影感纪录片");
  const [language, setLanguage] = useState("简体中文");
  const [error, setError] = useState("");

  const summary = useMemo(() => {
    const wordPace = language === "English" ? 145 : 260;
    return {
      scenes: Math.max(3, Math.round(duration / 8)),
      words: Math.round((duration / 60) * wordPace),
      resolution:
        ratio === "9:16" ? "1080 × 1920" : ratio === "1:1" ? "1080 × 1080" : "1920 × 1080",
    };
  }, [duration, language, ratio]);

  const create = () => {
    if (!topic.trim()) {
      setError("先写下一个想讲清楚的知识主题。");
      return;
    }
    if (topic.trim().length < 4) {
      setError("主题再具体一点，至少需要 4 个字符。");
      return;
    }
    setError("");
    const id = createProject({
      title: title.trim() || `${topic.trim()}：一次视觉解释`,
      topic: topic.trim(),
      contentType,
      audience,
      duration,
      aspectRatio: ratio,
      style,
      language,
    });
    pushToast({
      type: "success",
      title: "项目已创建",
      message: "项目结构与本地时间轴已准备好。",
    });
    navigate(`/projects/${id}/plan`);
  };

  const applyStarter = () => {
    setTopic("为什么夜空是黑色的？");
    setTitle("夜空为什么是黑色的？");
    setContentType("科学原理");
    setAudience("对宇宙好奇的普通观众");
    setDuration(45);
    setRatio("16:9");
    setStyle("电影感纪录片");
    setError("");
  };

  return (
    <div className="new-project-page">
      <PageHeading
        eyebrow="NEW KNOWLEDGE FILM"
        title="开始一支新的知识动画"
        description="先确定讲述对象与观看方式，之后所有 AI 步骤都会共享这份项目上下文。"
        actions={
          <Button
            variant="ghost"
            icon={<ArrowLeft size={16} />}
            onClick={() => navigate(-1)}
          >
            返回
          </Button>
        }
      />

      <div className="create-layout">
        <section className="create-form-panel">
          <div className="form-section">
            <div className="form-section__head">
              <span>01</span>
              <div>
                <h2>创作主题</h2>
                <p>用一句话定义观众会带走的知识。</p>
              </div>
              <Button variant="ghost" size="sm" onClick={applyStarter}>
                填充示例
              </Button>
            </div>
            <Field
              label="视频主题"
              error={error}
              hint="可以是一个问题、一个现象或一个需要被解释的概念。"
            >
              <TextInput
                autoFocus
                value={topic}
                onChange={(event) => {
                  setTopic(event.target.value);
                  setError("");
                  if (
                    !title ||
                    title.endsWith("：一次视觉解释")
                  ) {
                    setTitle(
                      event.target.value
                        ? `${event.target.value.replace(/[？?](.)?$/, "")}：一次视觉解释`
                        : "",
                    );
                  }
                }}
                placeholder="例如：为什么夜空是黑色的？"
              />
            </Field>
            <Field label="项目标题" hint="用于 Dashboard 和项目文件，可以稍后修改。">
              <TextInput
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="给这支视频一个工作标题"
              />
            </Field>
          </div>

          <div className="form-section">
            <div className="form-section__head">
              <span>02</span>
              <div>
                <h2>内容类型</h2>
                <p>决定研究方式、叙事节奏和视觉语言。</p>
              </div>
            </div>
            <div className="type-grid">
              {contentTypes.map((type) => (
                <button
                  type="button"
                  key={type}
                  className={contentType === type ? "is-selected" : ""}
                  onClick={() => setContentType(type)}
                >
                  <span className="type-grid__check">
                    {contentType === type && <Check size={12} />}
                  </span>
                  <strong>{type}</strong>
                  <small>{typeCopy[type]}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="form-section">
            <div className="form-section__head">
              <span>03</span>
              <div>
                <h2>观众与画面</h2>
                <p>所有设置都可以在项目中继续调整。</p>
              </div>
            </div>
            <div className="form-grid">
              <Field label="目标观众">
                <TextInput
                  value={audience}
                  onChange={(event) => setAudience(event.target.value)}
                />
              </Field>
              <Field label="视频语言">
                <Select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  <option>简体中文</option>
                  <option>English</option>
                  <option>日本語</option>
                </Select>
              </Field>
            </div>
            <div className="ratio-grid">
              {ratios.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={ratio === item.value ? "is-selected" : ""}
                  onClick={() => setRatio(item.value)}
                >
                  <span
                    className="ratio-grid__shape"
                    style={{ aspectRatio: item.shape }}
                  />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  <em>{item.value}</em>
                </button>
              ))}
            </div>
            <div className="form-grid">
              <Field label={`目标时长 · ${duration} 秒`}>
                <input
                  className="range"
                  type="range"
                  min={15}
                  max={180}
                  step={5}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
                <div className="range-labels">
                  <span>15s</span>
                  <span>1 分钟</span>
                  <span>3 分钟</span>
                </div>
              </Field>
              <Field label="视觉风格">
                <Select
                  value={style}
                  onChange={(event) => setStyle(event.target.value)}
                >
                  {visualStyles.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>

          <footer className="create-form-footer">
            <Button variant="ghost" onClick={() => navigate("/")}>
              取消
            </Button>
            <Button
              variant="primary"
              size="lg"
              icon={<Sparkles size={17} />}
              onClick={create}
            >
              创建并进入策划
            </Button>
          </footer>
        </section>

        <aside className="create-preview-panel">
          <div className="create-preview-sticky">
            <span className="eyebrow">PROJECT PREVIEW</span>
            <div
              className={`project-cover project-cover--${ratio.replace(":", "-")}`}
            >
              <div className="project-cover__noise" />
              <div className="project-cover__rings">
                <span />
                <span />
                <span />
                <i />
              </div>
              <span className="project-cover__meta">
                <Clapperboard size={13} />
                KNOWLEDGE FILM / {contentType}
              </span>
              <h2>{topic || "你的知识主题"}</h2>
              <p>{style} · {language}</p>
              <span className="project-cover__line" />
            </div>
            <div className="project-blueprint">
              <header>
                <span>创作蓝图</span>
                <Pill tone="accent">{summary.scenes} 个场景</Pill>
              </header>
              <div className="blueprint-row">
                <span><Clock3 size={15} />预计时长</span>
                <strong>{duration} 秒</strong>
              </div>
              <div className="blueprint-row">
                <span><Users size={15} />讲述对象</span>
                <strong>{audience}</strong>
              </div>
              <div className="blueprint-row">
                <span><Languages size={15} />旁白字数</span>
                <strong>约 {summary.words} 字</strong>
              </div>
              <div className="blueprint-row">
                <span><MonitorUp size={15} />画面尺寸</span>
                <strong>{summary.resolution}</strong>
              </div>
            </div>
            <div className="privacy-note">
              <WandSparkles size={17} />
              <div>
                <strong>本地项目空间</strong>
                <p>
                  当前前端版本将项目保存在此浏览器；模型密钥不会被写入浏览器存储。
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
