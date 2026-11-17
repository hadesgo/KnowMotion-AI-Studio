import {
  Check,
  GitCompareArrows,
  Eraser,
  Image as ImageIcon,
  LoaderCircle,
  ScanText,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Asset, ProviderProfile, VideoProject } from "../types";
import { inpaintProjectImage } from "../services/capabilities";
import {
  composeAnchoredPrompt,
  createConsistencyStamp,
  hasSceneAnchors,
  resolveSceneAnchors,
} from "../services/consistency";
import { flushDesktopStorage } from "../services/desktop";
import { useStudioStore } from "../store/studio";
import {
  buildMaskCanvases,
  hasMaskContent,
  MAX_MASK_FEATHER_PX,
  maskCoverage,
  sizeForImage,
  type MaskPoint,
  type MaskStroke,
} from "../utils/mask";
import {
  analyzeImageText,
  textRegionsToStrokes,
  type TextRegion,
} from "../utils/textSelection";
import { Button, Modal, Pill, TextArea } from "./ui";
import "./InpaintStudio.css";

const DEFAULT_PROMPT =
  "Keep the same character, lighting and art direction; repaint only the masked area with coherent content.";

export function InpaintStudio({
  open,
  onClose,
  project,
  asset,
  provider,
  useAnchors,
  onComplete,
}: {
  open: boolean;
  onClose: () => void;
  project: VideoProject;
  asset?: Asset;
  provider?: ProviderProfile;
  useAnchors: boolean;
  onComplete: (asset: Asset) => void;
}) {
  const pushToast = useStudioStore((state) => state.pushToast);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [brush, setBrush] = useState(42);
  const [feather, setFeather] = useState(0);
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [autoRegions, setAutoRegions] = useState<TextRegion[]>([]);
  const [detectingText, setDetectingText] = useState(false);
  const [workingAsset, setWorkingAsset] = useState<Asset | undefined>(asset);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [comparePosition, setComparePosition] = useState(52);
  const [anchorsEnabled, setAnchorsEnabled] = useState(useAnchors);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<MaskPoint | null>(null);

  const currentAsset = workingAsset ?? asset;
  const scene = currentAsset
    ? project.scenes.find((item) => item.id === currentAsset.sceneId)
    : undefined;
  const anchors = useMemo(
    () => (scene ? resolveSceneAnchors(project, scene) : null),
    [project, scene],
  );
  const coverage = useMemo(() => maskCoverage(strokes), [strokes]);
  const isSvg =
    currentAsset?.mimeType === "image/svg+xml" ||
    currentAsset?.src.startsWith("data:image/svg");
  const history = useMemo(() => {
    if (!asset) return [];
    let root = asset;
    const seen = new Set<string>();
    while (root.inpaint?.sourceAssetId && !seen.has(root.id)) {
      seen.add(root.id);
      const parent = project.assets.find(
        (item) => item.id === root.inpaint?.sourceAssetId,
      );
      if (!parent) break;
      root = parent;
    }
    const known = new Set([root.id]);
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const item of project.assets) {
        if (
          item.inpaint?.sourceAssetId &&
          known.has(item.inpaint.sourceAssetId) &&
          !known.has(item.id)
        ) {
          known.add(item.id);
          discovered = true;
        }
      }
    }
    return project.assets
      .filter((item) => item.inpaint && known.has(item.inpaint.sourceAssetId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((after) => ({
        after,
        before: project.assets.find(
          (item) => item.id === after.inpaint?.sourceAssetId,
        ),
      }))
      .filter(
        (
          item,
        ): item is {
          after: Asset;
          before: Asset;
        } => Boolean(item.before),
      );
  }, [asset, project.assets]);
  const selectedHistory =
    history.find((item) => item.after.id === selectedHistoryId) ??
    history[history.length - 1];

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(255, 76, 102, 0.44)";
    context.fillStyle = "rgba(255, 76, 102, 0.44)";
    for (const stroke of strokes) {
      if (!stroke.points.length) continue;
      context.lineWidth = Math.max(1, stroke.size * width);
      const first = stroke.points[0];
      if (stroke.points.length === 1) {
        context.beginPath();
        context.arc(
          first.x * width,
          first.y * height,
          Math.max(0.5, (stroke.size * width) / 2),
          0,
          Math.PI * 2,
        );
        context.fill();
        continue;
      }
      context.beginPath();
      context.moveTo(first.x * width, first.y * height);
      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x * width, point.y * height);
      }
      context.stroke();
    }
    if (autoRegions.length) {
      context.save();
      context.setLineDash([5, 4]);
      context.lineWidth = Math.max(1, width * 0.0015);
      context.strokeStyle = "rgba(200, 255, 101, 0.92)";
      for (const region of autoRegions) {
        context.strokeRect(
          region.x * width,
          region.y * height,
          region.width * width,
          region.height * height,
        );
      }
      context.restore();
    }
  }, [autoRegions, strokes]);

  useEffect(() => {
    resizeCanvas();
    const observer = new ResizeObserver(() => {
      resizeCanvas();
      redraw();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [resizeCanvas, redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const toPoint = (event: ReactPointerEvent<HTMLCanvasElement>): MaskPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const normalizedBrush = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect?.width ? brush / rect.width : 0.05;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    setAutoRegions([]);
    const point = toPoint(event);
    lastPointRef.current = point;
    setStrokes((current) => [
      ...current.slice(-199),
      { size: normalizedBrush(), points: [point] },
    ]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || busy) return;
    const point = toPoint(event);
    const last = lastPointRef.current;
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.002) return;
    lastPointRef.current = point;
    setStrokes((current) => {
      if (!current.length) return current;
      const active = current[current.length - 1];
      if (active.points.length > 1800) return current;
      return [
        ...current.slice(0, -1),
        { ...active, points: [...active.points, point] },
      ];
    });
  };

  const endStroke = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
  };

  const selectDetectedText = async () => {
    if (!currentAsset || isSvg || busy || detectingText) return;
    setDetectingText(true);
    setError("");
    try {
      const result = await analyzeImageText(currentAsset.src);
      setAutoRegions(result.regions);
      if (!result.regions.length) {
        setStrokes([]);
        pushToast({
          type: "info",
          title: "没有找到可选的文字带",
          message: "当前画面可能没有清晰文字；仍可直接用画笔涂抹。",
        });
        return;
      }
      setStrokes(
        textRegionsToStrokes(
          result.regions,
          0.12,
          size.width && size.height ? size.height / size.width : 1,
        ),
      );
      pushToast({
        type: "success",
        title: `已选中 ${result.regions.length} 处文字区域`,
        message:
          result.method === "text-detector"
            ? "使用浏览器文字检测器完成，图像未离开本机。"
            : "使用本机高对比文字带分析完成；提交前可继续增删笔迹。",
      });
    } catch (selectionError) {
      const message =
        selectionError instanceof Error
          ? selectionError.message
          : String(selectionError);
      setError(`自动文字选区失败：${message}`);
    } finally {
      setDetectingText(false);
    }
  };

  const submit = async () => {
    if (!provider || !currentAsset || !scene || !anchors) {
      pushToast({ type: "error", title: "重绘需要图片素材、镜头与 Image Provider" });
      return;
    }
    if (!hasMaskContent(strokes)) {
      setError("先用画笔涂出要重绘的区域。");
      return;
    }
    if (coverage < 0.0015) {
      setError("遮罩区域太小，请扩大涂抹范围。");
      return;
    }
    if (!size.width || !size.height) {
      setError("图片尺寸还没有读取完成。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const masks = buildMaskCanvases(
        strokes,
        size.width,
        size.height,
        feather,
      );
      const active =
        anchorsEnabled && hasSceneAnchors(anchors) ? anchors : null;
      const finalPrompt = active ? composeAnchoredPrompt(prompt, active) : prompt;
      // 源图与参考图必须先落盘；后端只从项目目录读取。
      await flushDesktopStorage();
      const result = await inpaintProjectImage({
        projectId: project.id,
        sceneId: scene.id,
        sourceAssetId: currentAsset.id,
        provider,
        prompt: finalPrompt,
        size: sizeForImage(size.width, size.height),
        maskAlphaDataUrl: masks.alphaMaskDataUrl,
        maskLuminanceDataUrl: masks.luminanceMaskDataUrl,
        maskCoverage: masks.coverage,
        maskFeatherPx: masks.featherPx,
        seed: active?.seed,
        anchorLabel: active?.label ?? "",
        consistencyFingerprint: active?.fingerprint ?? "",
      });
      const stamped: Asset = active
        ? {
            ...result.asset,
            consistency: createConsistencyStamp(
              active,
              finalPrompt,
              "prompt+img2img",
            ),
          }
        : result.asset;
      onComplete(stamped);
      setWorkingAsset(stamped);
      setSelectedHistoryId(stamped.id);
      setComparePosition(52);
      setStrokes([]);
      setAutoRegions([]);
      pushToast({
        type: "success",
        title: "局部重绘完成",
        message: `${provider.name} · ${result.mode} · 遮罩 ${(masks.coverage * 100).toFixed(1)}% · 羽化 ${feather}px · ${Math.round(result.elapsedMs / 1000)} 秒`,
      });
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : String(submitError);
      setError(message);
      pushToast({ type: "error", title: "局部重绘失败", message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="局部重绘"
      description="涂抹需要修改的区域，其余像素保持不变。带参考图时，遮罩区会按设定集锚点重新生成。"
      width={1000}
    >
      <div className="inpaint-body">
        <section className="inpaint-canvas-panel">
          <div className="inpaint-canvas" ref={containerRef}>
            {currentAsset ? (
              <img
                src={currentAsset.src}
                alt={currentAsset.name}
                draggable={false}
                onLoad={(event) =>
                  setSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
            ) : (
              <div className="inpaint-placeholder">
                <ImageIcon size={24} />
                <p>没有可重绘的图片</p>
              </div>
            )}
            <canvas
              ref={canvasRef}
              className="inpaint-canvas__overlay"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={endStroke}
            />
          </div>
          <div className="inpaint-toolbar">
            <label className="inpaint-brush">
              <Eraser size={14} />
              <span>笔刷 {brush}px</span>
              <input
                type="range"
                min={10}
                max={140}
                step={2}
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
                aria-label="笔刷大小"
              />
            </label>
            <label className="inpaint-brush">
              <span>羽化 {feather}px</span>
              <input
                type="range"
                min={0}
                max={MAX_MASK_FEATHER_PX}
                step={1}
                value={feather}
                onChange={(event) => setFeather(Number(event.target.value))}
                aria-label="遮罩羽化"
              />
            </label>
            <div className="inpaint-toolbar__actions">
              <Button
                variant="ghost"
                size="sm"
                icon={
                  detectingText ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <ScanText size={14} />
                  )
                }
                disabled={busy || detectingText || !currentAsset || isSvg}
                onClick={() => void selectDetectedText()}
              >
                {detectingText ? "识别中" : "文字选区"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Undo2 size={14} />}
                disabled={!strokes.length || busy}
                onClick={() => setStrokes((current) => current.slice(0, -1))}
              >
                撤销
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                disabled={!strokes.length || busy}
                onClick={() => {
                  setStrokes([]);
                  setAutoRegions([]);
                }}
              >
                清空
              </Button>
            </div>
            <span className="inpaint-coverage">
              遮罩 {(coverage * 100).toFixed(1)}%
            </span>
          </div>
          <p className="inpaint-hint">
            红色区域会被重绘。建议只覆盖需要修改的部分，保留足够的上下文。
          </p>
        </section>

        <aside className="inpaint-settings">
          <div className="inpaint-source">
            {currentAsset ? (
              <>
                <strong>{currentAsset.name}</strong>
                <small>
                  {size.width && size.height
                    ? `${size.width} × ${size.height}`
                    : "读取尺寸…"}{" "}
                  · 输出 {sizeForImage(size.width, size.height)}
                </small>
              </>
            ) : (
              <small>未选择素材</small>
            )}
            {provider ? (
              <Pill tone="info">{provider.name}</Pill>
            ) : (
              <Pill tone="danger">未配置 Image Provider</Pill>
            )}
          </div>

          {isSvg && (
            <p className="inpaint-warning">
              这是本地 SVG 草案，Provider 需要位图输入。请先生成或上传一张位图再重绘。
            </p>
          )}

          <label className="inpaint-prompt">
            <span>重绘提示词</span>
            <TextArea
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <small>
              提示词只作用于遮罩区域；锚点指令会按设定集自动追加。
            </small>
          </label>

          <button
            type="button"
            role="switch"
            aria-checked={anchorsEnabled}
            className={`inpaint-anchor-switch ${anchorsEnabled ? "is-on" : ""}`}
            onClick={() => setAnchorsEnabled((value) => !value)}
          >
            <span>
              <ShieldCheck size={14} />
              {anchorsEnabled ? "使用设定集锚点" : "忽略锚点"}
            </span>
            <small>
              {anchors?.label ?? "当前镜头没有锚点"}
              {anchors?.referenceAssetIds.length
                ? ` · ${anchors.referenceAssetIds.length} 张参考`
                : ""}
            </small>
          </button>

          {anchorsEnabled && (
            <div className="inpaint-anchor-meta">
              <span>
                指纹 <code>{anchors?.fingerprint ?? "—"}</code>
              </span>
              <span>
                种子 <code>{anchors?.seed ?? "—"}</code>
              </span>
            </div>
          )}

          {error && <p className="inpaint-error">{error}</p>}

          <p className="inpaint-note">
            <Wand2 size={13} />
            云端 API 走 images/edits（透明=重绘）；stable-diffusion.cpp
            走原生 img_gen（白=重绘）并保留遮罩外像素。结果会作为新素材写入当前镜头，
            不覆盖原图。
          </p>
        </aside>
      </div>

      {selectedHistory && (
        <section className="inpaint-history" aria-label="重绘历史对比">
          <header>
            <div>
              <span className="eyebrow">REPAINT HISTORY</span>
              <h3>
                <GitCompareArrows size={16} /> 重绘历史对比
              </h3>
            </div>
            <Pill tone="info">{history.length} 个版本</Pill>
          </header>
          <div className="inpaint-history__layout">
            <div className="inpaint-compare">
              <div className="inpaint-compare__frame">
                <img src={selectedHistory.before.src} alt="重绘前" />
                <div
                  className="inpaint-compare__after"
                  style={{
                    clipPath: `inset(0 0 0 ${comparePosition}%)`,
                  }}
                >
                  <img src={selectedHistory.after.src} alt="重绘后" />
                </div>
                <span
                  className="inpaint-compare__divider"
                  style={{ left: `${comparePosition}%` }}
                />
                <span className="inpaint-compare__label is-before">重绘前</span>
                <span className="inpaint-compare__label is-after">重绘后</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={comparePosition}
                aria-label="重绘前后对比位置"
                onChange={(event) =>
                  setComparePosition(Number(event.target.value))
                }
              />
            </div>
            <div className="inpaint-history__versions">
              {history.map((item, index) => (
                <button
                  type="button"
                  key={item.after.id}
                  className={
                    selectedHistory.after.id === item.after.id
                      ? "is-selected"
                      : ""
                  }
                  onClick={() => setSelectedHistoryId(item.after.id)}
                >
                  <img src={item.after.src} alt="" />
                  <span>
                    <strong>版本 {index + 1}</strong>
                    <small>
                      {new Date(item.after.createdAt).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      {" · "}
                      {item.after.inpaint?.mode ?? "inpaint"}
                    </small>
                  </span>
                  {selectedHistory.after.id === item.after.id && (
                    <Check size={13} />
                  )}
                </button>
              ))}
            </div>
            <div className="inpaint-history__meta">
              <span>
                遮罩{" "}
                {((selectedHistory.after.inpaint?.coverage ?? 0) * 100).toFixed(
                  1,
                )}
                %
              </span>
              <span>种子 {selectedHistory.after.inpaint?.seed ?? "—"}</span>
              <span>
                羽化 {selectedHistory.after.inpaint?.featherPx ?? 0}px
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setWorkingAsset(selectedHistory.after);
                  setStrokes([]);
                  setAutoRegions([]);
                }}
              >
                继续编辑此版本
              </Button>
            </div>
          </div>
        </section>
      )}

      <div className="modal__footer">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          完成
        </Button>
        <Button
          variant="primary"
          icon={
            busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )
          }
          disabled={
            busy || !provider || !currentAsset || isSvg || !hasMaskContent(strokes)
          }
          onClick={() => void submit()}
        >
          {busy ? "正在重绘…" : "重绘遮罩区域"}
        </Button>
      </div>
    </Modal>
  );
}
