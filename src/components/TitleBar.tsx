import {
  ArrowUpRight,
  Minus,
  Plus,
  Settings2,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStudioStore } from "../store/studio";
import { downloadText } from "../utils";
import {
  exportDesktopProject,
  flushDesktopStorage,
  isTauriDesktop,
} from "../services/desktop";
import { Button, IconButton, Pill } from "./ui";
import "./TitleBar.css";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const resizeDirections: {
  direction: ResizeDirection;
  className: string;
}[] = [
  { direction: "North", className: "resize-handle--n" },
  { direction: "South", className: "resize-handle--s" },
  { direction: "East", className: "resize-handle--e" },
  { direction: "West", className: "resize-handle--w" },
  { direction: "NorthEast", className: "resize-handle--ne" },
  { direction: "NorthWest", className: "resize-handle--nw" },
  { direction: "SouthEast", className: "resize-handle--se" },
  { direction: "SouthWest", className: "resize-handle--sw" },
];

export function TitleBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const projects = useStudioStore((state) => state.projects);
  const assistantOpen = useStudioStore((state) => state.assistantOpen);
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen);
  const pushToast = useStudioStore((state) => state.pushToast);
  const project = projects.find((item) => item.id === projectId);
  const [maximized, setMaximized] = useState(false);
  const appWindow = useMemo(
    () => (isTauriDesktop ? getCurrentWindow() : null),
    [],
  );

  useEffect(() => {
    if (!isTauriDesktop) return;
    document.documentElement.classList.add("tauri-window");
    let unlisten: (() => void) | undefined;
    void appWindow?.isMaximized().then((value) => {
      setMaximized(value);
      document.documentElement.classList.toggle("window-maximized", value);
    });
    void appWindow?.onResized(async () => {
      const value = (await appWindow.isMaximized()) ?? false;
      setMaximized(value);
      document.documentElement.classList.toggle("window-maximized", value);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
      document.documentElement.classList.remove("tauri-window");
      document.documentElement.classList.remove("window-maximized");
    };
  }, [appWindow]);

  const exportProject = async () => {
    if (!project) return;
    if (isTauriDesktop) {
      try {
        await flushDesktopStorage();
        const path = await exportDesktopProject(project);
        pushToast({
          type: "success",
          title: "可迁移项目包已导出",
          message: path ? `包含项目 JSON、素材与渲染记录：${path}` : undefined,
        });
      } catch (error) {
        pushToast({
          type: "error",
          title: "项目导出失败",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    downloadText(
      JSON.stringify({ ...project, isDemo: false }, null, 2),
      `${project.title.replace(/[\\/:*?"<>|]/g, "-")}.knowmotion.json`,
      "application/json",
    );
  };

  const toggleMaximize = async () => {
    if (!appWindow) return;
    await appWindow.toggleMaximize();
  };

  return (
    <>
      <header
        className="window-titlebar"
        data-tauri-drag-region
        onDoubleClick={() => void toggleMaximize()}
      >
        <button
          type="button"
          className="brand titlebar-brand"
          aria-label="返回 Dashboard"
          onClick={() => navigate("/")}
        >
          <span className="brand__mark">
            <span />
            <span />
          </span>
          <span className="brand__type">
            <strong>KnowMotion</strong>
            <small>AI STUDIO</small>
          </span>
        </button>
        <span className="titlebar-separator" data-tauri-drag-region />
        <div className="titlebar-context" data-tauri-drag-region>
          <span>{project ? "PROJECT" : "WORKSPACE"}</span>
          <i>/</i>
          <strong>
            {project
              ? project.title
              : location.pathname.includes("models")
                ? "AI 模型配置"
                : location.pathname.includes("new")
                  ? "新建项目"
                  : "Dashboard"}
          </strong>
          {project && (
            <Pill tone={project.isDemo ? "info" : "neutral"}>
              {project.isDemo ? "示例 · 可编辑" : "草稿"}
            </Pill>
          )}
        </div>
        <div className="titlebar-actions">
          {project && (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowUpRight size={14} />}
              onClick={() => void exportProject()}
            >
              导出
            </Button>
          )}
          <IconButton
            label="AI 模型"
            onClick={() => navigate("/settings/models")}
          >
            <Settings2 size={16} />
          </IconButton>
          <Button
            variant={assistantOpen ? "soft" : "secondary"}
            size="sm"
            icon={<WandSparkles size={15} />}
            onClick={() => setAssistantOpen(!assistantOpen)}
          >
            AI 助手
          </Button>
          <IconButton label="新建项目" onClick={() => navigate("/projects/new")}>
            <Plus size={17} />
          </IconButton>
          {isTauriDesktop && (
            <div className="window-controls">
              <button
                type="button"
                aria-label="最小化"
                onClick={() => void appWindow?.minimize()}
              >
                <Minus size={15} />
              </button>
              <button
                type="button"
                aria-label={maximized ? "还原" : "最大化"}
                onClick={() => void toggleMaximize()}
              >
                <Square size={12} />
              </button>
              <button
                type="button"
                className="window-control--close"
                aria-label="关闭"
                onClick={() => void appWindow?.close()}
              >
                <X size={15} />
              </button>
            </div>
          )}
        </div>
      </header>
      {isTauriDesktop &&
        resizeDirections.map(({ direction, className }) => (
          <div
            key={direction}
            className={`resize-handle ${className}`}
            onPointerDown={(event) => {
              event.preventDefault();
              void appWindow?.startResizeDragging(direction);
            }}
          />
        ))}
    </>
  );
}
