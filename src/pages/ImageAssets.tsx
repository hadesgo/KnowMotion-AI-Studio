import {
  Anchor,
  ArrowRight,
  BookmarkPlus,
  Check,
  Download,
  Image as ImageIcon,
  Images,
  Info,
  ListChecks,
  LoaderCircle,
  Paintbrush,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import { BatchImageDialog } from "../components/BatchImageDialog";
import { InpaintStudio } from "../components/InpaintStudio";
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Pill,
  Progress,
  Segmented,
  Select,
  TextArea,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import { useImageJobs } from "../hooks/useImageJobs";
import type { Asset, ReferenceRole } from "../types";
import { createVisualDraftSvg, formatBytes, makeId, nowIso } from "../utils";
import { isTauriDesktop } from "../services/desktop";
import {
  generateProjectImages,
  type ImageReferenceInput,
} from "../services/capabilities";
import {
  composeAnchoredPrompt,
  createConsistencyStamp,
  evaluateConsistency,
  hasSceneAnchors,
  resolveSceneAnchors,
  STYLE_LOCK_ENTITY_ID,
} from "../services/consistency";
import "./ImageAssets.css";

const styles = ["编辑部极简", "电影感纪录片", "复古科学杂志", "未来主义数据"];

export default function ImageAssets() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const addAsset = useStudioStore((state) => state.addAsset);
  const attachReference = useStudioStore((state) => state.attachReference);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const providers = useStudioStore((state) => state.providers);
  const taskRoutes = useStudioStore((state) => state.taskRoutes);
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
  const [useAnchors, setUseAnchors] = useState(true);
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectRole, setCollectRole] = useState<ReferenceRole>("character");
  const [collectEntity, setCollectEntity] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [inpaintTarget, setInpaintTarget] = useState<Asset | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const scene = project?.scenes.find((item) => item.id === sceneId);
  const anchors = useMemo(
    () => (project && scene ? resolveSceneAnchors(project, scene) : null),
    [project, scene],
  );
  const evaluation = useMemo(
    () => (project && scene ? evaluateConsistency(project, scene).evaluation : null),
    [project, scene],
  );

  const jobs = useImageJobs(project?.id, {
    hasAsset: (assetId) =>
      Boolean(project?.assets.some((asset) => asset.id === assetId)),
    onAssets: (assets) => {
      if (!project) return;
      assets.forEach((asset) => addAsset(project.id, asset));
    },
  });
  const sceneAssets =
    project?.assets.filter((asset) => asset.sceneId === sceneId) ?? [];
  const selectedAsset =
    project?.assets.find((asset) => asset.id === selectedAssetId) ??
    sceneAssets[0];
  const imageProvider = providers.find(
    (provider) =>
      provider.enabled &&
      provider.capabilities.includes("Image") &&
      provider.id ===
        (taskRoutes.Image ??
          providers.find((item) => item.capabilities.includes("Image"))?.id),
  );

  if (!project || !scene) return null;

  const selectScene = (nextSceneId: string) => {
    const nextScene = project.scenes.find((item) => item.id === nextSceneId);
    setSceneId(nextSceneId);
    setPrompt(nextScene?.visualPrompt ?? "");
    setSelectedAssetId("");
  };

  const generate = async () => {
    if (!prompt.trim()) {
      pushToast({ type: "error", title: "先写下画面描述" });
      return;
    }
    const anchorContext =
      useAnchors && anchors && hasSceneAnchors(anchors) ? anchors : null;
    const composedPrompt = anchorContext
      ? composeAnchoredPrompt(prompt, anchorContext)
      : prompt;
    const references: ImageReferenceInput[] = anchorContext
      ? anchorContext.referenceAssetIds
          .map((id) => project.assets.find((asset) => asset.id === id))
          .filter((asset): asset is Asset => Boolean(asset?.reference))
          .map((asset) => ({
            assetId: asset.id,
            role: asset.reference!.role,
            label: asset.reference!.label,
            weight: asset.reference!.weight,
            source: asset.src,
          }))
      : [];
    const withStamp = (
      asset: Asset,
      conditioning: "prompt" | "prompt+img2img",
    ): Asset =>
      anchorContext
        ? {
            ...asset,
            consistency: createConsistencyStamp(
              anchorContext,
              composedPrompt,
              conditioning,
            ),
          }
        : asset;

    setGenerating(true);
    setProgress(8);
    if (imageProvider && isTauriDesktop) {
      try {
        setProgress(18);
        const result = await generateProjectImages({
          projectId: project.id,
          sceneId,
          provider: imageProvider,
          prompt: composedPrompt,
          style,
          size:
            ratio === "square"
              ? "1024x1024"
              : ratio === "portrait"
                ? "1024x1536"
                : "1536x1024",
          count,
          negativePrompt: anchorContext?.negativePrompt ?? "",
          seed: anchorContext?.seed,
          references,
          anchorLabel: anchorContext?.label ?? "",
          consistencyFingerprint: anchorContext?.fingerprint ?? "",
        });
        result.assets.forEach((asset) =>
          addAsset(project.id, withStamp(asset, result.referenceMode)),
        );
        setSelectedAssetId(result.assets[0]?.id ?? "");
        setProgress(100);
        const conditioningNote = anchorContext
          ? result.referenceMode === "prompt+img2img"
            ? `锚点「${result.anchorLabel || anchorContext.label}」· ${result.referenceCount} 张参考图参与 img2img · 种子 ${result.seed}`
            : `锚点「${result.anchorLabel || anchorContext.label}」· 参考图仅以文字锚点传递 · 种子 ${result.seed}`
          : "未启用一致性锚点";
        pushToast({
          type: "success",
          title: `${result.assets.length} 张真实图片已生成并落盘`,
          message: `${imageProvider.name} · ${result.model} · ${Math.round(result.elapsedMs / 1000)} 秒 · ${conditioningNote}`,
        });
      } catch (error) {
        pushToast({
          type: "error",
          title: "图片生成失败",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setGenerating(false);
        window.setTimeout(() => setProgress(0), 700);
      }
      return;
    }
    const timer = window.setInterval(() => {
      setProgress((current) =>
        current >= 92 ? current : Math.min(92, current + Math.random() * 15),
      );
    }, 180);
    window.setTimeout(() => {
      const firstId = makeId("asset");
      const assets: Asset[] = Array.from({ length: count }, (_, index) => {
        const visual = createVisualDraftSvg(
          prompt,
          style,
          index + 1,
          anchorContext
            ? {
                seed: anchorContext.seed + index,
                palette: anchorContext.characters[0]?.palette,
                anchorLabel: anchorContext.label,
              }
            : undefined,
        );
        return withStamp(
          {
            id: index === 0 ? firstId : makeId("asset"),
            sceneId,
            name: `${scene.title} · 视觉草案 ${String(index + 1).padStart(2, "0")}`,
            kind: "image",
            src: visual.src,
            prompt: composedPrompt,
            createdAt: nowIso(),
            local: true,
          },
          "prompt",
        );
      });
      assets.forEach((asset) => addAsset(project.id, asset));
      setSelectedAssetId(firstId);
      setProgress(100);
      setGenerating(false);
      window.clearInterval(timer);
      pushToast({
        type: "success",
        title: `${assets.length} 张视觉草案已生成`,
        message: anchorContext
          ? `使用锚点「${anchorContext.label}」的固定种子 ${anchorContext.seed} 生成，可复现。`
          : "由本地 SVG 生成器创建，可直接采用到场景。",
      });
      window.setTimeout(() => setProgress(0), 700);
    }, 1300);
  };

  const applyAsset = (asset: Asset) => {    updateProject(project.id, (current) => ({
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

  const openCollect = () => {
    const role: ReferenceRole = project.characters.length
      ? "character"
      : project.locations.length
        ? "location"
        : "style";
    setCollectRole(role);
    setCollectEntity(
      role === "character"
        ? (scene.characterIds?.[0] ?? project.characters[0]?.id ?? "")
        : role === "location"
          ? (scene.locationId ?? project.locations[0]?.id ?? "")
          : STYLE_LOCK_ENTITY_ID,
    );
    setCollectOpen(true);
  };

  const collectAsReference = () => {
    if (!selectedAsset) return;
    const entityId =
      collectRole === "style" ? STYLE_LOCK_ENTITY_ID : collectEntity;
    if (collectRole !== "style" && !entityId) {
      pushToast({ type: "error", title: "先选择参考图归属的设定卡" });
      return;
    }
    const entityLabel =
      collectRole === "character"
        ? project.characters.find((item) => item.id === entityId)?.name
        : collectRole === "location"
          ? project.locations.find((item) => item.id === entityId)?.name
          : "全局风格";
    attachReference(project.id, {
      id: makeId("asset"),
      sceneId: "",
      name: `${selectedAsset.name} · 参考`,
      kind: "image",
      src: selectedAsset.src,
      prompt: selectedAsset.prompt,
      createdAt: nowIso(),
      local: selectedAsset.local,
      mimeType: selectedAsset.mimeType,
      providerId: selectedAsset.providerId,
      reference: {
        role: collectRole,
        entityId,
        label: `${entityLabel ?? "设定"} · 参考`,
        weight: 0.85,
        locked: true,
        notes: "由图片素材收进设定集",
      },
    });
    setCollectOpen(false);
    pushToast({
      type: "success",
      title: "已收进设定集",
      message: "锚点指纹已更新，相关镜头需要重新生成才能保持一致。",
    });
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
              icon={<ListChecks size={15} />}
              onClick={() => {
                if (!imageProvider) {
                  pushToast({
                    type: "error",
                    title: "批量生成需要 Image Provider",
                    message: "先在 AI 模型页配置一个声明 Image 能力的 Provider。",
                  });
                  return;
                }
                setBatchOpen(true);
              }}
            >
              批量生成{jobs.activeCount ? ` · ${jobs.activeCount}` : ""}
            </Button>
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

      {jobs.jobs.length > 0 && (
        <section className="asset-queue-strip" aria-label="图片生成队列">
          <span className="asset-queue-strip__icon">
            {jobs.activeCount ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ListChecks size={16} />
            )}
          </span>
          <div className="asset-queue-strip__body">
            <strong>生成队列</strong>
            <small>
              {jobs.jobs.filter((job) => job.status === "running").length} 进行中 ·{" "}
              {jobs.jobs.filter((job) => job.status === "pending").length} 等待 ·{" "}
              {jobs.jobs.filter((job) => job.status === "completed").length} 完成 ·{" "}
              {jobs.jobs.filter((job) => job.status === "failed").length} 失败
            </small>
          </div>
          <div className="asset-queue-strip__thumbs">
            {jobs.jobs
              .flatMap((job) => job.assets)
              .slice(0, 5)
              .map((asset) => (
                <img key={asset.id} src={asset.src} alt={asset.name} />
              ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setBatchOpen(true)}
          >
            打开队列
          </Button>
        </section>
      )}

      <div className="assets-layout">
        <section className="asset-controls">
          <header>
            <span className="eyebrow">GENERATION BRIEF</span>
            <h2>画面需求</h2>
          </header>
          <label className="inspector-field">
            <span>当前场景</span>
            <select
              value={sceneId}
              onChange={(event) => selectScene(event.target.value)}
            >
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
          <section
            className={`asset-anchor-panel ${useAnchors ? "is-on" : ""}`}
            aria-label="一致性锚点"
          >
            <header>
              <span>
                <Anchor size={14} /> 一致性锚点
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={useAnchors}
                onClick={() => setUseAnchors((value) => !value)}
              >
                {useAnchors ? "已启用" : "已关闭"}
              </button>
            </header>
            {anchors && (anchors.characters.length || anchors.location || anchors.styleActive) ? (
              <>
                <div className="asset-anchor-chips">
                  {anchors.characters.map((item) => (
                    <span key={item.id}>{item.name}</span>
                  ))}
                  {anchors.location && <span>{anchors.location.name}</span>}
                  {anchors.styleActive && <span>风格锁定</span>}
                </div>
                <div className="asset-anchor-meta">
                  <span>指纹</span>
                  <code>{anchors.fingerprint}</code>
                  <span>种子</span>
                  <code>{anchors.seed}</code>
                </div>
                <div className="asset-anchor-refs">
                  {anchors.referenceAssetIds.length ? (
                    anchors.referenceAssetIds.slice(0, 5).map((id) => {
                      const asset = project.assets.find((item) => item.id === id);
                      return asset ? (
                        <img key={id} src={asset.src} alt={asset.name} />
                      ) : null;
                    })
                  ) : (
                    <small>仅文字锚点</small>
                  )}
                  {anchors.referenceAssetIds.length > 5 && (
                    <small>+{anchors.referenceAssetIds.length - 5}</small>
                  )}
                </div>
                <Link
                  className="asset-anchor-link"
                  to={`/projects/${project.id}/canon`}
                >
                  调整角色与参考图 <ArrowRight size={12} />
                </Link>
              </>
            ) : (
              <p className="asset-anchor-empty">
                这个镜头还没有绑定角色、场景或风格。先去{" "}
                <Link to={`/projects/${project.id}/canon`}>设定集</Link>{" "}
                建一张设定卡，之后每次生成都会复用同一指纹。
              </p>
            )}
          </section>
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
            onClick={() => void generate()}
            disabled={generating}
          >
            {generating
              ? "正在生成视觉…"
              : imageProvider
                ? `使用 ${imageProvider.name} 生成`
                : "生成本地视觉草案"}
          </Button>
          {progress > 0 && <Progress value={progress} />}
          <p className="generation-note">
            <ImageIcon size={14} />
            {imageProvider
              ? `任务路由到 ${imageProvider.name}；结果通过 MIME、大小和文件头校验后写入 assets/images。`
              : "未配置 Image Provider 时，浏览器和桌面版都会生成可编辑的 SVG 构图。"}
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

          {evaluation && evaluation.status !== "consistent" && (
            <div className={`asset-consistency-banner is-${evaluation.tone}`}>
              <Info size={15} />
              <div>
                <strong>{evaluation.title}</strong>
                <span>{evaluation.detail}</span>
              </div>
              <Link to={`/projects/${project.id}/canon`}>去设定集</Link>
            </div>
          )}

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
                      <small>
                        {asset.local ? "LOCAL" : "AI"} · {asset.prompt.slice(0, 42)}
                      </small>
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
                <Button variant="primary" onClick={() => void generate()}>
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
                <div>
                  <span>类型</span>
                  <strong>
                    {selectedAsset.reference
                      ? "设定参考图"
                      : selectedAsset.local
                        ? "本地素材"
                        : "AI 生成"}
                  </strong>
                </div>
                <div><span>场景</span><strong>{scene.title}</strong></div>
                <div><span>状态</span><strong>{scene.assetId === selectedAsset.id ? "已采用" : "候选"}</strong></div>
                {selectedAsset.consistency && (
                  <div>
                    <span>锚点</span>
                    <strong>{selectedAsset.consistency.anchorLabel}</strong>
                  </div>
                )}
                {selectedAsset.consistency && (
                  <div>
                    <span>种子</span>
                    <strong>{selectedAsset.consistency.seed}</strong>
                  </div>
                )}
              </div>
              {selectedAsset.consistency && (
                <p className="asset-inspector__fingerprint">
                  指纹 <code>{selectedAsset.consistency.fingerprint}</code>
                  {selectedAsset.consistency.conditioning === "prompt+img2img"
                    ? " · 参考图参与 img2img"
                    : " · 文字锚点"}
                </p>
              )}
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
                icon={<Paintbrush size={15} />}
                onClick={() => {
                  if (!imageProvider) {
                    pushToast({
                      type: "error",
                      title: "局部重绘需要 Image Provider",
                      message: "先在 AI 模型页配置一个声明 Image 能力的 Provider。",
                    });
                    return;
                  }
                  setInpaintTarget(selectedAsset);
                }}
              >
                局部重绘遮罩区域
              </Button>
              <Button
                variant="secondary"
                className="full-button"
                icon={<BookmarkPlus size={15} />}
                onClick={openCollect}
              >
                收进设定集作为参考图
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
            <span>
              <ShieldCheck size={15} />
            </span>
            <p>
              当前镜头{evaluation?.status === "consistent" ? "与设定集一致" : `：${evaluation?.title ?? "未评估"}`}
              。锚点由角色外观、场景环境、风格锁和参考图共同决定，任何一项修改都会把旧素材标记为过期。
            </p>
          </div>
        </aside>
      </div>

      <Modal
        open={collectOpen}
        onClose={() => setCollectOpen(false)}
        title="把这张图收进设定集"
        description="参考图会参与之后的锚点指纹与生成条件。收进设定集不会影响当前场景已采用的素材。"
        width={480}
      >
        <div className="modal__body">
          <Field label="参考类型">
            <Select
              value={collectRole}
              onChange={(event) => {
                const value = event.target.value as ReferenceRole;
                setCollectRole(value);
                setCollectEntity(
                  value === "character"
                    ? (project.characters[0]?.id ?? "")
                    : value === "location"
                      ? (project.locations[0]?.id ?? "")
                      : STYLE_LOCK_ENTITY_ID,
                );
              }}
            >
              <option value="character">角色</option>
              <option value="location">场景（环境）</option>
              <option value="style">全局风格</option>
            </Select>
          </Field>
          {collectRole !== "style" && (
            <Field label="归属设定卡">
              <Select
                value={collectEntity}
                onChange={(event) => setCollectEntity(event.target.value)}
              >
                {collectRole === "character" ? (
                  project.characters.length ? (
                    project.characters.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))
                  ) : (
                    <option value="">还没有角色</option>
                  )
                ) : project.locations.length ? (
                  project.locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))
                ) : (
                  <option value="">还没有场景</option>
                )}
              </Select>
            </Field>
          )}
        </div>
        <div className="modal__footer">
          <Button variant="secondary" onClick={() => setCollectOpen(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={collectAsReference}>
            加入参考图
          </Button>
        </div>
      </Modal>

      {batchOpen && (
        <BatchImageDialog
          open
          onClose={() => setBatchOpen(false)}
          project={project}
          provider={imageProvider}
          style={style}
          size={
            ratio === "square"
              ? "1024x1024"
              : ratio === "portrait"
                ? "1024x1536"
                : "1536x1024"
          }
          useAnchors={useAnchors}
          jobs={jobs.jobs}
          onEnqueue={jobs.enqueue}
          onCancelJob={jobs.cancel}
          onRetryJob={jobs.retry}
          onClearFinished={jobs.clear}
        />
      )}

      {inpaintTarget && (
        <InpaintStudio
          open
          onClose={() => setInpaintTarget(null)}
          project={project}
          asset={inpaintTarget}
          provider={imageProvider}
          useAnchors={useAnchors}
          onComplete={(asset) => {
            addAsset(project.id, asset);
            setSelectedAssetId(asset.id);
          }}
        />
      )}
    </div>
  );
}
