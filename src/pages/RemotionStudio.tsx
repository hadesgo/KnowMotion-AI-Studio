import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Code2,
  Download,
  Film,
  Layers3,
  Play,
  ScanLine,
  TerminalSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { RemotionPlayer } from "../components/RemotionPlayer";
import { Button, Pill, Segmented } from "../components/ui";
import {
  buildProjectComposition,
  buildSceneComposition,
  sceneDslSchema,
  validateComposition,
} from "../remotion/schema";
import { useStudioStore } from "../store/studio";
import { downloadText } from "../utils";

type PreviewMode = "composition" | "scene";

export default function RemotionStudio() {
  const project = useCurrentProject();
  const pushToast = useStudioStore((state) => state.pushToast);
  const [mode, setMode] = useState<PreviewMode>("composition");
  const [selectedSceneId, setSelectedSceneId] = useState(
    project?.scenes[0]?.id ?? "",
  );
  const [validatedAt, setValidatedAt] = useState("");

  const composition = useMemo(
    () => (project ? buildProjectComposition(project) : null),
    [project],
  );
  const selectedScene =
    composition?.scenes.find((scene) => scene.id === selectedSceneId) ??
    composition?.scenes[0];
  const singleComposition =
    composition && selectedScene
      ? buildSceneComposition(
          selectedScene,
          composition.width,
          composition.height,
          composition.fps,
          composition.assets,
        )
      : null;
  const validation = composition ? validateComposition(composition) : null;
  const previewComposition =
    mode === "scene" && singleComposition ? singleComposition : composition;

  if (!project || !composition || !previewComposition) return null;

  const layerStats = composition.scenes.reduce(
    (stats, scene) => {
      for (const layer of scene.layers) stats[layer.type] += 1;
      return stats;
    },
    { text: 0, svg: 0, image: 0, chart: 0 },
  );

  const validateNow = () => {
    const result = validateComposition(composition);
    setValidatedAt(new Date().toISOString());
    pushToast({
      type: result.valid ? "success" : "error",
      title: result.valid ? "Composition Schema 校验通过" : "Composition 校验失败",
      message: result.valid
        ? `${composition.scenes.length} 个场景、${composition.durationInFrames} 帧均可用于 Player 和 Renderer。`
        : result.errors[0],
    });
  };

  const downloadJson = () => {
    downloadText(
      JSON.stringify(composition, null, 2),
      `${project.title.replace(/[\\/:*?"<>|]/g, "-")}.composition.json`,
      "application/json",
    );
  };

  const copyRenderCommand = async () => {
    const content = JSON.stringify(composition);
    const command = `npm run remotion:render -- --composition <composition.json> --out renders/${project.title}.mp4`;
    try {
      await navigator.clipboard.writeText(command);
      pushToast({
        type: "success",
        title: "渲染命令已复制",
        message: content.length > 0 ? "先导出 Composition JSON，再替换命令中的文件路径。" : undefined,
      });
    } catch {
      pushToast({
        type: "error",
        title: "无法访问剪贴板",
        message: "请从项目目录运行 npm run remotion:render。",
      });
    }
  };

  return (
    <div className="remotion-studio-page">
      <PageHeading
        eyebrow="REMOTION ENGINE"
        title="结构化场景，进入真实视频时间轴"
        description="Scene DSL 经过 Zod 校验后由可复用 Remotion 组件解释。同一份 Composition 同时供 Player 和 Renderer 使用。"
        actions={
          <>
            <Pill tone={validation?.valid ? "success" : "danger"} dot>
              {validation?.valid ? "SCHEMA VALID" : `${validation?.errors.length ?? 0} ERRORS`}
            </Pill>
            <Button
              variant="soft"
              icon={<ScanLine size={15} />}
              onClick={validateNow}
            >
              校验 Schema
            </Button>
            <Button
              variant="primary"
              icon={<Download size={15} />}
              onClick={downloadJson}
            >
              导出 DSL
            </Button>
          </>
        }
      />

      <div className="remotion-summary">
        <div>
          <span className="eyebrow">COMPOSITION</span>
          <strong>{composition.scenes.length}</strong>
          <small>场景</small>
        </div>
        <div>
          <span className="eyebrow">TIMELINE</span>
          <strong>{composition.durationInFrames}</strong>
          <small>帧 · {(composition.durationInFrames / composition.fps).toFixed(1)} 秒</small>
        </div>
        <div>
          <span className="eyebrow">CANVAS</span>
          <strong>{composition.width}×{composition.height}</strong>
          <small>{composition.fps} FPS</small>
        </div>
        <div>
          <span className="eyebrow">LAYERS</span>
          <strong>{Object.values(layerStats).reduce((sum, value) => sum + value, 0)}</strong>
          <small>{layerStats.text} 文本 · {layerStats.svg} SVG · {layerStats.image} 图片 · {layerStats.chart} 图表</small>
        </div>
      </div>

      <div className="remotion-layout">
        <aside className="remotion-scene-list">
          <header>
            <div>
              <span className="eyebrow">SCENE DSL</span>
              <h2>场景序列</h2>
            </div>
            <Pill tone="accent">{composition.scenes.length} 场</Pill>
          </header>
          {composition.scenes.map((scene, index) => {
            const parsed = sceneDslSchema.safeParse(scene);
            return (
              <button
                type="button"
                key={scene.id}
                className={selectedScene?.id === scene.id ? "is-active" : ""}
                onClick={() => {
                  setSelectedSceneId(scene.id);
                  setMode("scene");
                }}
              >
                <span className="remotion-scene-list__index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <span className="remotion-scene-style">{scene.styleVariant}</span>
                  <strong>{scene.title}</strong>
                  <small>{scene.layers.length} 图层 · {(scene.durationMs / 1000).toFixed(1)}s</small>
                </div>
                {parsed.success ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <CircleAlert size={14} />
                )}
              </button>
            );
          })}
        </aside>

        <section className="remotion-stage-panel">
          <header className="remotion-stage-toolbar">
            <Segmented
              value={mode}
              onChange={setMode}
              label="Remotion 预览范围"
              options={[
                { value: "composition", label: <><Film size={14} /> 完整视频</> },
                { value: "scene", label: <><Play size={14} /> 当前场景</> },
              ]}
            />
            <div>
              <span className="live-indicator"><i /> REMOTION PLAYER</span>
              <span>
                {mode === "scene"
                  ? selectedScene?.title
                  : `${composition.scenes.length} 场景连续预览`}
              </span>
            </div>
          </header>
          <div className={`remotion-player-holder remotion-player-holder--${mode}`}>
            <RemotionPlayer
              composition={previewComposition}
              singleScene={mode === "scene"}
            />
          </div>
          <footer className="remotion-stage-footer">
            <span>
              <Code2 size={14} />
              {mode === "scene" ? `单场景 · ${selectedScene?.id}` : composition.id}
            </span>
            <span>
              <Layers3 size={14} />
              组件库：Text / SVG / Image / Chart / Camera / Transition
            </span>
          </footer>
        </section>

        <aside className="remotion-inspector">
          <header>
            <span className="eyebrow">SCENE INSPECTOR</span>
            <h2>{selectedScene?.title ?? "选择场景"}</h2>
          </header>
          {selectedScene && (
            <>
              <div className="remotion-inspector__meta">
                <div><span>风格</span><strong>{selectedScene.styleVariant}</strong></div>
                <div><span>时长</span><strong>{(selectedScene.durationMs / 1000).toFixed(1)}s</strong></div>
                <div><span>转场</span><strong>{selectedScene.transition.type}</strong></div>
                <div><span>镜头</span><strong>{selectedScene.camera.from.scale} → {selectedScene.camera.to.scale}</strong></div>
              </div>
              <div className="remotion-layer-stack">
                <span className="eyebrow">LAYER STACK</span>
                {selectedScene.layers.map((layer) => (
                  <div key={layer.id}>
                    <span className={`layer-dot layer-dot--${layer.type}`} />
                    <div>
                      <strong>{layer.id}</strong>
                      <small>
                        {layer.type} · {(layer.timing.fromMs / 1000).toFixed(1)}–{(layer.timing.toMs / 1000).toFixed(1)}s
                      </small>
                    </div>
                    <Pill tone="neutral">{layer.animation.type}</Pill>
                  </div>
                ))}
              </div>
              <div className="schema-result">
                <div>
                  {validation?.valid ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                  <strong>Composition Schema</strong>
                  <span>{validation?.valid ? "PASS" : "FAIL"}</span>
                </div>
                {validation?.errors.slice(0, 5).map((errorMessage) => (
                  <p key={errorMessage}>{errorMessage}</p>
                ))}
                {validation?.warnings.slice(0, 3).map((warning) => (
                  <p key={warning} className="is-warning">{warning}</p>
                ))}
                {validatedAt && (
                  <small>
                    最后校验{" "}
                    {new Date(validatedAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      <div className="remotion-lower-grid">
        <section className="render-handoff">
          <span className="remotion-handoff-icon"><TerminalSquare size={20} /></span>
          <div>
            <span className="eyebrow">FULL VIDEO RENDER</span>
            <h2>Remotion Renderer → H.264 MP4</h2>
            <p>
              导出 Composition JSON 后运行项目脚本。Renderer 使用同一个
              KnowledgeVideo 入口，并逐帧渲染完整多场景时间轴。
            </p>
          </div>
          <div className="render-handoff__actions">
            <Button
              variant="secondary"
              icon={<Clipboard size={14} />}
              onClick={() => void copyRenderCommand()}
            >
              复制命令
            </Button>
            <Button
              variant="soft"
              icon={<ArrowRight size={14} />}
              onClick={downloadJson}
            >
              先导出 JSON
            </Button>
          </div>
          <code>npm run remotion:render -- --composition composition.json</code>
        </section>

        <section className="remotion-feature-list">
          <span className="eyebrow">ENGINE COVERAGE</span>
          {[
            ["文本", "淡入、上移、缩放、打字机"],
            ["SVG", "轨道、波形、网格、粒子、进度环"],
            ["图片", "本地/生成素材、淡入缩放、暗角"],
            ["图表", "柱状、折线、环形图数据动画"],
            ["镜头", "缩放、平移与缓动"],
            ["转场", "淡入、滑动、擦除、圆形遮罩"],
          ].map(([label, description]) => (
            <div key={label}>
              <span><CheckCircle2 size={14} /></span>
              <strong>{label}</strong>
              <small>{description}</small>
            </div>
          ))}
        </section>

        <section className="remotion-example-card">
          <span className="eyebrow">INCLUDED EXAMPLE</span>
          <h2>为什么夜空是黑色的？</h2>
          <p>
            示例项目包含电影感开场、信息图解释、数据揭示、编辑部图片和极简收束
            五种不同风格场景。
          </p>
          <div>
            {composition.scenes.slice(0, 5).map((scene, index) => (
              <span key={scene.id}>
                <i style={{ background: scene.background.colors[0] }} />
                {String(index + 1).padStart(2, "0")} {scene.styleVariant}
              </span>
            ))}
          </div>
          <Link to={`/projects/${project.id}/animation`}>
            返回图层编辑 <ArrowRight size={14} />
          </Link>
        </section>
      </div>
    </div>
  );
}
