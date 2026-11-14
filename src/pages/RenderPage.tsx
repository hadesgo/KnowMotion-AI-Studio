import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clapperboard,
  Download,
  Film,
  FolderArchive,
  Image as ImageIcon,
  LoaderCircle,
  MonitorPlay,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import {
  Button,
  Pill,
  Progress,
  Segmented,
  Select,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { AspectRatio, VideoProject } from "../types";
import {
  downloadBlob,
  downloadText,
  formatBytes,
  formatTime,
  makeId,
  nowIso,
} from "../utils";
import "./RenderPage.css";

type Resolution = "720p" | "1080p";
type PreviewLength = "6s" | "full";

interface RenderLog {
  time: string;
  level: "info" | "success" | "warning";
  message: string;
}

function canvasSize(
  ratio: AspectRatio,
  resolution: Resolution,
): { width: number; height: number } {
  const longEdge = resolution === "1080p" ? 1920 : 1280;
  if (ratio === "9:16") {
    return {
      width: resolution === "1080p" ? 1080 : 720,
      height: longEdge,
    };
  }
  if (ratio === "1:1") {
    return {
      width: resolution === "1080p" ? 1080 : 720,
      height: resolution === "1080p" ? 1080 : 720,
    };
  }
  return {
    width: longEdge,
    height: resolution === "1080p" ? 1080 : 720,
  };
}

function drawFrame(
  context: CanvasRenderingContext2D,
  project: VideoProject,
  elapsed: number,
  totalDuration: number,
) {
  const { width, height } = context.canvas;
  const scale = Math.min(width / 1920, height / 1080);
  context.clearRect(0, 0, width, height);
  const background = context.createRadialGradient(
    width * 0.75,
    height * 0.25,
    20,
    width * 0.5,
    height * 0.5,
    width,
  );
  background.addColorStop(0, "#153d43");
  background.addColorStop(0.5, "#091a23");
  background.addColorStop(1, "#05090d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  let cursor = 0;
  let scene = project.scenes[0];
  let sceneStart = 0;
  for (const item of project.scenes) {
    if (elapsed >= cursor && elapsed < cursor + item.duration) {
      scene = item;
      sceneStart = cursor;
      break;
    }
    cursor += item.duration;
  }
  if (!scene) {
    context.fillStyle = "#eef3f8";
    context.font = `600 ${48 * scale}px Segoe UI, sans-serif`;
    context.fillText("KnowMotion AI Studio", 90 * scale, height / 2);
    return;
  }

  const local = Math.max(0, elapsed - sceneStart);
  const progress = Math.min(1, local / scene.duration);
  const centerX = width * (0.73 + Math.sin(elapsed * 0.18) * 0.015);
  const centerY = height * (0.31 + Math.cos(elapsed * 0.15) * 0.012);
  context.save();
  context.translate(centerX, centerY);
  for (let index = 0; index < 4; index += 1) {
    const radius = (80 + index * 58 + progress * 16) * scale;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.strokeStyle = scene.accent;
    context.globalAlpha = 0.52 - index * 0.09;
    context.lineWidth = index === 0 ? 3 * scale : 1.2 * scale;
    context.stroke();
  }
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(0, 0, 22 * scale, 0, Math.PI * 2);
  context.fillStyle = scene.accent;
  context.fill();
  context.restore();

  const entrance = Math.min(1, local / 0.8);
  context.globalAlpha = entrance;
  const margin = width > height ? 92 * scale : 58 * scale;
  context.fillStyle = scene.accent;
  context.font = `500 ${15 * scale}px Segoe UI, sans-serif`;
  context.letterSpacing = `${4 * scale}px`;
  context.fillText(
    `KNOWMOTION / SCENE ${String(project.scenes.indexOf(scene) + 1).padStart(2, "0")}`,
    margin,
    height * (width > height ? 0.29 : 0.18),
  );
  context.fillStyle = "#f1f6f2";
  context.font = `600 ${(width > height ? 58 : 42) * scale}px Segoe UI, Microsoft YaHei, sans-serif`;
  wrapCanvasText(
    context,
    scene.title,
    margin,
    height * (width > height ? 0.39 : 0.28),
    width - margin * 2,
    (width > height ? 68 : 50) * scale,
    2,
  );
  context.globalAlpha = Math.min(1, Math.max(0, (local - 0.4) / 0.7));
  context.fillStyle = "#a9b8c4";
  context.font = `400 ${(width > height ? 23 : 19) * scale}px Segoe UI, Microsoft YaHei, sans-serif`;
  wrapCanvasText(
    context,
    scene.narration,
    margin,
    height * (width > height ? 0.6 : 0.52),
    width * (width > height ? 0.55 : 0.8),
    (width > height ? 34 : 29) * scale,
    4,
  );

  const subtitle = project.subtitles.find(
    (cue) => elapsed >= cue.start && elapsed <= cue.end,
  );
  if (subtitle) {
    const fontSize = Math.max(18, project.audio.subtitleSize * scale * 0.85);
    context.font = `500 ${fontSize}px Segoe UI, Microsoft YaHei, sans-serif`;
    const textWidth = context.measureText(subtitle.text).width;
    context.fillStyle = "rgba(3, 7, 10, .76)";
    context.fillRect(
      (width - textWidth) / 2 - 22,
      height - 112 * scale,
      textWidth + 44,
      fontSize + 26,
    );
    context.fillStyle = "#f5f7f3";
    context.textAlign = "center";
    context.fillText(subtitle.text, width / 2, height - 78 * scale);
    context.textAlign = "left";
  }

  context.globalAlpha = 1;
  context.fillStyle = "#8292a2";
  context.font = `500 ${13 * scale}px Segoe UI, sans-serif`;
  context.fillText("KNOWMOTION AI STUDIO", margin, height - 42 * scale);
  context.fillStyle = scene.accent;
  context.fillRect(margin, height - 34 * scale, Math.max(3, (width - margin * 2) * (elapsed / totalDuration)), 3);
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const chars = [...text];
  let line = "";
  let lineIndex = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const test = line + chars[index];
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(line, x, y + lineIndex * lineHeight);
      line = chars[index];
      lineIndex += 1;
      if (lineIndex >= maxLines) return;
    } else {
      line = test;
    }
  }
  if (line) context.fillText(line, x, y + lineIndex * lineHeight);
}

