import {
  ArrowRight,
  AudioLines,
  Check,
  Clapperboard,
  CornerDownLeft,
  Layers3,
  Maximize2,
  MessageSquareText,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { createTimeline, generateOutlineDraft } from "../data/demo";
import { useStudioStore } from "../store/studio";
import type { SubtitleCue } from "../types";
import { makeId } from "../utils";
import { Button, IconButton } from "./ui";
import "./AssistantDrawer.css";

interface AssistantMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  done?: boolean;
}

const quickActions = [
  {
    label: "收紧节奏",
    description: "每个场景压缩约 15%",
    icon: <Maximize2 size={16} />,
  },
  {
    label: "添加场景",
    description: "在故事板末尾补充一镜",
    icon: <Clapperboard size={16} />,
  },
  {
    label: "生成字幕",
    description: "根据旁白创建时间线索",
    icon: <MessageSquareText size={16} />,
  },
  {
    label: "改为竖屏",
    description: "切换为 9:16 短视频画幅",
    icon: <Layers3 size={16} />,
  },
];

export function AssistantDrawer() {
  const { projectId } = useParams();
  const open = useStudioStore((state) => state.assistantOpen);
  const setOpen = useStudioStore((state) => state.setAssistantOpen);
  const projects = useStudioStore((state) => state.projects);
  const updateProject = useStudioStore((state) => state.updateProject);
  const addScene = useStudioStore((state) => state.addScene);
  const pushToast = useStudioStore((state) => state.pushToast);
  const project = projects.find((item) => item.id === projectId);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: makeId("msg"),
      role: "assistant",
      content:
        "我在当前项目上下文中工作。你可以让我调整节奏、补充分镜、生成字幕或切换画幅。每项操作都会直接写入项目。",
    },
  ]);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusFrame = window.requestAnimationFrame(() => {
      drawerRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;

      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open, setOpen]);

  const contextLabel = useMemo(() => {
    if (!project) return "未打开项目";
    return `${project.scenes.length} 个场景 · ${project.settings.duration} 秒目标`;
  }, [project]);

  const addMessage = (
    role: AssistantMessage["role"],
    content: string,
    done?: boolean,
  ) => {
    setMessages((items) => [
      ...items,
      { id: makeId("msg"), role, content, done },
    ]);
  };

  const applyAction = (command: string) => {
    if (!project) {
      pushToast({
        type: "error",
        title: "需要先打开项目",
        message: "工作区动作只能在项目上下文中执行。",
      });
      return;
    }

    if (/收紧|加快|缩短|节奏/.test(command)) {
      updateProject(project.id, (current) => ({
        ...current,
        scenes: current.scenes.map((scene) => ({
          ...scene,
          duration: Math.max(2, Math.round(scene.duration * 0.85 * 10) / 10),
        })),
        timeline: createTimeline(
          current.scenes.map((scene) => ({
            ...scene,
            duration: Math.max(2, Math.round(scene.duration * 0.85 * 10) / 10),
          })),
        ),
      }));
      addMessage("assistant", "已将每个场景压缩约 15%，并重建视频与旁白时间轴。", true);
      pushToast({ type: "success", title: "项目节奏已收紧" });
      return;
    }

    if (/添加|新增|补充.*场景|更多场景/.test(command)) {
      const sceneId = addScene(project.id);
      addMessage(
        "assistant",
        `已新增场景 ${sceneId.slice(-4)}。你可以在分镜工作区修改画面描述和旁白。`,
        true,
      );
      pushToast({ type: "success", title: "已添加新场景" });
      return;
    }

    if (/竖直|竖屏|9:16/.test(command)) {
      updateProject(project.id, (current) => ({
        ...current,
        settings: { ...current.settings, aspectRatio: "9:16" },
      }));
      addMessage("assistant", "画幅已切换为 9:16，动画与渲染页面会使用竖屏预览。", true);
      pushToast({ type: "success", title: "画幅已切换为 9:16" });
      return;
    }

    if (/横屏|16:9/.test(command)) {
      updateProject(project.id, (current) => ({
        ...current,
        settings: { ...current.settings, aspectRatio: "16:9" },
      }));
      addMessage("assistant", "画幅已恢复为 16:9 横屏。", true);
      pushToast({ type: "success", title: "画幅已切换为 16:9" });
      return;
    }

    if (/字幕/.test(command)) {
      let cursor = 0;
      const cues: SubtitleCue[] = [];
      project.scenes.forEach((scene) => {
        const chunks = scene.narration
          .split(/(?<=[。！？])/)
          .map((item) => item.trim())
          .filter(Boolean);
        const source = chunks.length ? chunks : [scene.narration];
        const share = scene.duration / source.length;
        source.forEach((text, index) => {
          cues.push({
            id: makeId("sub"),
            sceneId: scene.id,
            start: Number((cursor + index * share).toFixed(2)),
            end: Number((cursor + (index + 1) * share).toFixed(2)),
            text,
          });
        });
        cursor += scene.duration;
      });
      updateProject(project.id, { subtitles: cues });
      addMessage(
        "assistant",
        `已根据 ${project.scenes.length} 个场景生成 ${cues.length} 条字幕，可在音频与字幕页面继续编辑。`,
        true,
      );
      pushToast({ type: "success", title: "字幕时间线已生成" });
      return;
    }

    if (/旁白|文案|润色/.test(command)) {
      updateProject(project.id, (current) => ({
        ...current,
        scenes: current.scenes.map((scene) => ({
          ...scene,
          narration:
            scene.narration.includes("换句话说")
              ? scene.narration
              : `${scene.narration.replace(/。$/, "")}。换句话说，${scene.title}并不只是画面上的答案，而是一条可以被验证的线索。`,
        })),
      }));
      addMessage("assistant", "已为每个场景补充解释性衔接句，并保持原有时长。", true);
      pushToast({ type: "success", title: "旁白已更新" });
      return;
    }

    if (/大纲|结构/.test(command)) {
      const outline = generateOutlineDraft(project, "悬念驱动");
      updateProject(project.id, { outline, outlineApproved: false });
      addMessage("assistant", "已生成一版五段式结构草案，等待你在策划页面审批。", true);
      pushToast({ type: "success", title: "结构草案已更新" });
      return;
    }

    addMessage(
      "assistant",
      "这版前端助手只执行可验证的工作区动作。你可以使用上方快捷动作，或输入“收紧节奏”“添加场景”“生成字幕”“改为竖屏”。",
    );
  };

  const submit = () => {
    const command = input.trim();
    if (!command) return;
    addMessage("user", command);
    setInput("");
    window.setTimeout(() => applyAction(command), 180);
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="关闭助手"
        onClick={() => setOpen(false)}
      />
      <aside
        ref={drawerRef}
        className="assistant-drawer"
        aria-label="AI 工作区助手"
        aria-modal="true"
        role="dialog"
      >
        <header className="assistant-drawer__header">
          <div className="assistant-title">
            <span className="assistant-orb">
              <Sparkles size={16} />
            </span>
            <div>
              <strong>Workspace Copilot</strong>
              <span>{contextLabel}</span>
            </div>
          </div>
          <IconButton
            label="关闭助手"
            onClick={() => setOpen(false)}
            data-autofocus
          >
            <X size={18} />
          </IconButton>
        </header>

        <div className="assistant-context">
          <span className="eyebrow">LOCAL ACTION MODE</span>
          <p>
            当前执行基于项目结构的本地动作。真实模型连接将在桌面 Provider
            接入后启用。
          </p>
        </div>

        <div className="assistant-quick">
          {quickActions.map((action) => (
            <button
              type="button"
              key={action.label}
              onClick={() => {
                addMessage("user", action.label);
                window.setTimeout(() => applyAction(action.label), 160);
              }}
            >
              <span>{action.icon}</span>
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>

        <div className="assistant-messages" aria-live="polite">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`assistant-message assistant-message--${message.role}`}
            >
              {message.role === "assistant" && (
                <span className="assistant-message__mark">
                  <WandSparkles size={13} />
                </span>
              )}
              <p>{message.content}</p>
              {message.done && (
                <span className="assistant-message__done">
                  <Check size={12} /> 已写入项目
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="assistant-composer">
          <div className="assistant-composer__input">
            <AudioLines size={17} />
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="描述你想调整的内容…"
              aria-label="描述你想调整的内容"
              disabled={!project}
            />
            <Button
              size="sm"
              variant="primary"
              icon={<CornerDownLeft size={15} />}
              onClick={submit}
              disabled={!project || !input.trim()}
              aria-label="发送动作"
            />
          </div>
          <small>本地动作可直接撤销；重新生成后可覆盖草稿。</small>
        </div>
      </aside>
    </>
  );
}
