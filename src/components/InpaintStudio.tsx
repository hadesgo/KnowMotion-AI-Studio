import {
  Eraser,
  Image as ImageIcon,
  LoaderCircle,
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
  maskCoverage,
  sizeForImage,
  type MaskPoint,
  type MaskStroke,
} from "../utils/mask";
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
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [anchorsEnabled, setAnchorsEnabled] = useState(useAnchors);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<MaskPoint | null>(null);

  const scene = asset
    ? project.scenes.find((item) => item.id === asset.sceneId)
    : undefined;
  const anchors = useMemo(
    () => (scene ? resolveSceneAnchors(project, scene) : null),
    [project, scene],
  );
  const coverage = useMemo(() => maskCoverage(strokes), [strokes]);
  const isSvg =
    asset?.mimeType === "image/svg+xml" || asset?.src.startsWith("data:image/svg");

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
  }, [strokes]);

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

  const submit = async () => {
    if (!provider || !asset || !scene || !anchors) {
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
      const masks = buildMaskCanvases(strokes, size.width, size.height);
      const active =
        anchorsEnabled && hasSceneAnchors(anchors) ? anchors : null;
      const finalPrompt = active ? composeAnchoredPrompt(prompt, active) : prompt;
      // 源图与参考图必须先落盘；后端只从项目目录读取。
      await flushDesktopStorage();
      const result = await inpaintProjectImage({
        projectId: project.id,
        sceneId: scene.id,
        sourceAssetId: asset.id,
        provider,
        prompt: finalPrompt,
        negativePrompt: active?.negativePrompt ?? "",
        size: sizeForImage(size.width, size.height),
        maskDataUrl: masks.maskDataUrl,
        maskAlphaDataUrl: masks.alphaMaskDataUrl,
        maskCoverage: masks.coverage,
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
      pushToast({
        type: "success",
        title: "局部重绘完成",
        message: `${provider.name} · ${result.mode === "openai-edits" ? "images/edits" : "ComfyUI inpaint"} · 遮罩 ${(masks.coverage * 100).toFixed(1)}% · ${Math.round(result.elapsedMs / 1000)} 秒`,
      });
      onClose();
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
            {asset ? (
              <img
                src={asset.src}
                alt={asset.name}
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
            <div className="inpaint-toolbar__actions">
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
                onClick={() => setStrokes([])}
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
            {asset ? (
              <>
                <strong>{asset.name}</strong>
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
            ComfyUI 走 LoadImageMask + VAEEncodeForInpaint；OpenAI 兼容走
            images/edits。结果会作为新素材写入当前镜头，不覆盖原图。
          </p>
        </aside>
      </div>

      <div className="modal__footer">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          取消
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
          disabled={busy || !provider || !asset || isSvg || !hasMaskContent(strokes)}
          onClick={() => void submit()}
        >
          {busy ? "正在重绘…" : "重绘遮罩区域"}
        </Button>
      </div>
    </Modal>
  );
}
