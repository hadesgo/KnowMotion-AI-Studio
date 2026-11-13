import {
  AudioLines,
  Blocks,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  FileText,
  Film,
  FolderKanban,
  Gauge,
  Image,
  LayoutDashboard,
  ListTree,
  MonitorPlay,
  Network,
  PlaySquare,
  Plus,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useStudioStore } from "../store/studio";
import { projectDuration } from "../utils";
import { isTauriDesktop } from "../services/desktop";
import { AssistantDrawer } from "./AssistantDrawer";
import { TitleBar } from "./TitleBar";
import { Button, Toasts } from "./ui";
import "./AppShell.css";

const projectSteps = [
  { path: "workflow", label: "Agent 工作流", icon: Network },
  { path: "plan", label: "AI 内容策划", icon: Sparkles },
  { path: "script", label: "脚本编辑", icon: FileText },
  { path: "storyboard", label: "分镜工作区", icon: LayoutDashboard },
  { path: "assets", label: "图片素材", icon: Image },
  { path: "animation", label: "动画编辑", icon: Clapperboard },
  { path: "remotion", label: "Remotion Studio", icon: PlaySquare },
  { path: "timeline", label: "时间轴", icon: ListTree },
  { path: "audio", label: "音频与字幕", icon: AudioLines },
  { path: "render", label: "视频渲染", icon: MonitorPlay },
] as const;

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const projects = useStudioStore((state) => state.projects);
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen);
  const assistantOpen = useStudioStore((state) => state.assistantOpen);
  const project = projects.find((item) => item.id === projectId);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  useEffect(() => {
    const persistApi = useStudioStore.persist;
    const flushHydratedState = () => {
      const state = useStudioStore.getState();
      useStudioStore.setState({
        projects: [...state.projects],
        providers: [...state.providers],
      });
    };
    if (persistApi.hasHydrated()) {
      flushHydratedState();
      return;
    }
    return persistApi.onFinishHydration(flushHydratedState);
  }, []);

  const stepState = useMemo(() => {
    if (!project) return new Map<string, "done" | "active" | "todo">();
    return new Map<string, "done" | "active" | "todo">([
      ["workflow", location.pathname.endsWith("/workflow") ? "active" : "todo"],
      ["plan", project.outline.length ? "done" : location.pathname.endsWith("/plan") ? "active" : "todo"],
      [
        "script",
        project.scenes.length
          ? project.stage === "script" || location.pathname.endsWith("/script")
            ? "active"
            : "done"
          : "todo",
      ],
      ["storyboard", project.scenes.some((scene) => scene.description) ? "done" : "todo"],
      ["assets", project.assets.length ? "done" : "todo"],
      ["animation", project.scenes.some((scene) => scene.layers.length > 1) ? "done" : "todo"],
      ["remotion", project.scenes.length ? "done" : "todo"],
      ["timeline", project.timeline.length ? "done" : "todo"],
      ["audio", project.subtitles.length ? "done" : "todo"],
      ["render", project.renders.length ? "done" : "todo"],
    ]);
  }, [location.pathname, project]);

  return (
    <div className="app-shell min-h-screen bg-studio-canvas text-studio-text antialiased">
      <TitleBar />
      <aside className="sidebar">
        <nav className="sidebar__main">
          <span className="sidebar__label">STUDIO</span>
          <NavLink to="/" end>
            <LayoutDashboard size={17} />
            Dashboard
          </NavLink>
          <NavLink to="/projects/new">
            <Plus size={17} />
            新建项目
          </NavLink>
          <NavLink to="/settings/models">
            <Blocks size={17} />
            AI 模型
          </NavLink>
        </nav>

        {project ? (
          <nav className="sidebar__project" aria-label="项目创作流程">
            <div className="sidebar__project-head">
              <span className="sidebar__label">CURRENT PROJECT</span>
              <button
                type="button"
                aria-label="项目 Dashboard"
                onClick={() => navigate("/")}
              >
                <FolderKanban size={14} />
              </button>
            </div>
            <div className="project-mini">
              <span className="project-mini__cover">
                <Film size={17} />
              </span>
              <span>
                <strong>{project.title}</strong>
                <small>
                  {project.settings.aspectRatio} · {Math.round(projectDuration(project))}s
                </small>
              </span>
            </div>
            <div className="workflow-nav">
              {projectSteps.map((step, index) => {
                const state = stepState.get(step.path) ?? "todo";
                const active = location.pathname.endsWith(`/${step.path}`);
                const Icon = step.icon;
                return (
                  <NavLink
                    key={step.path}
                    to={`/projects/${project.id}/${step.path}`}
                    className={active ? "is-active" : ""}
                  >
                    <span className={`workflow-nav__index workflow-nav__index--${state}`}>
                      {state === "done" && !active ? (
                        <span>✓</span>
                      ) : state === "active" || active ? (
                        <span className="workflow-nav__pulse" />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <Icon size={16} />
                    <span>{step.label}</span>
                    {active && <ChevronRight size={14} />}
                  </NavLink>
                );
              })}
            </div>
          </nav>
        ) : (
          <div className="sidebar__aside">
            <span className="eyebrow">CREATIVE LOOP</span>
            <p>研究、策划、分镜、动画和渲染，都在同一个项目上下文里完成。</p>
            <span className="sidebar__aside-line" />
            <small>12:00 · Local workspace</small>
          </div>
        )}

        <div className="sidebar__footer">
          <NavLink to="/settings/models">
            <Settings2 size={16} />
            设置
          </NavLink>
            <button type="button" onClick={() => setAssistantOpen(!assistantOpen)}>
            <CircleHelp size={16} />
            工作区助手
          </button>
          <div className="local-status">
            <span>
              <Gauge size={14} />
            </span>
            <div>
              <strong>{isTauriDesktop ? "桌面工作区" : "本地预览"}</strong>
              <small>{isTauriDesktop ? "SQLite · 项目目录" : "浏览器持久化"}</small>
            </div>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <main className="page-shell">
          <Outlet />
        </main>
      </div>
      <AssistantDrawer />
      <Toasts />
    </div>
  );
}

export function ProjectGuard({ children }: { children: React.ReactNode }) {
  const { projectId } = useParams();
  const projects = useStudioStore((state) => state.projects);
  const project = projects.find((item) => item.id === projectId);
  if (!project) {
    return (
      <div className="project-missing">
        <span>
          <FolderKanban size={24} />
        </span>
        <h1>项目不存在或已被删除</h1>
        <p>返回 Dashboard 打开另一个项目，或创建一个新的知识动画。</p>
        <Button variant="primary" onClick={() => window.location.assign("/")}>
          返回 Dashboard
        </Button>
      </div>
    );
  }
  return children;
}

// This module already exports React components whose refresh boundary owns this hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useCurrentProject() {
  const { projectId } = useParams();
  const projects = useStudioStore((state) => state.projects);
  return projects.find((item) => item.id === projectId);
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-heading__actions">{actions}</div>}
    </div>
  );
}
