import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Captions,
  Download,
  Film,
  Music2,
  Pause,
  Play,
  Plus,
  SkipBack,
  Sparkles,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import {
  Button,
  IconButton,
  Pill,
  TextInput,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { SubtitleCue, TimelineClip, TrackKind } from "../types";
import {
  downloadText,
  formatTime,
  makeId,
  toSrt,
} from "../utils";
import "./TimelineEditor.css";

const tracks: { kind: TrackKind; label: string; icon: typeof Film }[] = [
  { kind: "video", label: "画面", icon: Film },
  { kind: "narration", label: "旁白", icon: AudioLines },
  { kind: "subtitle", label: "字幕", icon: Captions },
  { kind: "music", label: "音乐", icon: Music2 },
  { kind: "sfx", label: "音效", icon: Volume2 },
];

export default function TimelineEditor() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const updateClip = useStudioStore((state) => state.updateTimelineClip);
  const removeClip = useStudioStore((state) => state.removeTimelineClip);
  const addClip = useStudioStore((state) => state.addTimelineClip);
  const replaceSubtitles = useStudioStore((state) => state.replaceSubtitles);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(52);
  const [selectedClipId, setSelectedClipId] = useState(project?.timeline[0]?.id ?? "");
  const [drag, setDrag] = useState<{
    clipId: string;
    startX: number;
    start: number;
  } | null>(null);

  const duration = project?.scenes.reduce((sum, scene) => sum + scene.duration, 0) ?? 0;
  const selectedClip = project?.timeline.find((clip) => clip.id === selectedClipId);
  const currentScene = useMemo(() => {
    if (!project) return undefined;
    let cursor = 0;
    for (const scene of project.scenes) {
      if (currentTime >= cursor && currentTime < cursor + scene.duration) return scene;
      cursor += scene.duration;
    }
    return project.scenes.at(-1);
  }, [currentTime, project]);
  const currentAsset = project?.assets.find((asset) => asset.id === currentScene?.assetId);

  useEffect(() => {
    if (!playing || !duration) return;
    const timer = window.setInterval(() => {
      setCurrentTime((value) => {
        const next = value + 0.033;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
    }, 33);
    return () => window.clearInterval(timer);
  }, [duration, playing]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const delta = (event.clientX - drag.startX) / zoom;
      if (!project) return;
      updateClip(project.id, drag.clipId, {
        start: Math.max(0, Math.round((drag.start + delta) * 10) / 10),
      });
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, project, updateClip, zoom]);

  if (!project) return null;

  const addTrackClip = (kind: TrackKind) => {
    const labels: Record<TrackKind, string> = {
      video: "新画面片段",
      narration: "新旁白段落",
      subtitle: "新字幕条",
      music: "背景音乐",
      sfx: "场景音效",
    };
    const colors: Record<TrackKind, string> = {
      video: "#79a9ff",
      narration: "#a78bfa",
      subtitle: "#c8ff65",
      music: "#f0a760",
      sfx: "#6edfc8",
    };
    const clip: TimelineClip = {
      id: makeId("clip"),
      track: kind,
      sceneId: currentScene?.id,
      label: labels[kind],
      start: Math.min(duration - 1, Math.round(currentTime * 10) / 10),
      duration: 3,
      color: colors[kind],
    };
    addClip(project.id, clip);
    setSelectedClipId(clip.id);
    pushToast({ type: "success", title: "片段已添加到时间轴" });
  };

  const syncSubtitles = () => {
    let cursor = 0;
    const cues: SubtitleCue[] = [];
    project.scenes.forEach((scene) => {
      const segments = scene.narration
        .split(/(?<=[。！？])/)
        .map((item) => item.trim())
        .filter(Boolean);
      const source = segments.length ? segments : [scene.narration];
      const step = scene.duration / source.length;
      source.forEach((text, index) => {
        cues.push({
          id: makeId("sub"),
          sceneId: scene.id,
          start: Number((cursor + index * step).toFixed(2)),
          end: Number((cursor + (index + 1) * step).toFixed(2)),
          text,
        });
      });
      cursor += scene.duration;
    });
    const subtitleClips: TimelineClip[] = cues.map((cue) => ({
      id: makeId("clip"),
      track: "subtitle",
      sceneId: cue.sceneId,
      label: cue.text,
      start: cue.start,
      duration: Math.max(0.8, cue.end - cue.start),
      color: "#c8ff65",
    }));
    replaceSubtitles(project.id, cues);
    updateProject(project.id, (current) => ({
      ...current,
      timeline: [
        ...current.timeline.filter((clip) => clip.track !== "subtitle"),
        ...subtitleClips,
      ],
    }));
    pushToast({
      type: "success",
      title: "字幕已同步",
      message: `${cues.length} 条字幕已写入时间轴。`,
    });
  };

  return (
    <div className="timeline-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="TIMELINE"
        title="在一条时间线上对齐画面、声音和文字"
        description="拖动片段调整入点，选择片段后在上方预览当前场景。浏览器的场景预览不冒充 Remotion 成片。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download size={15} />}
              onClick={() => {
                downloadText(toSrt(project), "knowmotion-captions.srt", "text/plain");
                pushToast({ type: "success", title: "SRT 字幕已导出" });
              }}
            >
              导出 SRT
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/audio`)}
            >
              音频与字幕
            </Button>
          </>
        }
      />

      <div className="timeline-workspace">
        <section className="timeline-preview">
          <div className="timeline-preview__canvas">
            <ScenePreview
              scene={currentScene}
              asset={currentAsset}
              assets={project.assets}
              ratio={project.settings.aspectRatio}
              time={currentTime}
            />
          </div>
          <div className="timeline-preview__side">
            <span className="eyebrow">ACTIVE SCENE</span>
            <h2>{currentScene?.title ?? "无场景"}</h2>
            <p>{currentScene?.narration}</p>
            <div className="timeline-preview__meta">
              <span><Pill tone="accent" dot>播放头 {formatTime(currentTime)}</Pill></span>
              <span>{project.timeline.length} 个片段</span>
            </div>
            <Button
              variant="soft"
              icon={<Sparkles size={15} />}
              onClick={() => navigate(`/projects/${project.id}/animation`)}
            >
              继续编辑当前场景
            </Button>
          </div>
        </section>

        <section className="timeline-editor-panel">
          <header className="timeline-toolbar">
            <div>
              <IconButton label="回到开头" onClick={() => setCurrentTime(0)}>
                <SkipBack size={16} />
              </IconButton>
              <button
                type="button"
                className="play-main-button"
                aria-label={playing ? "暂停" : "播放"}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
              </button>
              <span className="timecode">
                {formatTime(currentTime)}
                <i>/</i>
                {formatTime(duration)}
              </span>
            </div>
            <div>
              <Button
                variant="soft"
                size="sm"
                icon={<Captions size={14} />}
                onClick={syncSubtitles}
              >
                同步字幕
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => addTrackClip("music")}
              >
                添加片段
              </Button>
              <span className="timeline-zoom">
                <span>缩放</span>
                <input
                  type="range"
                  min={28}
                  max={100}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
              </span>
            </div>
          </header>

          <div className="timeline-scroll">
            <div className="timeline-content" style={{ minWidth: `${Math.max(100, duration * zoom + 150)}px` }}>
              <div className="timeline-ruler">
                <span className="track-label">TRACKS</span>
                <div className="ruler-line">
                  {Array.from({ length: Math.ceil(duration / 2) + 1 }, (_, index) => (
                    <span key={index} style={{ left: `${index * 2 * zoom}px` }}>
                      <i />
                      <em>{formatTime(index * 2)}</em>
                    </span>
                  ))}
                </div>
              </div>
              {tracks.map((track) => {
                const Icon = track.icon;
                return (
                  <div className="timeline-track" key={track.kind}>
                    <div className="track-label">
                      <span><Icon size={14} /></span>
                      <div><strong>{track.label}</strong><small>{track.kind}</small></div>
                      <button
                        type="button"
                        aria-label={`添加${track.label}片段`}
                        onClick={() => addTrackClip(track.kind)}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    <div
                      className="track-lane"
                      onPointerDown={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setCurrentTime(Math.max(0, (event.clientX - rect.left) / zoom));
                      }}
                    >
                      {project.timeline
                        .filter((clip) => clip.track === track.kind)
                        .map((clip) => (
                          <button
                            type="button"
                            key={clip.id}
                            className={`timeline-clip timeline-clip--${track.kind} ${
                              selectedClipId === clip.id ? "is-selected" : ""
                            }`}
                            style={{
                              left: `${clip.start * zoom}px`,
                              width: `${Math.max(44, clip.duration * zoom)}px`,
                              "--clip-color": clip.color,
                            } as React.CSSProperties}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              setSelectedClipId(clip.id);
                              setDrag({
                                clipId: clip.id,
                                startX: event.clientX,
                                start: clip.start,
                              });
                            }}
                            onClick={(event) => event.stopPropagation()}
                            title={`${clip.label} · ${clip.duration.toFixed(1)}s`}
                          >
                            {track.kind === "narration" && (
                              <span className="waveform-mini">
                                {Array.from({ length: 28 }, (_, index) => (
                                  <i
                                    key={index}
                                    style={{ height: `${20 + ((index * 13) % 70)}%` }}
                                  />
                                ))}
                              </span>
                            )}
                            <span>{clip.label}</span>
                          </button>
                        ))}
                      <span
                        className="timeline-playhead"
                        style={{ left: `${currentTime * zoom}px` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="timeline-inspector">
          <header>
            <span className="eyebrow">CLIP INSPECTOR</span>
            <h2>片段属性</h2>
          </header>
          {selectedClip ? (
            <>
              <label className="inspector-field">
                <span>名称</span>
                <TextInput
                  value={selectedClip.label}
                  onChange={(event) =>
                    updateClip(project.id, selectedClip.id, {
                      label: event.target.value,
                    })
                  }
                />
              </label>
              <div className="property-grid">
                <label>
                  <span>入点</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={selectedClip.start}
                    onChange={(event) =>
                      updateClip(project.id, selectedClip.id, {
                        start: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>时长</span>
                  <input
                    type="number"
                    min={0.5}
                    step={0.1}
                    value={selectedClip.duration}
                    onChange={(event) =>
                      updateClip(project.id, selectedClip.id, {
                        duration: Math.max(0.5, Number(event.target.value)),
                      })
                    }
                  />
                </label>
              </div>
              <div className="clip-summary">
                <div><span>出点</span><strong>{formatTime(selectedClip.start + selectedClip.duration)}</strong></div>
                <div><span>轨道</span><strong>{tracks.find((track) => track.kind === selectedClip.track)?.label}</strong></div>
                <div><span>关联场景</span><strong>{project.scenes.find((scene) => scene.id === selectedClip.sceneId)?.title ?? "无"}</strong></div>
              </div>
              <div className="property-actions">
                <Button
                  variant="danger"
                  onClick={() => {
                    removeClip(project.id, selectedClip.id);
                    setSelectedClipId("");
                    pushToast({ type: "info", title: "片段已移除" });
                  }}
                  icon={<ArrowLeft size={14} />}
                >
                  从时间轴移除
                </Button>
              </div>
            </>
          ) : (
            <div className="property-empty">
              <Film size={21} />
              <p>选择时间轴片段查看和编辑属性。</p>
            </div>
          )}
          <div className="timeline-keyboard">
            <span className="eyebrow">KEYBOARD</span>
            <p><kbd>Space</kbd> 播放 / 暂停</p>
            <p><kbd>Home</kbd> 回到开头</p>
            <p>拖动片段改变入点</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
