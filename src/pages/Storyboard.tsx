import {
  ArrowRight,
  Clapperboard,
  Copy,
  Film,
  GripVertical,
  Image,
  LayoutGrid,
  List,
  Plus,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import {
  Button,
  EmptyState,
  IconButton,
  Pill,
  Segmented,
  TextArea,
  TextInput,
} from "../components/ui";
import { buildScenesFromOutline, createTimeline, generateOutlineDraft } from "../data/demo";
import { useStudioStore } from "../store/studio";
import type { Scene } from "../types";
import { truncate } from "../utils";
import "./Storyboard.css";

type ViewMode = "grid" | "list" | "filmstrip";

export default function Storyboard() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const addScene = useStudioStore((state) => state.addScene);
  const reorderScenes = useStudioStore((state) => state.reorderScenes);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedId, setSelectedId] = useState(project?.scenes[0]?.id ?? "");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (!project) return null;
  const effectiveSelectedId = project.scenes.some(
    (scene) => scene.id === selectedId,
  )
    ? selectedId
    : (project.scenes[0]?.id ?? "");
  const selectedIndex = project.scenes.findIndex(
    (scene) => scene.id === effectiveSelectedId,
  );
  const selected = project.scenes[selectedIndex];

  const patchScene = (patch: Partial<Scene>) => {
    updateProject(project.id, (current) => ({
      ...current,
      stage: "storyboard",
      scenes: current.scenes.map((scene) =>
        scene.id === effectiveSelectedId ? { ...scene, ...patch } : scene,
      ),
    }));
  };

  const generateStoryboard = () => {
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
      stage: "storyboard",
    });
    setSelectedId(scenes[0]?.id ?? "");
    pushToast({
      type: "success",
      title: "分镜已重建",
      message: `${scenes.length} 个场景已生成画面描述与转场建议。`,
    });
  };

  const duplicate = (scene: Scene) => {
    const copy: Scene = {
      ...structuredClone(scene),
      id: `${scene.id}-copy-${Date.now()}`,
      title: `${scene.title} · 副本`,
      layers: scene.layers.map((layer) => ({ ...layer, id: `${layer.id}-copy` })),
    };
    const index = project.scenes.findIndex((item) => item.id === scene.id);
    const scenes = [...project.scenes];
    scenes.splice(index + 1, 0, copy);
    updateProject(project.id, { scenes, timeline: createTimeline(scenes) });
    setSelectedId(copy.id);
    pushToast({ type: "success", title: "场景已复制" });
  };

  const remove = (scene: Scene) => {
    if (project.scenes.length <= 1) {
      pushToast({ type: "error", title: "至少保留一个场景" });
      return;
    }
    if (!window.confirm(`删除场景「${scene.title}」？`)) return;
    const scenes = project.scenes.filter((item) => item.id !== scene.id);
    updateProject(project.id, { scenes, timeline: createTimeline(scenes) });
    setSelectedId(scenes[0].id);
    pushToast({ type: "info", title: "场景已删除" });
  };

  const add = () => {
    const id = addScene(project.id);
    setSelectedId(id);
    pushToast({ type: "success", title: "新场景已添加" });
  };

  return (
    <div className="storyboard-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="VISUAL STORYBOARD"
        title="先让每一镜只讲清一件事"
        description="拖动卡片调整叙事顺序，修改画面建议，再把场景送入素材与动画阶段。"
        actions={
          <>
            <Button
              variant="soft"
              icon={<Sparkles size={16} />}
              onClick={generateStoryboard}
            >
              生成分镜草案
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={add}>
              添加场景
            </Button>
          </>
        }
      />

      <div className="storyboard-toolbar">
        <div className="storyboard-toolbar__stats">
          <span>
            <strong>{project.scenes.length}</strong> 场景
          </span>
          <i />
          <span>
            <strong>
              {project.scenes.reduce((sum, scene) => sum + scene.duration, 0).toFixed(0)}
            </strong>{" "}
            秒
          </span>
          <i />
          <span>
            <strong>{project.assets.length}</strong> 素材
          </span>
        </div>
        <Segmented
          value={view}
          onChange={setView}
          label="分镜视图"
          options={[
            { value: "grid", label: <><LayoutGrid size={14} /> 卡片</> },
            { value: "list", label: <><List size={14} /> 列表</> },
            { value: "filmstrip", label: <><Film size={14} /> 胶片</> },
          ]}
        />
      </div>

      {!project.scenes.length ? (
        <EmptyState
          icon={<Clapperboard size={25} />}
          title="还没有分镜"
          description="从当前脚本生成一组结构化场景，然后开始视觉编排。"
          action={
            <Button variant="primary" onClick={generateStoryboard}>
              生成第一组分镜
            </Button>
          }
        />
      ) : (
        <div className="storyboard-layout">
          <section className={`storyboard-canvas storyboard-canvas--${view}`}>
            {project.scenes.map((scene, index) => {
              const asset = project.assets.find((item) => item.id === scene.assetId);
              return (
                <article
                  className={`story-card ${effectiveSelectedId === scene.id ? "is-selected" : ""} ${
                    dragIndex === index ? "is-dragging" : ""
                  }`}
                  key={scene.id}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== index) {
                      reorderScenes(project.id, dragIndex, index);
                      pushToast({ type: "success", title: "场景顺序已更新" });
                    }
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  onClick={() => setSelectedId(scene.id)}
                >
                  <div className="story-card__drag">
                    <GripVertical size={14} />
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div className="story-card__preview">
                    <ScenePreview
                      scene={scene}
                      asset={asset}
                      assets={project.assets}
                      ratio={project.settings.aspectRatio}
                      time={0.8}
                    />
                  </div>
                  <div className="story-card__body">
                    <div className="story-card__title">
                      <h3>{scene.title}</h3>
                      <Pill tone={asset ? "success" : "neutral"} dot={Boolean(asset)}>
                        {asset ? "已关联素材" : "矢量场景"}
                      </Pill>
                    </div>
                    <p>{truncate(scene.narration, 72)}</p>
                    <footer>
                      <span>{scene.shotType}</span>
                      <span>{scene.transition}</span>
                      <strong>{scene.duration.toFixed(1)}s</strong>
                    </footer>
                  </div>
                  <div className="story-card__actions">
                    <IconButton
                      label="复制场景"
                      onClick={(event) => {
                        event.stopPropagation();
                        duplicate(scene);
                      }}
                    >
                      <Copy size={14} />
                    </IconButton>
                    <IconButton
                      label="删除场景"
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(scene);
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </article>
              );
            })}
            <button type="button" className="story-add-card" onClick={add}>
              <span><Plus size={21} /></span>
              <strong>添加下一镜</strong>
              <small>创建新的画面、旁白与转场</small>
            </button>
          </section>

          {selected && (
            <aside className="story-inspector">
              <header>
                <div>
                  <span className="eyebrow">
                    SCENE {String(selectedIndex + 1).padStart(2, "0")}
                  </span>
                  <h2>场景检查器</h2>
                </div>
                <Pill tone="info">{selected.duration.toFixed(1)}s</Pill>
              </header>
              <div className="story-inspector__preview">
                <ScenePreview
                  scene={selected}
                  asset={project.assets.find((item) => item.id === selected.assetId)}
                  assets={project.assets}
                  ratio={project.settings.aspectRatio}
                  time={0.6}
                />
              </div>
              <label className="inspector-field">
                <span>场景标题</span>
                <TextInput
                  value={selected.title}
                  onChange={(event) => patchScene({ title: event.target.value })}
                />
              </label>
              <label className="inspector-field">
                <span>画面描述</span>
                <TextArea
                  value={selected.description}
                  onChange={(event) =>
                    patchScene({ description: event.target.value })
                  }
                  rows={4}
                />
              </label>
              <label className="inspector-field">
                <span>视觉提示词</span>
                <TextArea
                  value={selected.visualPrompt}
                  onChange={(event) =>
                    patchScene({ visualPrompt: event.target.value })
                  }
                  rows={4}
                />
              </label>
              <div className="inspector-grid">
                <label>
                  <span>镜头</span>
                  <select
                    value={selected.shotType}
                    onChange={(event) => patchScene({ shotType: event.target.value })}
                  >
                    <option>Hook</option>
                    <option>Explainer</option>
                    <option>Diagram</option>
                    <option>Evidence</option>
                    <option>Takeaway</option>
                  </select>
                </label>
                <label>
                  <span>时长</span>
                  <input
                    type="number"
                    min={2}
                    max={60}
                    step={0.5}
                    value={selected.duration}
                    onChange={(event) =>
                      patchScene({ duration: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <div className="story-inspector__actions">
                <Button
                  variant="secondary"
                  icon={<Image size={15} />}
                  onClick={() =>
                    navigate(
                      `/projects/${project.id}/assets?sceneId=${selected.id}`,
                    )
                  }
                >
                  生成画面
                </Button>
                <Button
                  variant="primary"
                  icon={<WandSparkles size={15} />}
                  onClick={() =>
                    navigate(
                      `/projects/${project.id}/animation?sceneId=${selected.id}`,
                    )
                  }
                >
                  打开动画
                </Button>
              </div>
              <button
                type="button"
                className="storyboard-next"
                onClick={() => navigate(`/projects/${project.id}/assets`)}
              >
                下一步：准备视觉素材 <ArrowRight size={15} />
              </button>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
