import {
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers3,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Save,
  Shapes,
  SkipBack,
  Sparkles,
  Square,
  Trash2,
  Type,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import { Button, IconButton, Pill } from "../components/ui";
import { createLayer } from "../data/demo";
import { useStudioStore } from "../store/studio";
import type { SceneLayer } from "../types";
import {
  downloadText,
  formatTime,
  makeId,
  sceneSvg,
} from "../utils";
import "./AnimationEditor.css";

export default function AnimationEditor() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const initialScene =
    project?.scenes.find((scene) => scene.id === params.get("sceneId")) ??
    project?.scenes[0];
  const [sceneId, setSceneId] = useState(initialScene?.id ?? "");
  const [layerId, setLayerId] = useState(initialScene?.layers[0]?.id ?? "");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(72);
  const frame = useRef<number | null>(null);

  const scene = project?.scenes.find((item) => item.id === sceneId);
  const layer = scene?.layers.find((item) => item.id === layerId);
  const asset = project?.assets.find((item) => item.id === scene?.assetId);

  useEffect(() => {
    setTime(0);
    setLayerId(scene?.layers[0]?.id ?? "");
  }, [sceneId, scene]);

  useEffect(() => {
    if (!playing || !scene) return;
    let previous = performance.now();
    const tick = (current: number) => {
      const delta = (current - previous) / 1000;
      previous = current;
      setTime((value) => {
        const next = value + delta;
        return next >= scene.duration ? 0 : next;
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [playing, scene]);

  const displayScale = useMemo(() => {
    if (!scene) return "1.00";
    const entrance = Math.min(1, time / Math.min(1.2, scene.duration * 0.3));
    return (0.96 + entrance * 0.04).toFixed(2);
  }, [scene, time]);

  if (!project || !scene) return null;

  const updateLayer = (patch: Partial<SceneLayer>) => {
    if (!layer) return;
    updateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === sceneId
          ? {
              ...item,
              layers: item.layers.map((entry) =>
                entry.id === layer.id ? { ...entry, ...patch } : entry,
              ),
            }
          : item,
      ),
      stage: "animation",
    }));
  };

  const addLayer = (type: "text" | "shape") => {
    const next = createLayer(type, scene.layers.length);
    next.end = scene.duration;
    if (type === "shape") {
      next.name = "强调光圈";
      next.color = scene.accent;
      next.x = 68;
      next.y = 20;
      next.width = 20;
      next.height = 35;
    }
    updateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === sceneId
          ? { ...item, layers: [...item.layers, next] }
          : item,
      ),
    }));
    setLayerId(next.id);
    pushToast({ type: "success", title: `已添加${type === "text" ? "文字" : "图形"}图层` });
  };

  const duplicateLayer = () => {
    if (!layer) return;
    const copy: SceneLayer = {
      ...layer,
      id: makeId("layer"),
      name: `${layer.name} 副本`,
      x: Math.min(88, layer.x + 3),
      y: Math.min(84, layer.y + 3),
    };
    updateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === sceneId
          ? { ...item, layers: [...item.layers, copy] }
          : item,
      ),
    }));
    setLayerId(copy.id);
  };

  const deleteLayer = () => {
    if (!layer || scene.layers.length <= 1) {
      pushToast({ type: "error", title: "场景至少保留一个图层" });
      return;
    }
    updateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === sceneId
          ? { ...item, layers: item.layers.filter((entry) => entry.id !== layer.id) }
          : item,
      ),
    }));
    setLayerId(scene.layers.find((entry) => entry.id !== layer.id)?.id ?? "");
  };

  const saveSnapshot = () => {
    downloadText(
      sceneSvg(scene),
      `${scene.title.replace(/[\\/:*?"<>|]/g, "-")}.svg`,
      "image/svg+xml",
    );
    pushToast({ type: "success", title: "当前场景快照已下载" });
  };

  return (
    <div className="animation-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="ANIMATION WORKBENCH"
        title="让每个信息在正确的时刻出现"
        description="在这里调整结构化图层和属性；Remotion Studio 使用同一份场景数据生成实时预览与完整视频。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Save size={15} />}
              onClick={saveSnapshot}
            >
              导出快照
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/remotion`)}
            >
              打开 Remotion Studio
            </Button>
          </>
        }
      />

      <div className="animation-layout">
        <aside className="animation-left">
          <section className="layer-scene-list">
            <header>
              <span className="eyebrow">SCENES</span>
              <span>{project.scenes.length}</span>
            </header>
            {project.scenes.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={item.id === sceneId ? "is-active" : ""}
                onClick={() => setSceneId(item.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.duration.toFixed(1)}s</small>
                </div>
              </button>
            ))}
          </section>

          <section className="layers-panel">
            <header>
              <div>
                <span className="eyebrow">LAYERS</span>
                <h3>图层</h3>
              </div>
              <div>
                <IconButton label="添加文字图层" onClick={() => addLayer("text")}>
                  <Type size={15} />
                </IconButton>
                <IconButton label="添加图形图层" onClick={() => addLayer("shape")}>
                  <Shapes size={15} />
                </IconButton>
              </div>
            </header>
            <div className="layer-list">
              {[...scene.layers].reverse().map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === layerId ? "is-active" : ""}
                  onClick={() => setLayerId(item.id)}
                >
                  <span className="layer-list__type">
                    {item.type === "text" ? <Type size={14} /> : <Square size={14} />}
                  </span>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.type === "text"
                        ? item.content || "空文字"
                        : item.shape}
                    </small>
                  </div>
                  <span className="layer-list__eye">
                    {item.opacity > 0 ? <Eye size={13} /> : <EyeOff size={13} />}
                  </span>
                </button>
              ))}
            </div>
            <footer>
              <span><Layers3 size={14} /> {scene.layers.length} 个图层</span>
              <button type="button" onClick={() => addLayer("text")}>
                <Plus size={14} /> 添加
              </button>
            </footer>
          </section>
        </aside>

        <section className="studio-workspace">
          <header className="studio-toolbar">
            <div className="studio-toolbar__left">
              <span className="studio-toolbar__status">
                <i />
                BROWSER PREVIEW
              </span>
              <Pill tone="neutral">{project.settings.aspectRatio}</Pill>
            </div>
            <div className="studio-toolbar__center">
              <IconButton
                label="回到开头"
                onClick={() => {
                  setTime(0);
                  setPlaying(false);
                }}
              >
                <SkipBack size={16} />
              </IconButton>
              <button
                type="button"
                className="play-main-button"
                aria-label={playing ? "暂停" : "播放"}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <span className="timecode">
                {formatTime(time)}.<small>{String(Math.floor((time % 1) * 30)).padStart(2, "0")}</small>
                <i>/</i>
                {formatTime(scene.duration)}
              </span>
            </div>
            <div className="studio-toolbar__right">
              <IconButton
                label="切换安全框"
                className={guides ? "is-active" : ""}
                onClick={() => setGuides(!guides)}
              >
                <MonitorPlay size={16} />
              </IconButton>
              <span className="zoom-control">
                <button type="button" onClick={() => setZoom(Math.max(40, zoom - 10))}>−</button>
                <span>{zoom}%</span>
                <button type="button" onClick={() => setZoom(Math.min(100, zoom + 10))}>+</button>
              </span>
            </div>
          </header>

          <div className="studio-canvas-area">
            <div
              className="studio-canvas-stage"
              style={{
                width: `${zoom}%`,
                transform: `scale(${displayScale})`,
              }}
            >
              <ScenePreview
                scene={scene}
                asset={asset}
                ratio={project.settings.aspectRatio}
                time={time}
                showGuides={guides}
              />
            </div>
            <span className="canvas-corner canvas-corner--tl" />
            <span className="canvas-corner canvas-corner--tr" />
            <span className="canvas-corner canvas-corner--bl" />
            <span className="canvas-corner canvas-corner--br" />
          </div>

          <div className="scene-transport">
            <div className="scene-transport__info">
              <span className="eyebrow">SCENE TIMELINE</span>
              <strong>{scene.title}</strong>
            </div>
            <div className="mini-timeline">
              <input
                type="range"
                min={0}
                max={scene.duration}
                step={0.01}
                value={time}
                onChange={(event) => setTime(Number(event.target.value))}
                aria-label="场景播放头"
              />
              {scene.layers.map((item) => (
                <span
                  key={item.id}
                  className={item.id === layerId ? "is-active" : ""}
                  style={{
                    left: `${(item.start / scene.duration) * 100}%`,
                    width: `${Math.max(4, ((item.end - item.start) / scene.duration) * 100)}%`,
                  }}
                />
              ))}
            </div>
            <span className="mini-timeline__time">
              {formatTime(time)} / {formatTime(scene.duration)}
            </span>
          </div>
        </section>

        <aside className="animation-properties">
          <header>
            <div>
              <span className="eyebrow">INSPECTOR</span>
              <h2>{layer?.name ?? "场景属性"}</h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<WandSparkles size={14} />}
              onClick={() =>
                useStudioStore.getState().setAssistantOpen(true)
              }
            >
              助手
            </Button>
          </header>

          {layer ? (
            <>
              <div className="property-section">
                <span className="eyebrow">CONTENT</span>
                {layer.type === "text" ? (
                  <>
                    <label className="inspector-field">
                      <span>文字内容</span>
                      <textarea
                        rows={3}
                        value={layer.content}
                        onChange={(event) =>
                          updateLayer({ content: event.target.value })
                        }
                      />
                    </label>
                    <label className="inspector-field">
                      <span>字号</span>
                      <div className="property-range">
                        <input
                          type="range"
                          min={14}
                          max={96}
                          value={layer.fontSize}
                          onChange={(event) =>
                            updateLayer({ fontSize: Number(event.target.value) })
                          }
                        />
                        <em>{layer.fontSize}px</em>
                      </div>
                    </label>
                    <label className="inspector-field color-row">
                      <span>文字颜色</span>
                      <input
                        type="color"
                        value={layer.color}
                        onChange={(event) =>
                          updateLayer({ color: event.target.value })
                        }
                      />
                      <code>{layer.color}</code>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="inspector-field">
                      <span>形状</span>
                      <select
                        value={layer.shape}
                        onChange={(event) =>
                          updateLayer({
                            shape: event.target.value as SceneLayer["shape"],
                          })
                        }
                      >
                        <option value="circle">圆形</option>
                        <option value="rectangle">矩形</option>
                        <option value="line">线条</option>
                      </select>
                    </label>
                    <label className="inspector-field color-row">
                      <span>填充颜色</span>
                      <input
                        type="color"
                        value={layer.color}
                        onChange={(event) =>
                          updateLayer({ color: event.target.value })
                        }
                      />
                      <code>{layer.color}</code>
                    </label>
                  </>
                )}
              </div>

              <div className="property-section">
                <span className="eyebrow">TRANSFORM</span>
                <div className="property-grid">
                  <label><span>X</span><input type="number" value={layer.x} onChange={(event) => updateLayer({ x: Number(event.target.value) })} /></label>
                  <label><span>Y</span><input type="number" value={layer.y} onChange={(event) => updateLayer({ y: Number(event.target.value) })} /></label>
                  <label><span>宽度</span><input type="number" value={layer.width} onChange={(event) => updateLayer({ width: Number(event.target.value) })} /></label>
                  <label><span>高度</span><input type="number" value={layer.height} onChange={(event) => updateLayer({ height: Number(event.target.value) })} /></label>
                </div>
                <label className="inspector-field">
                  <span>透明度</span>
                  <div className="property-range">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={layer.opacity}
                      onChange={(event) =>
                        updateLayer({ opacity: Number(event.target.value) })
                      }
                    />
                    <em>{Math.round(layer.opacity * 100)}%</em>
                  </div>
                </label>
              </div>

              <div className="property-section">
                <span className="eyebrow">TIMING</span>
                <div className="property-grid">
                  <label><span>入点</span><input type="number" min={0} max={scene.duration} step={0.1} value={layer.start} onChange={(event) => updateLayer({ start: Number(event.target.value) })} /></label>
                  <label><span>出点</span><input type="number" min={0} max={scene.duration} step={0.1} value={layer.end} onChange={(event) => updateLayer({ end: Number(event.target.value) })} /></label>
                </div>
              </div>
            </>
          ) : (
            <div className="property-empty">
              <Sparkles size={20} />
              <p>添加一个图层开始设计画面。</p>
            </div>
          )}

          <footer className="property-actions">
            <Button
              variant="secondary"
              icon={<Copy size={14} />}
              onClick={duplicateLayer}
              disabled={!layer}
            >
              复制
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={deleteLayer}
              disabled={!layer}
            >
              删除
            </Button>
          </footer>
          <div className="remotion-note">
            <ImageIcon size={16} />
            <p>
              <strong>共享数据</strong>
              Scene DSL 会自动把当前图层编译到 Remotion Studio，无需生成新的 React 项目。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