export default function RenderPage() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [length, setLength] = useState<PreviewLength>("6s");
  const [progress, setProgress] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoSize, setVideoSize] = useState(0);
  const [logs, setLogs] = useState<RenderLog[]>([
    { time: "READY", level: "info", message: "等待启动本地预览渲染" },
  ]);
  const [preflightRun, setPreflightRun] = useState(false);
  const cancelRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const checks = useMemo(() => {
    if (!project) return [];
    return [
      {
        label: "项目场景",
        ok: project.scenes.length > 0,
        detail: `${project.scenes.length} 个场景`,
      },
      {
        label: "旁白内容",
        ok: project.scenes.every((scene) => scene.narration.trim().length > 0),
        detail: project.scenes.every((scene) => scene.narration.trim())
          ? "每个场景都有旁白"
          : "存在空白旁白",
      },
      {
        label: "画面素材",
        ok: project.assets.length > 0,
        detail: project.assets.length
          ? `${project.assets.length} 个素材，其余场景使用矢量构图`
          : "全部使用内置矢量场景",
      },
      {
        label: "字幕时间线",
        ok: project.subtitles.length > 0,
        detail: project.subtitles.length
          ? `${project.subtitles.length} 条字幕`
          : "未生成字幕",
      },
    ];
  }, [project]);

  if (!project) return null;
  const totalDuration = project.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const previewDuration = length === "full" ? Math.max(1, totalDuration) : 6;

  const pushLog = (level: RenderLog["level"], message: string) => {
    setLogs((current) => [
      ...current,
      { time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), level, message },
    ]);
  };

  const runPreflight = () => {
    setPreflightRun(true);
    const failed = checks.filter((check) => !check.ok);
    pushLog(
      failed.length ? "warning" : "success",
      failed.length
        ? `预检完成，${failed.length} 项建议在正式渲染前处理`
        : "项目预检通过，可生成本地预览",
    );
    pushToast({
      type: failed.length ? "info" : "success",
      title: failed.length ? "预检完成，有可改进项" : "项目预检通过",
      message: failed.length ? "正式渲染前建议补齐素材或字幕。" : undefined,
    });
  };

  const renderPreview = async () => {
    if (!("MediaRecorder" in window)) {
      pushToast({
        type: "error",
        title: "当前浏览器不支持 MediaRecorder",
      });
      return;
    }
    setRendering(true);
    setVideoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return "";
    });
    setProgress(0);
    setLogs([]);
    pushLog("info", `初始化 ${resolution} Canvas 预览`);
    cancelRef.current = false;
    const canvas = document.createElement("canvas");
    const size = canvasSize(project.settings.aspectRatio, resolution);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      setRendering(false);
      pushToast({ type: "error", title: "无法创建渲染画布" });
      return;
    }
    drawFrame(context, project, 0, previewDuration);
    const stream = canvas.captureStream(24);
    const mimeType =
      ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      ) ?? "";
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    });
    recorder.start(250);
    pushLog("success", "MediaRecorder 已启动，正在按帧绘制");
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const elapsed = Math.min(previewDuration, (now - startedAt) / 1000);
        drawFrame(context, project, elapsed, previewDuration);
        setProgress(Math.min(98, (elapsed / previewDuration) * 100));
        if (elapsed < previewDuration && !cancelRef.current) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const url = URL.createObjectURL(blob);
    setVideoUrl(url);
    setVideoSize(blob.size);
    setProgress(100);
    setRendering(false);
    pushLog(
      cancelRef.current ? "warning" : "success",
      cancelRef.current
        ? "渲染已取消，生成当前已编码片段"
        : `本地预览完成，${formatBytes(blob.size)}`,
    );
    if (!cancelRef.current) {
      updateProject(project.id, (current) => ({
        ...current,
        stage: "render",
        renders: [
          {
            id: makeId("render"),
            createdAt: nowIso(),
            resolution,
            format: "WebM",
            duration: previewDuration,
            size: formatBytes(blob.size),
            status: "ready",
          },
          ...current.renders,
        ],
      }));
      pushToast({
        type: "success",
        title: "WebM 预览已完成",
        message: "可在页面中播放或下载。",
      });
    }
  };

  const savePoster = () => {
    const canvas = document.createElement("canvas");
    const size = canvasSize(project.settings.aspectRatio, "1080p");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    drawFrame(context, project, 0.8, Math.max(1, totalDuration));
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `${project.title.replace(/[\\/:*?"<>|]/g, "-")}-poster.png`);
        pushToast({ type: "success", title: "封面 PNG 已生成" });
      }
    }, "image/png");
  };

  return (
    <div className="render-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="RENDER & EXPORT"
        title="把项目变成一段可以分享的视频"
        description="这里生成轻量 WebM 预览；完整 1080P H.264 MP4 由 Remotion Studio 的真实 Renderer 输出。"
        actions={
          <>
            <Button
              variant="primary"
              icon={<MonitorPlay size={15} />}
              onClick={() => navigate(`/projects/${project.id}/remotion`)}
            >
              打开完整 MP4 渲染
            </Button>
            <Button
              variant="secondary"
              icon={<ImageIcon size={15} />}
              onClick={savePoster}
            >
              导出封面
            </Button>
            <Button
              variant="secondary"
              icon={<FolderArchive size={15} />}
              onClick={() => {
                downloadText(
                  JSON.stringify(project, null, 2),
                  `${project.title}.knowmotion.json`,
                  "application/json",
                );
                pushToast({ type: "success", title: "项目包已下载" });
              }}
            >
              导出项目包
            </Button>
          </>
        }
      />

      <div className="render-layout">
        <aside className="render-settings">
          <span className="eyebrow">OUTPUT SETTINGS</span>
          <h2>渲染设置</h2>
          <label className="render-setting">
            <span>画幅</span>
            <strong>{project.settings.aspectRatio} · {canvasSize(project.settings.aspectRatio, resolution).width}×{canvasSize(project.settings.aspectRatio, resolution).height}</strong>
          </label>
          <label className="render-setting render-setting--stack">
            <span>分辨率</span>
            <Segmented
              value={resolution}
              onChange={setResolution}
              label="渲染分辨率"
              options={[
                { value: "720p", label: "HD 720p" },
                { value: "1080p", label: "Full HD" },
              ]}
            />
          </label>
          <label className="render-setting render-setting--stack">
            <span>预览长度</span>
            <Segmented
              value={length}
              onChange={setLength}
              label="预览长度"
              options={[
                { value: "6s", label: "6 秒预览" },
                { value: "full", label: "完整项目" },
              ]}
            />
          </label>
          <label className="render-setting render-setting--stack">
            <span>编码</span>
            <Select value="webm" onChange={() => undefined}>
              <option value="webm">WebM · 浏览器本地</option>
            </Select>
          </label>
          <div className="desktop-render-card">
            <span><MonitorPlay size={19} /></span>
            <div>
              <strong>H.264 MP4 · 4K</strong>
              <p>Remotion Studio 已接入桌面 Node + Renderer 导出链路。</p>
            </div>
            <Pill tone="success">已接入</Pill>
          </div>
          <div className="render-estimate">
            <div><span>输出时长</span><strong>{formatTime(previewDuration)}</strong></div>
            <div><span>预估帧数</span><strong>{Math.round(previewDuration * 24)}</strong></div>
            <div><span>场景数</span><strong>{project.scenes.length}</strong></div>
          </div>
        </aside>

        <section className="render-main">
          <div className="render-preview-card">
            <div className="render-preview-card__header">
              <div>
                <span className="eyebrow">LOCAL OUTPUT</span>
                <h2>{rendering ? "正在生成预览…" : videoUrl ? "预览已就绪" : "项目预览"}</h2>
              </div>
              <Pill tone={videoUrl ? "success" : "neutral"} dot={Boolean(videoUrl)}>
                {videoUrl ? "WebM READY" : "PREVIEW ONLY"}
              </Pill>
            </div>
            <div className="render-video-area">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  playsInline
                  className="render-video"
                />
              ) : (
                <div
                  className={`render-poster render-poster--${project.settings.aspectRatio.replace(":", "-")}`}
                >
                  <ScenePreview
                    scene={project.scenes[0]}
                    asset={project.assets.find(
                      (asset) => asset.id === project.scenes[0]?.assetId,
                    )}
                    assets={project.assets}
                    ratio={project.settings.aspectRatio}
                    time={0.8}
                  />
                  <div className="render-poster__overlay">
                    <span><Clapperboard size={18} /></span>
                    <div>
                      <strong>{project.title}</strong>
                      <small>
                        {resolution.toUpperCase()} · {project.settings.aspectRatio} · 24 FPS
                      </small>
                    </div>
                  </div>
                </div>
              )}
              {rendering && (
                <div className="render-progress-overlay">
                  <LoaderCircle className="spin" size={28} />
                  <strong>{Math.round(progress)}%</strong>
                  <span>正在绘制 Canvas 帧并编码 WebM</span>
                </div>
              )}
              {videoUrl && <span className="video-ready-badge"><Check size={13} /> 真实本地视频</span>}
            </div>
            {progress > 0 && (
              <div className="render-progress-bar">
                <Progress value={progress} />
                <div>
                  <span>{rendering ? `正在绘制 · ${Math.round(progress)}%` : "编码完成"}</span>
                  <span>{formatBytes(videoSize)}</span>
                </div>
              </div>
            )}
            <footer className="render-actions">
              {rendering ? (
                <Button
                  variant="danger"
                  icon={<RotateCcw size={15} />}
                  onClick={() => {
                    cancelRef.current = true;
                    pushLog("warning", "用户请求停止渲染");
                  }}
                >
                  停止渲染
                </Button>
              ) : videoUrl ? (
                <>
                  <Button
                    variant="secondary"
                    icon={<Play size={15} />}
                    onClick={() => videoRef.current?.play()}
                  >
                    播放预览
                  </Button>
                  <Button
                    variant="primary"
                    icon={<Download size={15} />}
                    onClick={() =>
                      fetch(videoUrl)
                        .then((response) => response.blob())
                        .then((blob) =>
                          downloadBlob(
                            blob,
                            `${project.title.replace(/[\\/:*?"<>|]/g, "-")}.webm`,
                          ),
                        )
                    }
                  >
                    下载 WebM
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Film size={17} />}
                  onClick={renderPreview}
                >
                  生成 {resolution} WebM 预览
                </Button>
              )}
              <Button variant="ghost" onClick={runPreflight}>
                运行预检
              </Button>
            </footer>
          </div>

          <section className="render-checks">
            <header>
              <div>
                <span className="eyebrow">PRE-FLIGHT</span>
                <h2>发布前检查</h2>
              </div>
              {preflightRun && (
                <Pill tone={checks.every((check) => check.ok) ? "success" : "warning"}>
                  {checks.filter((check) => check.ok).length}/{checks.length} 通过
                </Pill>
              )}
            </header>
            <div className="render-check-grid">
              {checks.map((check) => (
                <div key={check.label} className={check.ok ? "is-ok" : "is-warn"}>
                  <span>
                    {check.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                  </span>
                  <div>
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </section>

        <aside className="render-log-panel">
          <header>
            <span className="eyebrow">RENDER LOG</span>
            <h2>本地任务日志</h2>
          </header>
          <div className="render-log">
            {logs.map((log, index) => (
              <div key={`${log.time}-${index}`} className={`render-log__item render-log__item--${log.level}`}>
                <span>{log.time}</span>
                <i />
                <p>{log.message}</p>
              </div>
            ))}
          </div>
          <div className="render-runtime">
            <div><span>WebView</span><strong>READY</strong></div>
            <div><span>Canvas</span><strong>READY</strong></div>
            <div><span>MediaRecorder</span><strong>{("MediaRecorder" in window) ? "READY" : "N/A"}</strong></div>
            <div><span>Node Renderer</span><strong>REMOTION STUDIO</strong></div>
          </div>
          <section className="render-history">
            <span className="eyebrow">HISTORY</span>
            {project.renders.length ? (
              project.renders.slice(0, 5).map((record) => (
                <div key={record.id}>
                  <span><Film size={14} /></span>
                  <div>
                    <strong>{record.resolution} · {record.format}</strong>
                    <small>{formatTime(record.duration)} · {record.size}</small>
                  </div>
                  <CheckCircle2 size={14} />
                </div>
              ))
            ) : (
              <p className="render-history__empty">还没有完成过本地渲染。</p>
            )}
          </section>
          <div className="render-security">
            <ShieldCheck size={17} />
            <p>文件只在本机生成；项目、素材和输出不会自动上传。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
