import {
  ArrowRight,
  Check,
  Download,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Plus,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import {
  Button,
  EmptyState,
  Field,
  Pill,
  Progress,
  Segmented,
  TextArea,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { Asset } from "../types";
import { createVisualDraftSvg, formatBytes, makeId, nowIso } from "../utils";
import "./ImageAssets.css";

const styles = ["编辑部极简", "电影感纪录片", "复古科学杂志", "未来主义数据"];

export default function ImageAssets() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const addAsset = useStudioStore((state) => state.addAsset);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const initialScene =
    project?.scenes.find((scene) => scene.id === params.get("sceneId")) ??
    project?.scenes[0];
  const [sceneId, setSceneId] = useState(initialScene?.id ?? "");
  const [prompt, setPrompt] = useState(initialScene?.visualPrompt ?? "");
  const [style, setStyle] = useState(project?.settings.style ?? styles[0]);
  const [ratio, setRatio] = useState<"scene" | "square" | "portrait">("scene");
  const [count, setCount] = useState(2);
  const [progress, setProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const scene = project?.scenes.find((item) => item.id === sceneId);
  const sceneAssets =
    project?.assets.filter((asset) => asset.sceneId === sceneId) ?? [];
  const selectedAsset =
    project?.assets.find((asset) => asset.id === selectedAssetId) ??
    sceneAssets[0];

  useEffect(() => {
    if (scene) setPrompt(scene.visualPrompt);
  }, [scene]);

  if (!project || !scene) return null;

  const generate = () => {
    if (!prompt.trim()) {
      pushToast({ type: "error", title: "先写下画面描述" });
      return;
    }
    setGenerating(true);
    setProgress(8);
    const timer = window.setInterval(() => {
      setProgress((current) =>
        current >= 92 ? current : Math.min(92, current + Math.random() * 15),
      );
    }, 180);
    window.setTimeout(() => {
      const firstId = makeId("asset");
      const assets: Asset[] = Array.from({ length: count }, (_, index) => {
        const visual = createVisualDraftSvg(prompt, style, index + 1);
        return {
          id: index === 0 ? firstId : makeId("asset"),
          sceneId,
          name: `${scene.title} · 视觉草案 ${String(index + 1).padStart(2, "0")}`,
          kind: "image",
          src: visual.src,
          prompt,
          createdAt: nowIso(),
          local: true,
        };
      });
      assets.forEach((asset) => addAsset(project.id, asset));
      setSelectedAssetId(firstId);
      setProgress(100);
      setGenerating(false);
      window.clearInterval(timer);
      pushToast({
        type: "success",
        title: `${assets.length} 张视觉草案已生成`,
        message: "由本地 SVG 生成器创建，可直接采用到场景。",
      });
      window.setTimeout(() => setProgress(0), 700);
    }, 1300);
  };

  const applyAsset = (asset: Asset) => {
    updateProject(project.id, (current) => ({
      ...current,
      assets: current.assets,
      scenes: current.scenes.map((item) =>
        item.id === sceneId ? { ...item, assetId: asset.id } : item,
      ),
      stage: "assets",
    }));
    pushToast({ type: "success", title: "素材已采用到当前场景" });
  };

  const download = (asset: Asset) => {
    const link = document.createElement("a");
    link.href = asset.src;
    link.download = `${asset.name.replace(/[\\/:*?"<>|]/g, "-")}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      pushToast({
        type: "error",
        title: "图片过大",
        message: `当前原型限制 2 MB，你选择的是 ${formatBytes(file.size)}。`,
      });
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const asset: Asset = {
        id: makeId("asset"),
        sceneId,
        name: file.name,
        kind: "image",
        src: String(reader.result),
        prompt: "用户上传素材",
        createdAt: nowIso(),
        local: true,
      };
      addAsset(project.id, asset);
      setSelectedAssetId(asset.id);
      pushToast({ type: "success", title: "图片已导入素材库" });
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  return (
    <div className="assets-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="VISUAL ASSETS"
        title="为抽象知识找到可见的形状"
        description="优先使用矢量、图表和已有素材；图片生成是可选能力，不会替代所有画面。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Upload size={15} />}
              onClick={() => fileInput.current?.click()}
            >
              导入图片
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/animation`)}
            >
              进入动画
            </Button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        hidden
        onChange={upload}
      />

      <div className="assets-layout">
        <section className="asset-controls">
          <header>
            <span className="eyebrow">GENERATION BRIEF</span>
            <h2>画面需求</h2>
          </header>
          <label className="inspector-field">
            <span>当前场景</span>
            <select value={sceneId} onChange={(event) => setSceneId(event.target.value)}>
              {project.scenes.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {String(index + 1).padStart(2, "0")} · {item.title}
                </option>
              ))}
            </select>
          </label>
          <div className="asset-scene-summary">
            <ScenePreview
              scene={scene}
              asset={project.assets.find((asset) => asset.id === scene.assetId)}
              ratio={project.settings.aspectRatio}
              time={0.7}
            />
            <p>{scene.description}</p>
          </div>
          <Field label="视觉提示词">
            <TextArea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
            />
          </Field>
          <Field label="视觉风格">
            <div className="style-token-grid">
              {styles.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={style === item ? "is-selected" : ""}
                  onClick={() => setStyle(item)}
                >
                  {style === item && <Check size={12} />}
                  {item}
                </button>
              ))}
            </div>
          </Field>
          <div className="asset-setting-row">
            <span>画幅</span>
            <Segmented
              value={ratio}
              onChange={setRatio}
              label="素材画幅"
              options={[
                { value: "scene", label: "场景" },
                { value: "square", label: "1:1" },
                { value: "portrait", label: "9:16" },
              ]}
            />
          </div>
          <div className="asset-setting-row">
            <span>生成数量</span>
            <Segmented
              value={String(count)}
              onChange={(value) => setCount(Number(value))}
              label="生成数量"
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "4", label: "4" },
              ]}
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            className="generate-button"
            icon={
              generating ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Sparkles size={17} />
              )
            }
            onClick={generate}
            disabled={generating}
          >
            {generating ? "正在构建视觉…" : "生成本地视觉草案"}
          </Button>
          {progress > 0 && <Progress value={progress} />}
          <p className="generation-note">
            <ImageIcon size={14} />
            浏览器原型生成可编辑的 SVG 构图，不调用在线图片模型。
          </p>
        </section>

        <section className="asset-gallery">
          <header className="asset-gallery__header">
            <div>
              <span className="eyebrow">SCENE LIBRARY</span>
              <h2>{scene.title}</h2>
            </div>
            <div>
              <Pill tone="info">{sceneAssets.length} 个素材</Pill>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => fileInput.current?.click()}
              >
                导入
              </Button>
            </div>
          </header>

          {sceneAssets.length ? (
            <div className="asset-grid">
              {sceneAssets.map((asset) => (
                <article
                  key={asset.id}
                  className={`asset-card ${
                    selectedAsset?.id === asset.id ? "is-selected" : ""
                  } ${scene.assetId === asset.id ? "is-applied" : ""}`}
                  onClick={() => setSelectedAssetId(asset.id)}
                >
                  <div className="asset-card__image">
                    <img src={asset.src} alt={asset.name} />
                    {scene.assetId === asset.id && (
                      <span className="asset-card__applied">
                        <Check size={12} /> 场景已采用
                      </span>
                    )}
                  </div>
                  <div className="asset-card__meta">
                    <div>
                      <strong>{asset.name}</strong>
                      <small>LOCAL VECTOR · {asset.prompt.slice(0, 42)}</small>
                    </div>
                    <button
                      type="button"
                      aria-label="下载素材"
                      onClick={(event) => {
                        event.stopPropagation();
                        download(asset);
                      }}
                    >
                      <Download size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Images size={24} />}
              title="这个场景还没有视觉素材"
              description="写下画面需求并生成本地视觉草案，或导入自己的图片。"
              action={
                <Button variant="primary" onClick={generate}>
                  生成第一张草案
                </Button>
              }
            />
          )}
        </section>

        <aside className="asset-inspector">
          <span className="eyebrow">SELECTED ASSET</span>
          {selectedAsset ? (
            <>
              <div className="asset-inspector__preview">
                <img src={selectedAsset.src} alt={selectedAsset.name} />
              </div>
              <h3>{selectedAsset.name}</h3>
              <p>{selectedAsset.prompt}</p>
              <div className="asset-meta-list">
                <div><span>类型</span><strong>本地 SVG</strong></div>
                <div><span>场景</span><strong>{scene.title}</strong></div>
                <div><span>状态</span><strong>{scene.assetId === selectedAsset.id ? "已采用" : "候选"}</strong></div>
              </div>
              <Button
                variant="primary"
                className="full-button"
                icon={<WandSparkles size={16} />}
                onClick={() => applyAsset(selectedAsset)}
              >
                {scene.assetId === selectedAsset.id ? "重新应用到场景" : "采用到场景"}
              </Button>
              <Button
                variant="secondary"
                className="full-button"
                icon={<Download size={15} />}
                onClick={() => download(selectedAsset)}
              >
                下载素材
              </Button>
            </>
          ) : (
            <div className="asset-inspector__empty">
              <ImageIcon size={21} />
              <p>选择一个素材查看详情和采用状态。</p>
            </div>
          )}
          <div className="asset-consistency">
            <span><Sparkles size={15} /></span>
            <p>
              角色与风格一致性将在桌面 Provider
              接入后建立，当前每个场景保留独立提示词。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
