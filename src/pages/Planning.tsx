import {
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  CircleDot,
  FileSearch,
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading } from "../components/AppShell";
import {
  Button,
  Field,
  IconButton,
  Pill,
  Select,
  TextInput,
} from "../components/ui";
import { useCurrentProject } from "../components/AppShell";
import { generateOutlineDraft } from "../data/demo";
import { useStudioStore } from "../store/studio";
import type { OutlineSection, ResearchSource } from "../types";
import { makeId } from "../utils";
import "./Planning.css";

const strategies = [
  {
    value: "悬念驱动",
    title: "悬念驱动",
    description: "先制造反常识，再用证据完成揭示",
  },
  {
    value: "原理拆解",
    title: "原理拆解",
    description: "原因 → 过程 → 结果，建立可靠理解",
  },
  {
    value: "故事叙事",
    title: "故事叙事",
    description: "用发现、问题和转折推动知识",
  },
];

export default function Planning() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [strategy, setStrategy] = useState("悬念驱动");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [generating, setGenerating] = useState(false);

  if (!project) return null;
  const sources = project.researchSources ?? [];

  const totalSeconds = useMemo(
    () => project.outline.reduce((sum, section) => sum + section.seconds, 0),
    [project.outline],
  );

  const generate = () => {
    setGenerating(true);
    window.setTimeout(() => {
      const outline = generateOutlineDraft(project, strategy);
      updateProject(project.id, {
        outline,
        outlineApproved: false,
        stage: "planning",
      });
      setGenerating(false);
      pushToast({
        type: "success",
        title: "结构草案已生成",
        message: "这是基于本地编排规则的可编辑草案，不冒充模型研究结果。",
      });
    }, 520);
  };

  const patchSection = (id: string, patch: Partial<OutlineSection>) => {
    updateProject(project.id, (current) => ({
      ...current,
      outlineApproved: false,
      outline: current.outline.map((section) =>
        section.id === id ? { ...section, ...patch } : section,
      ),
    }));
  };

  const addSection = () => {
    const section: OutlineSection = {
      id: makeId("outline"),
      eyebrow: `${String(project.outline.length + 1).padStart(2, "0")} · NEW BEAT`,
      title: "新的叙事段落",
      body: "描述这一段需要建立的理解、证据或情绪变化。",
      seconds: 6,
    };
    updateProject(project.id, {
      outline: [...project.outline, section],
      outlineApproved: false,
    });
  };

  const removeSection = (id: string) => {
    updateProject(project.id, {
      outline: project.outline.filter((section) => section.id !== id),
      outlineApproved: false,
    });
  };

  const addSource = () => {
    if (!sourceTitle.trim()) {
      pushToast({ type: "error", title: "请填写来源标题" });
      return;
    }
    if (sourceUrl.trim()) {
      try {
        new URL(sourceUrl);
      } catch {
        pushToast({ type: "error", title: "来源链接格式不正确" });
        return;
      }
    }
    const source: ResearchSource = {
      id: makeId("source"),
      title: sourceTitle.trim(),
      url: sourceUrl.trim(),
      note: "待人工核验",
      verified: false,
    };
    updateProject(project.id, { researchSources: [...sources, source] });
    setSourceTitle("");
    setSourceUrl("");
    pushToast({ type: "success", title: "来源已添加，标记为待核验" });
  };

  const approve = () => {
    if (!project.outline.length) {
      pushToast({ type: "error", title: "还没有可审批的大纲" });
      return;
    }
    updateProject(project.id, {
      outlineApproved: !project.outlineApproved,
      stage: project.outlineApproved ? "planning" : "script",
    });
    pushToast({
      type: project.outlineApproved ? "info" : "success",
      title: project.outlineApproved ? "已撤销大纲审批" : "大纲已审批",
    });
  };

  return (
    <div className="planning-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="AI PLANNING"
        title="把主题变成一个值得看完的故事"
        description="先确定叙事策略和知识顺序，再进入脚本。所有 AI 输出都留在可编辑草稿中。"
        actions={
          <>
            <Pill tone={project.outlineApproved ? "success" : "warning"} dot>
              {project.outlineApproved ? "大纲已审批" : "等待审批"}
            </Pill>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/script`)}
            >
              进入脚本
            </Button>
          </>
        }
      />

      <div className="planning-context">
        <div>
          <span className="eyebrow">PROJECT BRIEF</span>
          <h2>{project.settings.topic}</h2>
          <p>
            面向 {project.settings.audience} · {project.settings.contentType} ·{" "}
            {project.settings.style}
          </p>
        </div>
        <div className="planning-context__metrics">
          <span>
            <strong>{project.outline.length}</strong>
            叙事段落
          </span>
          <span>
            <strong>{totalSeconds}s</strong>
            当前时长
          </span>
          <span>
            <strong>{project.settings.duration}s</strong>
            目标时长
          </span>
        </div>
      </div>

      <div className="planning-layout">
        <section className="outline-editor">
          <div className="outline-editor__toolbar">
            <div>
              <span className="eyebrow">STORY STRUCTURE</span>
              <h2>视频大纲</h2>
            </div>
            <div className="toolbar-group">
              <Select
                value={strategy}
                onChange={(event) => setStrategy(event.target.value)}
                aria-label="叙事策略"
              >
                {strategies.map((item) => (
                  <option key={item.value}>{item.value}</option>
                ))}
              </Select>
              <Button
                variant="soft"
                size="sm"
                icon={<RefreshCw size={14} className={generating ? "spin" : ""} />}
                onClick={generate}
                disabled={generating}
              >
                {generating ? "正在编排…" : "生成结构草案"}
              </Button>
            </div>
          </div>

          {!project.outline.length ? (
            <div className="outline-empty">
              <span><WandSparkles size={24} /></span>
              <h3>从一个可编辑的结构草案开始</h3>
              <p>
                选择叙事策略后，本地编排器会生成开场、背景、揭示、证据和收束五个段落。
              </p>
              <Button
                variant="primary"
                icon={<Sparkles size={16} />}
                onClick={generate}
                disabled={generating}
              >
                生成本地结构草案
              </Button>
            </div>
          ) : (
            <div className="outline-list">
              {project.outline.map((section, index) => (
                <article className="outline-item" key={section.id}>
                  <div className="outline-item__rail">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <i />
                  </div>
                  <div className="outline-item__content">
                    <div className="outline-item__meta">
                      <input
                        value={section.eyebrow}
                        onChange={(event) =>
                          patchSection(section.id, {
                            eyebrow: event.target.value,
                          })
                        }
                        aria-label="段落标签"
                      />
                      <label>
                        <CircleDot size={13} />
                        <input
                          type="number"
                          min={2}
                          max={60}
                          value={section.seconds}
                          onChange={(event) =>
                            patchSection(section.id, {
                              seconds: Math.max(2, Number(event.target.value)),
                            })
                          }
                          aria-label="段落时长"
                        />
                        秒
                      </label>
                      <IconButton
                        label="删除段落"
                        onClick={() => removeSection(section.id)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                    <input
                      className="outline-item__title"
                      value={section.title}
                      onChange={(event) =>
                        patchSection(section.id, { title: event.target.value })
                      }
                      aria-label="段落标题"
                    />
                    <textarea
                      className="outline-item__body"
                      value={section.body}
                      onChange={(event) =>
                        patchSection(section.id, { body: event.target.value })
                      }
                      rows={2}
                      aria-label="段落说明"
                    />
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="outline-footer">
            <Button variant="ghost" icon={<Plus size={15} />} onClick={addSection}>
              添加段落
            </Button>
            <div>
              <span>
                目标偏差{" "}
                <strong className={Math.abs(totalSeconds - project.settings.duration) > 8 ? "is-warning" : ""}>
                  {totalSeconds - project.settings.duration > 0 ? "+" : ""}
                  {totalSeconds - project.settings.duration}s
                </strong>
              </span>
              <Button
                variant={project.outlineApproved ? "secondary" : "primary"}
                icon={project.outlineApproved ? <CheckCircle2 size={16} /> : <Check size={16} />}
                onClick={approve}
              >
                {project.outlineApproved ? "撤销审批" : "审批大纲"}
              </Button>
            </div>
          </div>
        </section>

        <aside className="planning-aside">
          <section className="strategy-panel">
            <span className="eyebrow">NARRATIVE STRATEGY</span>
            <h3>讲述方式</h3>
            <div className="strategy-list">
              {strategies.map((item, index) => (
                <button
                  type="button"
                  key={item.value}
                  className={strategy === item.value ? "is-selected" : ""}
                  onClick={() => setStrategy(item.value)}
                >
                  <span>0{index + 1}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </div>
                  <span className="strategy-radio">
                    {strategy === item.value && <i />}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="research-panel">
            <header>
              <span className="eyebrow">RESEARCH LAYER</span>
              <Pill tone="warning">{sources.filter((source) => !source.verified).length} 待核验</Pill>
            </header>
            <h3>事实与来源</h3>
            {sources.length ? (
              <div className="source-list">
                {sources.map((source) => (
                  <div key={source.id}>
                    <span><FileSearch size={15} /></span>
                    <div>
                      <strong>{source.title}</strong>
                      <small>{source.url || source.note}</small>
                    </div>
                    <button
                      type="button"
                      className={source.verified ? "is-verified" : ""}
                      onClick={() =>
                        updateProject(project.id, {
                          researchSources: sources.map((item) =>
                            item.id === source.id
                              ? { ...item, verified: !item.verified }
                              : item,
                          ),
                        })
                      }
                    >
                      {source.verified ? <CheckCircle2 size={15} /> : <CircleDot size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="research-empty">
                <BookOpenCheck size={19} />
                <p>尚未关联事实来源。涉及事实性知识时必须补充并人工核验。</p>
              </div>
            )}
            <div className="source-form">
              <Field label="来源标题">
                <TextInput
                  value={sourceTitle}
                  onChange={(event) => setSourceTitle(event.target.value)}
                  placeholder="论文、机构或资料名称"
                />
              </Field>
              <Field label="链接">
                <TextInput
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://…"
                />
              </Field>
              <Button
                variant="secondary"
                size="sm"
                icon={<Link2 size={14} />}
                onClick={addSource}
              >
                添加待核验来源
              </Button>
            </div>
          </section>

          <section className="planning-note">
            <WandSparkles size={17} />
            <p>
              <strong>一个有效的知识开场</strong>
              不是先解释答案，而是让观众发现自己的直觉里有一个缺口。
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
