import {
  ArrowRight,
  Clock,
  Film,
  Monitor,
  Scissors,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import {
  Button,
  EmptyState,
  Field,
  Pill,
  Segmented,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { Asset, SceneLayer } from "../types";
import { isTauriDesktop } from "../services/desktop";
import {
  formatClipTime,
  importProjectVideo,
  pickVideoFile,
  probeVideoSource,
} from "../services/video";
import { formatBytes, makeId } from "../utils";
import "./VideoAssets.css";

export default function VideoAssets() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const addAsset = useStudioStore((state) => state.addAsset);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);

  const [selectedId, setSelectedId] = useState("");
  const [importing, setImporting] = useState(false);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(5);
  const [fit, setFit] = useState<"cover" | "contain" | "fill">("cover");
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [rate, setRate] = useState(1);
  const [targetSceneId, setTargetSceneId] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const videos = useMemo(
    () => (project ? project.assets.filter((asset) => asset.kind === "video") : []),
    [project],
  );
  const selected = videos.find((asset) => asset.id === selectedId) ?? videos[0];
  const durationSeconds = selected?.durationMs
    ? selected.durationMs / 1000
    : 0;
  const clipSeconds = Math.max(0.2, (outPoint - inPoint) / rate);
  const inPercent = durationSeconds
    ? Math.min(100, Math.max(0, (inPoint / durationSeconds) * 100))
    : 0;
  const outPercent = durationSeconds
    ? Math.min(100, Math.max(0, (outPoint / durationSeconds) * 100))
    : 0;
  const sceneTarget =
    project?.scenes.find((scene) => scene.id === targetSceneId) ??
    project?.scenes[0];
  const usages = useMemo(() => {
    if (!project || !selected) return [];
    return project.scenes.flatMap((scene, index) =>
      scene.layers
        .filter((layer) => layer.type === "video" && layer.assetId === selected.id)
        .map((layer) => ({ scene, index, layer })),
    );
  }, [project, selected]);

  if (!project) return null;

  const patchAssetMetadata = (
    assetId: string,
    probe: { durationMs: number; width: number; height: number },
  ) => {
    updateProject(project.id, (current) => ({
      ...current,
      assets: current.assets.map((asset) =>
        asset.id === assetId
          ? {
              ...asset,
              durationMs: probe.durationMs,
              width: probe.width,
              height: probe.height,
            }
          : asset,
      ),
    }));
  };

  const selectVideo = (asset: Asset) => {
    setSelectedId(asset.id);
    setInPoint(0);
    setOutPoint(asset.durationMs ? asset.durationMs / 1000 : 5);
    if (!asset.durationMs) {
      void probeVideoSource(asset.src).then((probe) => {
        if (!probe.decodable || !probe.durationMs) return;
        patchAssetMetadata(asset.id, probe);
        setOutPoint(probe.durationMs / 1000);
      });
    }
  };

  const importVideo = async () => {
    if (!isTauriDesktop) {
      pushToast({
        type: "error",
        title: "导入视频需要桌面运行时",
        message: "浏览器预览无法读取本地文件路径，请运行桌面版。",
      });
      return;
    }
    try {
      const sourcePath = await pickVideoFile();
      if (!sourcePath) return;
      setImporting(true);
      const asset = await importProjectVideo(project.id, sourcePath);
      const probe = await probeVideoSource(asset.src);
      addAsset(project.id, {
        ...asset,
        durationMs: probe.durationMs || asset.durationMs,
        width: probe.width || undefined,
        height: probe.height || undefined,
      });
      setSelectedId(asset.id);
      setInPoint(0);
      setOutPoint(probe.durationMs ? probe.durationMs / 1000 : 5);
      setTargetSceneId(project.scenes[0]?.id ?? "");
      pushToast({
        type: probe.decodable ? "success" : "error",
        title: probe.decodable ? "视频已导入项目" : "视频已复制，但无法解码",
        message: probe.decodable
          ? `${probe.width}×${probe.height} · ${formatClipTime(probe.durationMs / 1000)}`
          : "容器可能不受 Chrome/Remotion 支持，渲染前请转码为 H.264 MP4 或 WebM。",
      });
    } catch (error) {
      pushToast({
        type: "error",
        title: "导入视频失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(false);
    }
  };

  const applyPlayhead = (target: "in" | "out") => {
    const current = videoRef.current?.currentTime ?? 0;
    if (target === "in") {
      setInPoint(Math.min(current, Math.max(0, outPoint - 0.2)));
    } else {
      setOutPoint(Math.max(current, inPoint + 0.2));
    }
  };

  const insertClip = (allScenes: boolean) => {
    if (!selected) return;
    const targets = allScenes ? project.scenes : project.scenes.filter((scene) => scene.id === sceneTarget?.id);
    if (!targets.length) {
      pushToast({ type: "error", title: "没有可插入的镜头" });
      return;
    }
    if (outPoint <= inPoint + 0.1) {
      pushToast({ type: "error", title: "出点必须晚于入点" });
      return;
    }
    const targetIds = new Set(targets.map((scene) => scene.id));
    updateProject(project.id, (current) => ({
      ...current,
      stage: "animation",
      scenes: current.scenes.map((scene) => {
        if (!targetIds.has(scene.id)) return scene;
        const layer: SceneLayer = {
          id: makeId("layer"),
          type: "video",
          name: `${selected.name} · 片段`,
          content: "",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          opacity: 1,
          start: 0,
          end: Math.min(scene.duration, clipSeconds),
          color: "#000000",
          fontSize: 16,
          assetId: selected.id,
          trimStart: inPoint,
          trimEnd: outPoint,
          fit,
          volume,
          muted,
          playbackRate: rate,
          borderRadius: 0,
        };
        return { ...scene, layers: [...scene.layers, layer] };
      }),
    }));
    pushToast({
      type: "success",
      title: allScenes ? "已插入全部镜头" : "已插入当前镜头",
      message: `${formatClipTime(inPoint)} → ${formatClipTime(outPoint)} · ${rate}× · ${
        muted ? "静音" : `音量 ${(volume * 100).toFixed(0)}%`
      }`,
    });
  };

  return (
    <div className="video-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        title="把实拍与屏幕录制剪进知识片"
        description="导入 MP4/WebM 视频，设定入点、出点、速度与音量后插入镜头；视频图层会参与 Remotion 预览和最终渲染。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Scissors size={15} />}
              disabled={!videos.length}
              onClick={() => {
                if (!videos.length) return;
                navigate(`/projects/${project.id}/animation?sceneId=${sceneTarget?.id ?? ""}`);
              }}
            >
              去动画编辑
            </Button>
            <Button
              variant="primary"
              icon={<Upload size={15} />}
              disabled={importing}
              onClick={() => void importVideo()}
            >
              {importing ? "正在导入…" : "导入视频"}
            </Button>
          </>
        }
      />

      <div className="video-layout">
        <section className="video-library">
          <header>
            <div>
              <span className="eyebrow">VIDEO LIBRARY</span>
              <h2>视频素材 · {videos.length}</h2>
            </div>
            <Pill tone={videos.length ? "info" : "neutral"}>
              {videos.length ? "已就绪" : "空"}
            </Pill>
          </header>

          {videos.length ? (
            <div className="video-grid">
              {videos.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`video-card ${selected?.id === asset.id ? "is-selected" : ""}`}
                  onClick={() => selectVideo(asset)}
                >
                  <video
                    src={`${asset.src}#t=0.2`}
                    muted
                    playsInline
                    preload="metadata"
                  />
                  <span className="video-card__badge">
                    <Film size={11} />
                    {(asset.mimeType ?? "video").replace("video/", "").toUpperCase()}
                  </span>
                  <span className="video-card__body">
                    <strong>{asset.name}</strong>
                    <small>
                      {asset.durationMs
                        ? formatClipTime(asset.durationMs / 1000)
                        : "时长待探测"}
                      {asset.width && asset.height
                        ? ` · ${asset.width}×${asset.height}`
                        : ""}
                      {asset.bytes ? ` · ${formatBytes(asset.bytes)}` : ""}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Film size={24} />}
              title="还没有视频素材"
              description="导入一段实拍、访谈或屏幕录制；导入后会复制到项目 assets/videos，和其他素材一起随项目打包。"
              action={
                <Button
                  variant="primary"
                  icon={<Upload size={15} />}
                  disabled={importing}
                  onClick={() => void importVideo()}
                >
                  导入第一段视频
                </Button>
              }
            />
          )}
        </section>

        <aside className="video-editor">
          {selected ? (
            <>
              <header>
                <div>
                  <span className="eyebrow">CLIP EDITOR</span>
                  <h2>{selected.name}</h2>
                </div>
                <Pill tone="accent">{rate}×</Pill>
              </header>

              <div className="video-preview">
                <video
                  ref={videoRef}
                  src={selected.src}
                  controls
                  muted={muted}
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    if (!selected.durationMs) {
                      const duration = event.currentTarget.duration;
                      if (Number.isFinite(duration) && duration > 0) {
                        patchAssetMetadata(selected.id, {
                          durationMs: Math.round(duration * 1000),
                          width: event.currentTarget.videoWidth,
                          height: event.currentTarget.videoHeight,
                        });
                        setOutPoint(duration);
                      }
                    }
                  }}
                />
                <div className="video-trim-bar" aria-hidden="true">
                  <span
                    className="video-trim-bar__active"
                    style={{
                      left: `${inPercent}%`,
                      width: `${Math.max(0, outPercent - inPercent)}%`,
                    }}
                  />
                </div>
                <div className="video-trim-meta">
                  <span>入 {formatClipTime(inPoint)}</span>
                  <span>出 {formatClipTime(outPoint)}</span>
                  <span>片段 {formatClipTime(Math.max(0, outPoint - inPoint))}</span>
                </div>
              </div>

              <div className="video-fields">
                <div className="video-row">
                  <Field label="入点（秒）">
                    <div className="video-time-field">
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={Number(inPoint.toFixed(2))}
                        onChange={(event) =>
                          setInPoint(Math.max(0, Number(event.target.value)))
                        }
                      />
                      <button type="button" onClick={() => applyPlayhead("in")}>
                        用播放位置
                      </button>
                    </div>
                  </Field>
                  <Field label="出点（秒）">
                    <div className="video-time-field">
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={Number(outPoint.toFixed(2))}
                        onChange={(event) =>
                          setOutPoint(Math.max(0, Number(event.target.value)))
                        }
                      />
                      <button type="button" onClick={() => applyPlayhead("out")}>
                        用播放位置
                      </button>
                    </div>
                  </Field>
                </div>

                <div className="video-setting">
                  <span>适配方式</span>
                  <Segmented
                    value={fit}
                    onChange={setFit}
                    label="视频适配方式"
                    options={[
                      { value: "cover", label: "裁切填充" },
                      { value: "contain", label: "完整显示" },
                      { value: "fill", label: "拉伸" },
                    ]}
                  />
                </div>

                <div className="video-setting">
                  <span>播放速度</span>
                  <Segmented
                    value={String(rate)}
                    onChange={(value) => setRate(Number(value))}
                    label="视频播放速度"
                    options={[
                      { value: "0.5", label: "0.5×" },
                      { value: "1", label: "1×" },
                      { value: "1.5", label: "1.5×" },
                      { value: "2", label: "2×" },
                    ]}
                  />
                </div>

                <div className="video-setting">
                  <span>
                    {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    音量
                  </span>
                  <div className="video-volume">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={volume}
                      disabled={muted}
                      onChange={(event) => setVolume(Number(event.target.value))}
                      aria-label="视频音量"
                    />
                    <em>{(volume * 100).toFixed(0)}%</em>
                    <button
                      type="button"
                      className={muted ? "is-on" : ""}
                      onClick={() => setMuted((value) => !value)}
                    >
                      {muted ? "已静音" : "静音"}
                    </button>
                  </div>
                </div>

                <Field label="插入镜头">
                  <select
                    value={sceneTarget?.id ?? ""}
                    onChange={(event) => setTargetSceneId(event.target.value)}
                  >
                    {project.scenes.map((scene, index) => (
                      <option key={scene.id} value={scene.id}>
                        {String(index + 1).padStart(2, "0")} · {scene.title}
                      </option>
                    ))}
                  </select>
                </Field>

                {selected.bytes && selected.bytes > 24 * 1024 * 1024 && (
                  <p className="video-warning">
                    这段视频 {formatBytes(selected.bytes)}，超过渲染嵌入上限 24 MB。
                    请先压缩或裁剪，否则正式渲染会直接报错。
                  </p>
                )}

                <p className="video-note">
                  <Clock size={13} />
                  片段 {formatClipTime(clipSeconds)}，插入后会作为全画幅视频图层，可在动画编辑器中继续调整位置与时长。
                </p>

                <div className="video-actions">
                  <Button
                    variant="secondary"
                    icon={<Monitor size={15} />}
                    onClick={() => insertClip(false)}
                  >
                    插入当前镜头
                  </Button>
                  <Button
                    variant="primary"
                    icon={<ArrowRight size={15} />}
                    onClick={() => insertClip(true)}
                  >
                    插入全部镜头
                  </Button>
                </div>

                {usages.length > 0 && (
                  <div className="video-usages">
                    <span className="eyebrow">USED IN {usages.length} SHOTS</span>
                    {usages.map(({ scene, index, layer }) => (
                      <button
                        key={`${scene.id}-${layer.id}`}
                        type="button"
                        onClick={() =>
                          navigate(
                            `/projects/${project.id}/animation?sceneId=${scene.id}&layerId=${layer.id}`,
                          )
                        }
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        {scene.title}
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="video-editor__empty">
              <Film size={22} />
              <p>导入视频后，在这里设置入点、出点与播放参数。</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
