import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  FileText,
  Mic2,
  Plus,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { Button, EmptyState, IconButton, Pill, Progress } from "../components/ui";
import {
  buildScenesFromOutline,
  createTimeline,
  generateOutlineDraft,
} from "../data/demo";
import { useStudioStore } from "../store/studio";
import { estimateSpeechSeconds, truncate } from "../utils";
import "./ScriptEditor.css";

export default function ScriptEditor() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [activeId, setActiveId] = useState(project?.scenes[0]?.id ?? "");
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (project && !project.scenes.some((scene) => scene.id === activeId)) {
      setActiveId(project.scenes[0]?.id ?? "");
    }
  }, [activeId, project]);

  useEffect(() => {
    return () => window.speechSynthesis?.cancel();
  }, []);

  if (!project) return null;
  const activeIndex = project.scenes.findIndex((scene) => scene.id === activeId);
  const scene = project.scenes[Math.max(0, activeIndex)];
  const totalDuration = project.scenes.reduce((sum, item) => sum + item.duration, 0);
  const estimate = scene ? estimateSpeechSeconds(scene.narration) : 0;

  const patchScene = (patch: Partial<typeof scene>) => {
    if (!scene) return;
    updateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === scene.id ? { ...item, ...patch } : item,
      ),
      stage: "script",
    }));
  };

  const generateScript = () => {
    const outline = project.outline.length
      ? project.outline
      : generateOutlineDraft(project, "悬念驱动");
    const scenes = buildScenesFromOutline(
      outline,
      project.settings.topic,
      project.settings.style,
    );
    updateProject(project.id, {
      outline,
      scenes,
      timeline: createTimeline(scenes),
      subtitles: [],
      stage: "script",
    });
    setActiveId(scenes[0]?.id ?? "");
    pushToast({
      type: "success",
      title: "场景脚本已生成",
      message: "旁白、画面建议和时间轴已同步。",
    });
  };

  const speak = () => {
    if (!scene || !("speechSynthesis" in window)) {
      pushToast({ type: "error", title: "当前浏览器不支持系统语音" });
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(scene.narration);
    utterance.lang = project.settings.language === "English" ? "en-US" : "zh-CN";
    utterance.rate = project.audio.rate;
    utterance.volume = project.audio.volume;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const splitScene = () => {
    if (!scene) return;
    const midpoint = Math.max(12, Math.floor(scene.narration.length / 2));
    const first = scene.narration.slice(0, midpoint).trim();
    const second = scene.narration.slice(midpoint).trim();
    if (second.length < 8) {
      pushToast({ type: "info", title: "旁白太短，暂时无法拆分" });
      return;
    }
    const newScene = {
      ...structuredClone(scene),
      id: `${scene.id}-split-${Date.now()}`,
      title: `${scene.title} · 续`,
      narration: second,
      duration: Math.max(2, scene.duration / 2),
    };
    updateProject(project.id, (current) => {
      const scenes = current.scenes.map((item) =>
        item.id === scene.id
          ? { ...item, narration: first, duration: Math.max(2, item.duration / 2) }
          : item,
      );
      scenes.splice(activeIndex + 1, 0, newScene);
      return {
        ...current,
        scenes,
        timeline: createTimeline(scenes),
      };
    });
    setActiveId(newScene.id);
    pushToast({ type: "success", title: "场景已拆分" });
  };

  const moveScene = (direction: -1 | 1) => {
    if (!scene) return;
    const target = activeIndex + direction;
    if (target < 0 || target >= project.scenes.length) return;
    const scenes = [...project.scenes];
    [scenes[activeIndex], scenes[target]] = [scenes[target], scenes[activeIndex]];
    updateProject(project.id, { scenes, timeline: createTimeline(scenes) });
  };

  const deleteScene = () => {
    if (!scene || project.scenes.length <= 1) {
      pushToast({ type: "error", title: "项目至少需要保留一个场景" });
      return;
    }
    const scenes = project.scenes.filter((item) => item.id !== scene.id);
    updateProject(project.id, { scenes, timeline: createTimeline(scenes) });
    setActiveId(scenes[Math.max(0, activeIndex - 1)].id);
    pushToast({ type: "info", title: "场景已删除" });
  };

  return (
    <div className="script-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="SCRIPT ROOM"
        title="让旁白、画面与节奏一起成立"
        description="每个场景同时保留旁白、视觉建议和时长估算。编辑会实时写入本地项目。"
        actions={
          <>
            <Button
              variant="soft"
              icon={<Sparkles size={16} />}
              onClick={generateScript}
            >
              {project.scenes.length ? "重新生成脚本" : "从大纲生成脚本"}
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/storyboard`)}
            >
              进入分镜
            </Button>
          </>
        }
      />

      {!project.scenes.length ? (
        <EmptyState
          icon={<FileText size={24} />}
          title="还没有脚本场景"
          description="从当前大纲生成旁白与场景草稿，然后逐段修改。"
          action={
            <Button variant="primary" onClick={generateScript}>
              从大纲生成脚本
            </Button>
          }
        />
      ) : (
        <div className="script-layout">
          <aside className="script-scenes">
            <header>
              <div>
                <span className="eyebrow">SCENES</span>
                <h2>{project.scenes.length} 个场景</h2>
              </div>
              <IconButton
                label="添加场景"
                onClick={() => {
                  const store = useStudioStore.getState();
                  const id = store.addScene(project.id);
                  setActiveId(id);
                }}
              >
                <Plus size={16} />
              </IconButton>
            </header>
            <div className="script-scene-list">
              {project.scenes.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === activeId ? "is-active" : ""}
                  onClick={() => {
                    setActiveId(item.id);
                    stopSpeaking();
                  }}
                >
                  <span className="script-scene-list__index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{truncate(item.narration, 40)}</small>
                  </span>
                  <em>{item.duration.toFixed(1)}s</em>
                </button>
              ))}
            </div>
            <footer>
              <span>总时长</span>
              <strong>{totalDuration.toFixed(1)}s</strong>
              <Progress
                compact
                value={(totalDuration / project.settings.duration) * 100}
              />
            </footer>
          </aside>

          {scene && (
            <section className="script-editor">
              <header className="script-editor__header">
                <div>
                  <span className="eyebrow">
                    SCENE {String(activeIndex + 1).padStart(2, "0")} /{" "}
                    {String(project.scenes.length).padStart(2, "0")}
                  </span>
                  <input
                    value={scene.title}
                    onChange={(event) => patchScene({ title: event.target.value })}
                    aria-label="场景标题"
                  />
                </div>
                <div className="script-editor__header-actions">
                  <IconButton
                    label="上移场景"
                    onClick={() => moveScene(-1)}
                    disabled={activeIndex === 0}
                  >
                    <ChevronUp size={16} />
                  </IconButton>
                  <IconButton
                    label="下移场景"
                    onClick={() => moveScene(1)}
                    disabled={activeIndex === project.scenes.length - 1}
                  >
                    <ChevronDown size={16} />
                  </IconButton>
                  <IconButton label="复制场景" disabled>
                    <Copy size={15} />
                  </IconButton>
                  <IconButton label="删除场景" onClick={deleteScene}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </header>

              <div className="script-paper">
                <div className="script-paper__label">
                  <span>旁白文本</span>
                  <span>
                    {scene.narration.length} 字 · 约 {estimate} 秒
                  </span>
                </div>
                <textarea
                  className="narration-editor"
                  value={scene.narration}
                  onChange={(event) =>
                    patchScene({
                      narration: event.target.value,
                      duration: Math.max(
                        2,
                        Math.round(
                          (estimateSpeechSeconds(event.target.value) +
                            Math.max(1, estimateSpeechSeconds(event.target.value) * 0.18)) *
                            10,
                        ) / 10,
                      ),
                    })
                  }
                  placeholder="写下这一场景的旁白…"
                  spellCheck
                />
                <div className="script-meta-strip">
                  <Button
                    variant={speaking ? "soft" : "secondary"}
                    size="sm"
                    icon={speaking ? <Square size={14} /> : <Mic2 size={15} />}
                    onClick={speaking ? stopSpeaking : speak}
                  >
                    {speaking ? "停止试听" : "系统语音试听"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Scissors size={14} />}
                    onClick={splitScene}
                  >
                    在此拆分
                  </Button>
                  <span>
                    <Check size={14} /> 自动保存到本地
                  </span>
                </div>
              </div>

              <div className="script-notes-grid">
                <label className="script-note-field">
                  <span>
                    <WandSparkles size={15} /> 画面描述
                  </span>
                  <textarea
                    value={scene.description}
                    onChange={(event) =>
                      patchScene({ description: event.target.value })
                    }
                    rows={3}
                  />
                </label>
                <label className="script-note-field">
                  <span>
                    <AudioLines size={15} /> 视觉提示词
                  </span>
                  <textarea
                    value={scene.visualPrompt}
                    onChange={(event) =>
                      patchScene({ visualPrompt: event.target.value })
                    }
                    rows={3}
                  />
                </label>
              </div>
            </section>
          )}

          <aside className="script-inspector">
            <span className="eyebrow">SCENE HEALTH</span>
            <h3>节奏检查</h3>
            <div className="scene-health">
              <div>
                <span>旁白时长</span>
                <strong>{estimate.toFixed(1)}s</strong>
              </div>
              <div>
                <span>场景时长</span>
                <strong>{scene?.duration.toFixed(1)}s</strong>
              </div>
              <div>
                <span>语速预留</span>
                <strong>
                  {Math.max(0, (scene?.duration ?? 0) - estimate).toFixed(1)}s
                </strong>
              </div>
            </div>
            <Pill
              tone={
                scene && Math.abs(scene.duration - estimate) <= 2
                  ? "success"
                  : "warning"
              }
              dot
            >
              {scene && Math.abs(scene.duration - estimate) <= 2
                ? "节奏平衡"
                : "建议复核时长"}
            </Pill>
            <div className="inspector-divider" />
            <label className="compact-field">
              <span>镜头类型</span>
              <select
                value={scene?.shotType}
                onChange={(event) => patchScene({ shotType: event.target.value })}
              >
                <option>Hook</option>
                <option>Explainer</option>
                <option>Diagram</option>
                <option>Evidence</option>
                <option>Takeaway</option>
              </select>
            </label>
            <label className="compact-field">
              <span>转场</span>
              <select
                value={scene?.transition}
                onChange={(event) => patchScene({ transition: event.target.value })}
              >
                <option>柔光淡入</option>
                <option>横向推移</option>
                <option>遮罩展开</option>
                <option>直接切换</option>
              </select>
            </label>
            <label className="compact-field">
              <span>场景时长</span>
              <div className="number-field">
                <Clock3 size={14} />
                <input
                  type="number"
                  min={2}
                  max={60}
                  step={0.5}
                  value={scene?.duration}
                  onChange={(event) =>
                    patchScene({ duration: Math.max(2, Number(event.target.value)) })
                  }
                />
                <span>秒</span>
              </div>
            </label>
            <div className="script-tip">
              <Sparkles size={16} />
              <p>
                先让旁白只承担一个理解动作，再把复杂信息留给画面。
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
