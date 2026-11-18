import {
  ArrowLeft,
  Bot,
  Clapperboard,
  Clock3,
  Languages,
  MonitorUp,
  Settings2,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading } from "../components/AppShell";
import { Button, Field, Pill, Select, TextInput } from "../components/ui";
import { contentTypes, visualStyles } from "../data/demo";
import { inferProjectIntent } from "../services/projectIntent";
import { useStudioStore } from "../store/studio";
import type {
  AspectRatio,
  CreateProjectInput,
} from "../types";
import "./NewProject.css";

type IntentOverrides = Partial<Omit<CreateProjectInput, "brief" | "topic">>;

const ratios: { value: AspectRatio; label: string; hint: string }[] = [
  { value: "16:9", label: "横屏", hint: "知识长视频" },
  { value: "9:16", label: "竖屏", hint: "短视频 / 移动端" },
  { value: "1:1", label: "方屏", hint: "社交信息流" },
];

export default function NewProject() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const createProject = useStudioStore((state) => state.createProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [brief, setBrief] = useState(params.get("topic") ?? "");
  const [overrides, setOverrides] = useState<IntentOverrides>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState("");

  const intent = useMemo(
    () => inferProjectIntent(brief, overrides),
    [brief, overrides],
  );
  const sceneCount = Math.max(3, Math.round(intent.duration / 8));
  const wordCount = Math.round(
    (intent.duration / 60) * (intent.language === "English" ? 145 : 260),
  );
  const resolution =
    intent.aspectRatio === "9:16"
      ? "1080 × 1920"
      : intent.aspectRatio === "1:1"
        ? "1080 × 1080"
        : "1920 × 1080";

  const patch = (next: IntentOverrides) =>
    setOverrides((current) => ({ ...current, ...next }));

  const create = (autoStart: boolean) => {
    const value = brief.trim();
    if (value.length < 2) {
      setError("输入一个主题，或直接描述你想要的视频。");
      return;
    }
    setError("");
    const input = inferProjectIntent(value, overrides);
    const id = createProject(input);
    pushToast({
      type: "success",
      title: autoStart ? "项目已创建，准备自动成片" : "项目已创建",
      message: autoStart
        ? "软件将自动完成策划、脚本、分镜、动画、字幕、旁白和渲染。"
        : "可以进入策划页逐步调整。",
    });
    navigate(
      autoStart
        ? `/projects/${id}/auto?run=1`
        : `/projects/${id}/plan`,
    );
  };

  return (
    <div className="new-project-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        title="说出你想看的知识视频"
        description="只需输入主题或完整要求。画面比例、时长、受众和风格会先自动推断，你仍可在生成后继续精修。"
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

      <div className="auto-create-layout">
        <section className="auto-create-main">
          <div className="auto-create-kicker">
            <span><Sparkles size={14} /> ONE SHOT VIDEO</span>
            <Pill tone="accent">自动编排</Pill>
          </div>
          <h2>一个想法，直接生成成片。</h2>
          <p className="auto-create-lead">
            可以只写“为什么夜空是黑色的？”，也可以写完整要求，例如：
            “做一个 60 秒的竖屏科普视频，面向中学生，风格简洁，英文旁白。”
          </p>

          <Field
            label="视频主题或生成要求"
            error={error}
            hint="写得越具体，自动成片越贴近你的预期；未指定的高级参数会由意图解析自动补齐。"
          >
            <textarea
              autoFocus
              className="auto-brief"
              rows={6}
              value={brief}
              onChange={(event) => {
                setBrief(event.target.value);
                setError("");
              }}
              placeholder="例如：做一支 45 秒的横屏知识动画，解释大语言模型为什么能理解上下文，面向普通职场人，画面干净、现代。"
            />
          </Field>

          <div className="auto-actions">
            <Button
              variant="primary"
              size="lg"
              icon={<WandSparkles size={18} />}
              onClick={() => create(true)}
            >
              一键生成视频
            </Button>
            <Button
              variant="secondary"
              size="lg"
              icon={<Clapperboard size={17} />}
              onClick={() => create(false)}
            >
              先创建，手动调整
            </Button>
          </div>

          <div className="auto-starters">
            <span>试试这些</span>
            {[
              "45 秒横屏：天空为什么是蓝色的？",
              "60 秒竖屏，面向学生，解释大语言模型怎样理解上下文",
              "90 秒电影感纪录片：没有钟表的文明如何计量时间",
            ].map((starter) => (
              <button
                type="button"
                key={starter}
                onClick={() => {
                  setBrief(starter);
                  setOverrides({});
                }}
              >
                {starter}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="auto-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <Settings2 size={15} />
            {advancedOpen ? "收起高级设置" : "查看并调整自动推断的设置"}
            <span>{advancedOpen ? "−" : "+"}</span>
          </button>

          {advancedOpen && (
            <div className="auto-advanced">
              <div className="form-grid">
                <Field label="项目标题">
                  <TextInput
                    value={intent.title}
                    onChange={(event) => patch({ title: event.target.value })}
                  />
                </Field>
                <Field label="内容类型">
                  <Select
                    value={intent.contentType}
                    onChange={(event) =>
                      patch({ contentType: event.target.value })
                    }
                  >
                    {contentTypes.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="目标观众">
                  <TextInput
                    value={intent.audience}
                    onChange={(event) =>
                      patch({ audience: event.target.value })
                    }
                  />
                </Field>
                <Field label="视频语言">
                  <Select
                    value={intent.language}
                    onChange={(event) =>
                      patch({ language: event.target.value })
                    }
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
                    className={
                      intent.aspectRatio === item.value ? "is-selected" : ""
                    }
                    onClick={() => patch({ aspectRatio: item.value })}
                  >
                    <span
                      className="ratio-grid__shape"
                      style={{ aspectRatio: item.value.replace(":", " / ") }}
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
                <Field label={`目标时长 · ${intent.duration} 秒`}>
                  <input
                    className="range"
                    type="range"
                    min={15}
                    max={180}
                    step={5}
                    value={intent.duration}
                    onChange={(event) =>
                      patch({ duration: Number(event.target.value) })
                    }
                  />
                  <div className="range-labels">
                    <span>15s</span>
                    <span>1 分钟</span>
                    <span>3 分钟</span>
                  </div>
                </Field>
                <Field label="视觉风格">
                  <Select
                    value={intent.style}
                    onChange={(event) => patch({ style: event.target.value })}
                  >
                    {visualStyles.map((style) => (
                      <option key={style}>{style}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          )}
        </section>

        <aside className="auto-create-preview">
          <span className="eyebrow">DIRECTING PLAN</span>
          <h2>自动制作方案</h2>
          <p>从你的要求生成，不需要逐项配置。</p>

          <div className="auto-intent-chips">
            <span>{intent.aspectRatio}</span>
            <span>{intent.duration} 秒</span>
            <span>{intent.contentType}</span>
            <span>{intent.style}</span>
            <span>{intent.language}</span>
          </div>

          <div
            className={`auto-cover auto-cover--${intent.aspectRatio.replace(":", "-")}`}
          >
            <div className="auto-cover__grid" />
            <span className="auto-cover__meta">
              <Bot size={13} /> AUTO DIRECTOR
            </span>
            <h3>{intent.topic || "你的知识主题"}</h3>
            <p>{intent.audience}</p>
            <i />
          </div>

          <div className="auto-production-list">
            {[
              ["研究", "来源与事实风险"],
              ["叙事", "大纲、脚本与分镜"],
              ["视觉", "风格、图层与动画"],
              ["声音", "旁白、字幕与时间轴"],
              ["交付", "质量门禁与 MP4"],
            ].map(([title, detail], index) => (
              <div key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>

          <div className="auto-estimate">
            <div><Clock3 size={15} /><span>预计 {intent.duration} 秒 · {sceneCount} 个场景</span></div>
            <div><Languages size={15} /><span>约 {wordCount} 字旁白</span></div>
            <div><MonitorUp size={15} /><span>{resolution} · 30 FPS</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
