import {
  ArrowRight,
  Bot,
  Clapperboard,
  Clock3,
  Copy,
  FolderOpen,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { ScenePreview } from "../components/ScenePreview";
import { Button, EmptyState, IconButton, Pill } from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { ProjectStage, VideoProject } from "../types";
import { projectDuration, truncate } from "../utils";
import { isTauriDesktop } from "../services/desktop";
import { importDesktopProjectPackage } from "../services/desktop";
import "./Dashboard.css";

const starters = [
  "为什么夜空是黑色的？",
  "晶体如何记住一段旋律？",
  "大语言模型怎样理解上下文？",
  "没有钟表的文明如何计量时间？",
];

const stageMeta: Record<ProjectStage, { label: string; path: string }> = {
  planning: { label: "内容策划", path: "plan" },
  script: { label: "脚本编辑", path: "script" },
  storyboard: { label: "分镜", path: "storyboard" },
  assets: { label: "图片素材", path: "assets" },
  animation: { label: "动画", path: "animation" },
  timeline: { label: "时间轴", path: "timeline" },
  audio: { label: "音频与字幕", path: "audio" },
  render: { label: "视频渲染", path: "render" },
};

function projectRoute(project: VideoProject) {
  return `/projects/${project.id}/${stageMeta[project.stage].path}`;
}

function ProjectCard({
  project,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  project: VideoProject;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const scene = project.scenes[project.stage === "render" ? project.scenes.length - 1 : 0];
  const asset = project.assets.find((item) => item.id === scene?.assetId);

  useEffect(() => {
    if (!menu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  return (
    <article className="project-card">
      <button type="button" className="project-card__preview" onClick={onOpen}>
        <ScenePreview
          scene={scene}
          asset={asset}
          assets={project.assets}
          ratio={project.settings.aspectRatio}
        />
        <span className="project-card__play">
          <Play size={16} fill="currentColor" />
        </span>
      </button>
      <div className="project-card__body">
        <div className="project-card__title">
          <div>
            <div className="project-card__pills">
              <Pill tone={project.isDemo ? "info" : "neutral"}>
                {project.isDemo ? "示例" : "草稿"}
              </Pill>
              <span>{project.settings.contentType}</span>
              <span className="project-card__stage">
                {stageMeta[project.stage].label}
              </span>
            </div>
            <h3>{project.title}</h3>
          </div>
          <div className="menu-wrap" ref={menuRef}>
            <IconButton
              label="项目菜单"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={(event) => {
                event.stopPropagation();
                setMenu(!menu);
              }}
            >
              <MoreHorizontal size={17} />
            </IconButton>
            {menu && (
              <div className="context-menu" role="menu" aria-label={`${project.title} 项目操作`}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onOpen();
                  }}
                >
                  <FolderOpen size={15} /> 打开项目
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onDuplicate();
                  }}
                >
                  <Copy size={15} /> 复制项目
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setMenu(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={15} /> 删除项目
                </button>
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="project-card__open"
          onClick={onOpen}
          aria-label={`继续编辑 ${project.title}`}
        >
          <span>
            <Clock3 size={14} />
            {Math.round(projectDuration(project))}s
          </span>
          <span>
            <Clapperboard size={14} />
            {project.scenes.length} 场
          </span>
          <span>
            {project.settings.aspectRatio}
          </span>
          <ArrowRight size={15} />
        </button>
      </div>
    </article>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const projects = useStudioStore((state) => state.projects);
  const duplicateProject = useStudioStore((state) => state.duplicateProject);
  const addProject = useStudioStore((state) => state.addProject);
  const deleteProject = useStudioStore((state) => state.deleteProject);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen);
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      `${project.title} ${project.settings.topic}`.toLowerCase().includes(query),
    );
  }, [projects, search]);

  const activeProject = useMemo(
    () =>
      [...projects].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0],
    [projects],
  );
  const totalScenes = projects.reduce((sum, project) => sum + project.scenes.length, 0);
  const heroScene =
    activeProject?.scenes[
      activeProject.stage === "render"
        ? Math.max(0, activeProject.scenes.length - 1)
        : 0
    ];
  const heroAsset = activeProject?.assets.find(
    (asset) => asset.id === heroScene?.assetId,
  );
  const heroPreviewTime =
    (heroScene?.layers.find((layer) => layer.type === "text")?.start ?? 0) + 0.8;

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  useEffect(() => {
    const focusSearchFromKeyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener("keydown", focusSearchFromKeyboard);
    return () =>
      document.removeEventListener("keydown", focusSearchFromKeyboard);
  }, [focusSearch]);

  const startProject = () => {
    const clean = topic.trim();
    navigate(clean ? `/projects/new?topic=${encodeURIComponent(clean)}` : "/projects/new");
  };

  const importProject = async () => {
    if (!isTauriDesktop) {
      pushToast({
        type: "info",
        title: "项目包导入需要桌面版",
        message: "桌面版可以导入包含素材的 .knowmotion.zip。",
      });
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "KnowMotion 项目包", extensions: ["zip"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const project = await importDesktopProjectPackage(selected);
      if (!project) return;
      addProject(project);
      pushToast({
        type: "success",
        title: "项目包已导入",
        message: "项目与素材已复制到本地项目目录。",
      });
      navigate(projectRoute(project));
    } catch (error) {
      pushToast({
        type: "error",
        title: "项目包导入失败",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="dashboard-page mx-auto w-full max-w-[1530px] px-4 pb-10 pt-7 xl:px-8">
      <div className="dashboard-topline">
        <div>
          <h1>今天想把什么讲清楚？</h1>
          <p>
            {projects.length
              ? `${projects.length} 个项目，${totalScenes} 个场景。继续手上的作品，或从一个新问题开始。`
              : "从一个具体的问题开始，让研究、脚本和画面在同一个项目里生长。"}
          </p>
        </div>
        <div className="dashboard-topline__actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<Search size={15} />}
            onClick={focusSearch}
            aria-keyshortcuts="Control+K"
          >
            查找项目
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<WandSparkles size={15} />}
            onClick={() => setAssistantOpen(true)}
          >
            工作区助手
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Upload size={15} />}
            onClick={() => void importProject()}
          >
            导入项目包
          </Button>
        </div>
      </div>

      <section className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <h2>
            从一个好问题开始。
            <br />
            <span>先讲清楚，再做漂亮。</span>
          </h2>
          <p>
            写下观众真正想弄懂的问题。你会先得到可编辑的内容结构，再进入脚本、分镜和动画。
          </p>
          <div className="hero-composer">
            <span className="hero-composer__icon">
              <Bot size={20} />
            </span>
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") startProject();
              }}
              placeholder="输入一个你想讲清楚的知识主题…"
              aria-label="视频知识主题"
            />
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={startProject}
            >
              开始策划
            </Button>
          </div>
          <div className="hero-starters">
            <span>从这些问题开始</span>
            {starters.slice(0, 3).map((starter) => (
              <button
                type="button"
                key={starter}
                onClick={() => setTopic(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
        <div className="dashboard-hero__visual">
          {activeProject ? (
            <button
              type="button"
              className="hero-project-preview"
              onClick={() => navigate(projectRoute(activeProject))}
              aria-label={`继续 ${activeProject.title}`}
            >
              <div className="hero-project-preview__head">
                <div>
                  <small>继续上次</small>
                  <strong>{stageMeta[activeProject.stage].label}</strong>
                </div>
                <Pill tone="accent" dot>
                  {activeProject.isDemo ? "示例项目" : "草稿"}
                </Pill>
              </div>
              <div className="hero-project-preview__frame">
                <ScenePreview
                  scene={heroScene}
                  asset={heroAsset}
                  assets={activeProject.assets}
                  ratio={activeProject.settings.aspectRatio}
                  time={heroPreviewTime}
                />
              </div>
              <div className="hero-project-preview__foot">
                <div>
                  <strong>{truncate(activeProject.title, 34)}</strong>
                  <small>
                    {Math.round(projectDuration(activeProject))}s ·{" "}
                    {activeProject.scenes.length} 个场景
                  </small>
                </div>
                <ArrowRight size={17} />
              </div>
            </button>
          ) : (
            <div className="hero-project-empty">
              <span>
                <Sparkles size={19} />
              </span>
              <h3>你的第一支知识动画</h3>
              <p>主题确定后，项目会把每一步产物留在同一个上下文里。</p>
            </div>
          )}
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="recent-section">
          <header className="section-heading">
            <div>
              <h2>最近项目</h2>
              <p>
                {visibleProjects.length} 个项目
                {search.trim() ? "符合搜索" : "可按最近更新时间继续"}
              </p>
            </div>
            <div className="section-heading__tools">
              <label className="search-field" htmlFor="project-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  id="project-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                  aria-keyshortcuts="Control+K"
                />
                <span className="search-field__shortcut" aria-hidden="true">
                  Ctrl K
                </span>
              </label>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={15} />}
                onClick={() => navigate("/projects/new")}
              >
                新建
              </Button>
            </div>
          </header>
          {visibleProjects.length ? (
            <div className="project-grid">
              {visibleProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => navigate(projectRoute(project))}
                  onDuplicate={() => {
                    const id = duplicateProject(project.id);
                    if (id) {
                      pushToast({ type: "success", title: "项目已复制" });
                      const duplicated = useStudioStore
                        .getState()
                        .projects.find((item) => item.id === id);
                      navigate(
                        duplicated
                          ? projectRoute(duplicated)
                          : `/projects/${id}/plan`,
                      );
                    }
                  }}
                  onDelete={() => {
                    if (
                      window.confirm(
                        `删除「${project.title}」？桌面版会把完整项目目录移入可恢复归档。`,
                      )
                    ) {
                      deleteProject(project.id);
                      pushToast({ type: "info", title: "项目已删除" });
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Search size={22} />}
              title="没有匹配的项目"
              description="换一个关键词，或从一个新的知识主题开始。"
              action={
                <Button variant="secondary" onClick={() => setSearch("")}>
                  清除搜索
                </Button>
              }
            />
          )}
        </section>

        <aside className="dashboard-side">
          <section className="capability-card">
            <header>
              <div>
                <span className="capability-card__kicker">工作区状态</span>
                <h3>创作管线</h3>
              </div>
              <span className="capability-dot" />
            </header>
            <div className="capability-list">
              {[
                ["内容结构", activeProject?.outline.length ? "已生成" : "待生成"],
                ["脚本与分镜", activeProject?.scenes.length ? "可编辑" : "未开始"],
                ["视觉素材", activeProject?.assets.length ? "已关联" : "待生成"],
                ["渲染运行时", "需桌面服务"],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="text-link"
              onClick={() => navigate("/settings/models")}
            >
              检查 AI 模型配置 <ArrowRight size={13} />
            </button>
          </section>

          {activeProject ? (
            <button
              type="button"
              className="idea-card"
              onClick={() => {
                updateProject(activeProject.id, { stage: "planning" });
                navigate(`/projects/${activeProject.id}/plan`);
              }}
            >
              <span><WandSparkles size={18} /></span>
              <div>
                <strong>回到内容策略</strong>
                <small>重新检查主题、结构与叙事方式</small>
              </div>
              <ArrowRight size={15} />
            </button>
          ) : (
            <button
              type="button"
              className="idea-card"
              onClick={() => navigate("/projects/new")}
            >
              <span><Plus size={18} /></span>
              <div>
                <strong>创建第一个项目</strong>
                <small>从一个待解释的问题开始</small>
              </div>
              <ArrowRight size={15} />
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
