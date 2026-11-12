import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Copy,
  FileImage,
  Film,
  FolderOpen,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScenePreview } from "../components/ScenePreview";
import { Button, EmptyState, IconButton, Pill, Progress } from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { VideoProject } from "../types";
import { projectDuration, truncate } from "../utils";

const starters = [
  "为什么夜空是黑色的？",
  "晶体如何记住一段旋律？",
  "大语言模型怎样理解上下文？",
  "没有钟表的文明如何计量时间？",
];

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
  const scene = project.scenes[project.stage === "render" ? project.scenes.length - 1 : 0];
  const asset = project.assets.find((item) => item.id === scene?.assetId);
  return (
    <article className="project-card">
      <button type="button" className="project-card__preview" onClick={onOpen}>
        <ScenePreview scene={scene} asset={asset} ratio={project.settings.aspectRatio} />
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
            </div>
            <h3>{project.title}</h3>
          </div>
          <div className="menu-wrap">
            <IconButton
              label="项目菜单"
              onClick={(event) => {
                event.stopPropagation();
                setMenu(!menu);
              }}
            >
              <MoreHorizontal size={17} />
            </IconButton>
            {menu && (
              <div className="context-menu">
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    onOpen();
                  }}
                >
                  <FolderOpen size={15} /> 打开项目
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    onDuplicate();
                  }}
                >
                  <Copy size={15} /> 复制项目
                </button>
                <button
                  type="button"
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
        <button type="button" className="project-card__open" onClick={onOpen}>
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
  const deleteProject = useStudioStore((state) => state.deleteProject);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen);
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");

  const visibleProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      `${project.title} ${project.settings.topic}`.toLowerCase().includes(query),
    );
  }, [projects, search]);

  const activeProject = projects[0];
  const totalScenes = projects.reduce((sum, project) => sum + project.scenes.length, 0);

  const startProject = () => {
    const clean = topic.trim();
    navigate(clean ? `/projects/new?topic=${encodeURIComponent(clean)}` : "/projects/new");
  };

  return (
    <div className="dashboard-page">
      <div className="dashboard-topline">
        <div>
          <span className="eyebrow">WEDNESDAY · CREATIVE DESK</span>
          <h1>把知识，变成会呼吸的画面。</h1>
        </div>
        <div className="dashboard-topline__actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<Search size={15} />}
            onClick={() => {
              const input = document.getElementById("project-search");
              input?.focus();
            }}
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
        </div>
      </div>

      <section className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <span className="hero-kicker">
            <Sparkles size={14} />
            THE AI KNOWLEDGE ANIMATION WORKSTATION
          </span>
          <h2>
            从一个主题开始，
            <br />
            <span>让 AI 帮你完成整支片子。</span>
          </h2>
          <p>
            研究、结构、脚本、分镜和动画共用同一个项目上下文。你负责判断，
            AI 负责把想法变成可以预览的画面。
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
            <span>试试：</span>
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
        <div className="dashboard-hero__visual" aria-hidden="true">
          <div className="hero-visual__frame">
            <div className="hero-visual__top">
              <span>SCENE 03 / 05</span>
              <span className="hero-visual__live">
                <i />
                LIVE PREVIEW
              </span>
            </div>
            <div className="hero-visual__scene">
              <span className="hero-visual__index">03</span>
              <div className="hero-visual__orb">
                <i />
                <i />
                <i />
              </div>
              <div className="hero-visual__title">信息，比光走得更远</div>
              <div className="hero-visual__lines">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="hero-visual__timeline">
              <span />
              <span />
              <span />
              <i />
            </div>
          </div>
          <span className="hero-orbit hero-orbit--one" />
          <span className="hero-orbit hero-orbit--two" />
          <div className="hero-float-card hero-float-card--top">
            <span>
              <FileImage size={15} />
            </span>
            <div>
              <small>VISUAL DIRECTION</small>
              <strong>Editorial science</strong>
            </div>
          </div>
          <div className="hero-float-card hero-float-card--bottom">
            <span className="hero-float-card__number">42</span>
            <div>
              <small>PROJECT SECONDS</small>
              <strong>节奏已平衡</strong>
            </div>
          </div>
        </div>
      </section>

      <div className="dashboard-stats">
        <div className="stat-card">
          <span className="stat-card__icon"><Film size={17} /></span>
          <div>
            <strong>{String(projects.length).padStart(2, "0")}</strong>
            <span>知识项目</span>
          </div>
          <small>Local workspace</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__icon"><Clapperboard size={17} /></span>
          <div>
            <strong>{String(totalScenes).padStart(2, "0")}</strong>
            <span>场景草稿</span>
          </div>
          <small>Across projects</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__icon"><CheckCircle2 size={17} /></span>
          <div>
            <strong>{projects.filter((project) => project.outlineApproved).length}</strong>
            <span>策划已审批</span>
          </div>
          <small>Ready to produce</small>
        </div>
        <button
          type="button"
          className="stat-card stat-card--action"
          onClick={() => navigate("/settings/models")}
        >
          <span className="stat-card__icon"><Sparkles size={17} /></span>
          <div>
            <strong>2</strong>
            <span>创作能力入口</span>
          </div>
          <small>配置 AI 模型 <ArrowRight size={13} /></small>
        </button>
      </div>

      <div className="dashboard-grid">
        <section className="recent-section">
          <header className="section-heading">
            <div>
              <span className="eyebrow">YOUR PROJECTS</span>
              <h2>继续创作</h2>
            </div>
            <div className="section-heading__tools">
              <label className="search-field">
                <Search size={15} />
                <input
                  id="project-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索项目"
                />
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
                  onOpen={() => navigate(`/projects/${project.id}/plan`)}
                  onDuplicate={() => {
                    const id = duplicateProject(project.id);
                    if (id) {
                      pushToast({ type: "success", title: "项目已复制" });
                      navigate(`/projects/${id}/plan`);
                    }
                  }}
                  onDelete={() => {
                    if (
                      window.confirm(
                        `删除「${project.title}」？此操作仅影响浏览器本地项目。`,
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
          <section className="focus-card">
            <header>
              <span className="eyebrow">PRODUCTION FOCUS</span>
              <Pill tone="accent" dot>进行中</Pill>
            </header>
            {activeProject ? (
              <>
                <h3>{truncate(activeProject.title, 32)}</h3>
                <p>{activeProject.settings.topic}</p>
                <div className="focus-card__progress">
                  <span>
                    <strong>当前阶段</strong>
                    <small>
                      {["策划", "脚本", "分镜", "动画", "渲染"][
                        Math.min(4, Math.floor(activeProject.scenes.length / 2))
                      ]}
                    </small>
                  </span>
                  <span>{Math.min(92, Math.max(24, activeProject.scenes.length * 12))}%</span>
                </div>
                <Progress
                  value={Math.min(92, Math.max(24, activeProject.scenes.length * 12))}
                />
                <Button
                  variant="soft"
                  className="focus-card__button"
                  icon={<ArrowRight size={15} />}
                  onClick={() => navigate(`/projects/${activeProject.id}/storyboard`)}
                >
                  继续编辑分镜
                </Button>
              </>
            ) : (
              <p>还没有正在进行的项目。</p>
            )}
          </section>

          <section className="capability-card">
            <header>
              <span className="eyebrow">CAPABILITY</span>
              <span className="capability-dot" />
            </header>
            <h3>创作管线</h3>
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
              <strong>继续完善内容策略</strong>
              <small>从当前项目上下文继续</small>
            </div>
            <ArrowRight size={15} />
          </button>
        </aside>
      </div>
    </div>
  );
}
