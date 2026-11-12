import {
  ArrowRight,
  AudioLines,
  Captions,
  Download,
  Mic2,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { ScenePreview } from "../components/ScenePreview";
import {
  Button,
  Field,
  IconButton,
  Pill,
  Select,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type { Asset, SubtitleCue } from "../types";
import {
  downloadText,
  formatBytes,
  makeId,
  nowIso,
  toSrt,
} from "../utils";

export default function AudioSubtitles() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const updateProject = useStudioStore((state) => state.updateProject);
  const addAsset = useStudioStore((state) => state.addAsset);
  const addTimelineClip = useStudioStore((state) => state.addTimelineClip);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [activeSceneId, setActiveSceneId] = useState(project?.scenes[0]?.id ?? "");
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedCueId, setSelectedCueId] = useState(project?.subtitles[0]?.id ?? "");
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const scene = project?.scenes.find((item) => item.id === activeSceneId);
  const asset = project?.assets.find((item) => item.id === scene?.assetId);
  const cue = project?.subtitles.find((item) => item.id === selectedCueId);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.cancel();
      window.speechSynthesis.removeEventListener("voiceschanged", load);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  if (!project) return null;

  const speak = (text = scene?.narration ?? "") => {
    if (!text || !("speechSynthesis" in window)) {
      pushToast({ type: "error", title: "当前浏览器不支持系统语音" });
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = voices.find((item) => item.name === project.audio.voice);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? "zh-CN";
    utterance.rate = project.audio.rate;
    utterance.volume = project.audio.volume;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const stop = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    audioRef.current?.pause();
  };

  const generateSubtitles = () => {
    let cursor = 0;
    const cues: SubtitleCue[] = [];
    project.scenes.forEach((item) => {
      const chunks = item.narration
        .split(/(?<=[。！？])/)
        .map((text) => text.trim())
        .filter(Boolean);
      const source = chunks.length ? chunks : [item.narration];
      const step = item.duration / source.length;
      source.forEach((text, index) => {
        cues.push({
          id: makeId("sub"),
          sceneId: item.id,
          start: Number((cursor + index * step).toFixed(2)),
          end: Number((cursor + (index + 1) * step).toFixed(2)),
          text,
        });
      });
      cursor += item.duration;
    });
    updateProject(project.id, {
      subtitles: cues,
      timeline: [
        ...project.timeline.filter((clip) => clip.track !== "subtitle"),
        ...cues.map((item) => ({
          id: makeId("clip"),
          track: "subtitle" as const,
          sceneId: item.sceneId,
          label: item.text,
          start: item.start,
          duration: Math.max(0.8, item.end - item.start),
          color: "#c8ff65",
        })),
      ],
      stage: "audio",
    });
    setSelectedCueId(cues[0]?.id ?? "");
    pushToast({
      type: "success",
      title: "字幕已生成",
      message: `${cues.length} 条字幕按场景时长重新分配。`,
    });
  };

  const uploadMusic = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      pushToast({
        type: "error",
        title: "音频文件过大",
        message: `原型限制 3 MB，当前文件 ${formatBytes(file.size)}。`,
      });
      event.target.value = "";
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setAudioUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return objectUrl;
    });
    const reader = new FileReader();
    reader.onload = () => {
      const asset: Asset = {
        id: makeId("asset"),
        sceneId: activeSceneId,
        name: file.name,
        kind: "audio",
        src: String(reader.result),
        prompt: "用户上传背景音乐",
        createdAt: nowIso(),
        local: true,
      };
      addAsset(project.id, asset);
      addTimelineClip(project.id, {
        id: makeId("clip"),
        track: "music",
        sceneId: activeSceneId,
        label: file.name,
        start: 0,
        duration: Math.min(project.settings.duration, 12),
        color: "#f0a760",
      });
      pushToast({ type: "success", title: "音频已加入项目" });
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const addCue = () => {
    const newCue: SubtitleCue = {
      id: makeId("sub"),
      sceneId: activeSceneId,
      start: 0,
      end: Math.min(scene?.duration ?? 3, 3),
      text: "新字幕",
    };
    updateProject(project.id, { subtitles: [...project.subtitles, newCue] });
    setSelectedCueId(newCue.id);
  };

  const patchCue = (id: string, patch: Partial<SubtitleCue>) => {
    updateProject(project.id, {
      subtitles: project.subtitles.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  };

  return (
    <div className="audio-page">
      <PageHeading
        eyebrow="AUDIO & CAPTIONS"
        title="让声音和文字跟着画面呼吸"
        description="浏览器试听使用系统语音；字幕时间与导出完全基于项目数据生成。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download size={15} />}
              onClick={() => {
                downloadText(toSrt(project), "knowmotion-captions.srt");
                pushToast({ type: "success", title: "字幕文件已导出" });
              }}
            >
              导出 SRT
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => navigate(`/projects/${project.id}/render`)}
            >
              进入渲染
            </Button>
          </>
        }
      />

      <div className="audio-layout">
        <aside className="narration-list">
          <header>
            <div>
              <span className="eyebrow">NARRATION</span>
              <h2>旁白段落</h2>
            </div>
            <Pill tone="info">{project.scenes.length} 段</Pill>
          </header>
          <div className="narration-list__items">
            {project.scenes.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={item.id === activeSceneId ? "is-active" : ""}
                onClick={() => {
                  stop();
                  setActiveSceneId(item.id);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.narration.length} 字 · {item.duration.toFixed(1)}s</small>
                </div>
                <Play size={13} />
              </button>
            ))}
          </div>
          <section className="voice-controls">
            <span className="eyebrow">VOICE</span>
            <Field label="系统语音">
              <Select
                value={project.audio.voice}
                onChange={(event) =>
                  updateProject(project.id, {
                    audio: { ...project.audio, voice: event.target.value },
                  })
                }
              >
                {voices.length ? (
                  voices.map((voice) => (
                    <option key={voice.name} value={voice.name}>
                      {voice.name} · {voice.lang}
                    </option>
                  ))
                ) : (
                  <option>系统中文语音</option>
                )}
              </Select>
            </Field>
            <label className="range-field">
              <span>语速 <strong>{project.audio.rate.toFixed(2)}×</strong></span>
              <input
                type="range"
                min={0.6}
                max={1.4}
                step={0.02}
                value={project.audio.rate}
                onChange={(event) =>
                  updateProject(project.id, {
                    audio: {
                      ...project.audio,
                      rate: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="range-field">
              <span>音量 <strong>{Math.round(project.audio.volume * 100)}%</strong></span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={project.audio.volume}
                onChange={(event) =>
                  updateProject(project.id, {
                    audio: {
                      ...project.audio,
                      volume: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          </section>
        </aside>

        <section className="audio-main">
          <header className="audio-main__header">
            <div>
              <span className="eyebrow">ACTIVE NARRATION</span>
              <h2>{scene?.title}</h2>
            </div>
            <div className="audio-transport">
              <IconButton label="回到开头" onClick={stop}>
                <Square size={14} />
              </IconButton>
              <Button
                variant={speaking ? "soft" : "primary"}
                icon={speaking ? <Square size={15} /> : <Mic2 size={16} />}
                onClick={() => (speaking ? stop() : speak())}
              >
                {speaking ? "停止试听" : "试听当前旁白"}
              </Button>
            </div>
          </header>

          <div className="waveform-panel">
            <div className="waveform-panel__top">
              <span><AudioLines size={15} /> SYSTEM SPEECH PREVIEW</span>
              <span>{scene?.duration.toFixed(1)}s</span>
            </div>
            <div className={`waveform ${speaking ? "is-playing" : ""}`}>
              {Array.from({ length: 86 }, (_, index) => {
                const seed = (index * 37 + (scene?.narration.length ?? 1)) % 100;
                return <i key={index} style={{ height: `${12 + (seed % 78)}%` }} />;
              })}
              <span className="waveform__playhead" />
            </div>
            <div className="waveform-times">
              <span>00:00</span>
              <span>{scene?.duration.toFixed(1)}s</span>
            </div>
          </div>

          <div className="narration-copy">
            <div>
              <span className="eyebrow">NARRATION COPY</span>
              <Pill tone="neutral">{scene?.narration.length} 字</Pill>
            </div>
            <textarea
              value={scene?.narration ?? ""}
              onChange={(event) =>
                updateProject(project.id, (current) => ({
                  ...current,
                  scenes: current.scenes.map((item) =>
                    item.id === activeSceneId
                      ? { ...item, narration: event.target.value }
                      : item,
                  ),
                }))
              }
              rows={5}
            />
          </div>

          <div className="subtitle-section">
            <header>
              <div>
                <span className="eyebrow">CAPTION CUES</span>
                <h2>字幕时间线索</h2>
              </div>
              <div>
                <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={addCue}>
                  添加字幕
                </Button>
                <Button variant="soft" size="sm" icon={<Sparkles size={14} />} onClick={generateSubtitles}>
                  从旁白生成
                </Button>
              </div>
            </header>
            {project.subtitles.length ? (
              <div className="subtitle-table">
                <div className="subtitle-table__head">
                  <span>#</span><span>开始</span><span>结束</span><span>文本</span><span />
                </div>
                {project.subtitles.map((item, index) => (
                  <div
                    key={item.id}
                    className={`subtitle-table__row ${
                      selectedCueId === item.id ? "is-active" : ""
                    }`}
                    onClick={() => setSelectedCueId(item.id)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={item.start}
                      onChange={(event) =>
                        patchCue(item.id, { start: Number(event.target.value) })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={item.end}
                      onChange={(event) =>
                        patchCue(item.id, { end: Number(event.target.value) })
                      }
                    />
                    <input
                      value={item.text}
                      onChange={(event) =>
                        patchCue(item.id, { text: event.target.value })
                      }
                    />
                    <IconButton
                      label="删除字幕"
                      onClick={(event) => {
                        event.stopPropagation();
                        updateProject(project.id, {
                          subtitles: project.subtitles.filter((cueItem) => cueItem.id !== item.id),
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ) : (
              <div className="subtitle-empty">
                <Captions size={21} />
                <p>还没有字幕。根据旁白生成时间线索，或手动添加一条。</p>
                <Button variant="soft" onClick={generateSubtitles}>
                  从旁白生成字幕
                </Button>
              </div>
            )}
          </div>
        </section>

        <aside className="audio-inspector">
          <span className="eyebrow">CAPTION STYLE</span>
          <h2>字幕样式</h2>
          <div className="caption-preview">
            <ScenePreview
              scene={scene}
              asset={asset}
              ratio={project.settings.aspectRatio}
              time={0.6}
            />
            <span
              style={{
                fontSize: `${Math.max(10, project.audio.subtitleSize / 3)}px`,
                justifyContent:
                  project.audio.subtitlePosition === "center"
                    ? "center"
                    : project.audio.subtitlePosition === "top"
                      ? "flex-start"
                      : "flex-end",
              }}
            >
              {cue?.text ?? "字幕预览"}
            </span>
          </div>
          <label className="range-field">
            <span>字号 <strong>{project.audio.subtitleSize}px</strong></span>
            <input
              type="range"
              min={20}
              max={56}
              value={project.audio.subtitleSize}
              onChange={(event) =>
                updateProject(project.id, {
                  audio: {
                    ...project.audio,
                    subtitleSize: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label className="compact-field">
            <span>位置</span>
            <select
              value={project.audio.subtitlePosition}
              onChange={(event) =>
                updateProject(project.id, {
                  audio: {
                    ...project.audio,
                    subtitlePosition: event.target.value as "bottom" | "center" | "top",
                  },
                })
              }
            >
              <option value="bottom">底部</option>
              <option value="center">居中</option>
              <option value="top">顶部</option>
            </select>
          </label>
          <div className="audio-upload">
            <Upload size={18} />
            <strong>背景音乐</strong>
            <p>导入本地音频，并在时间轴创建音乐片段。</p>
            <label className="file-button">
              <Upload size={14} />
              选择音频
              <input type="file" accept="audio/*" hidden onChange={uploadMusic} />
            </label>
            {audioUrl && (
              <audio ref={audioRef} controls src={audioUrl} className="audio-player" />
            )}
          </div>
          <div className="audio-check">
            <span><CheckMark /></span>
            <p>{project.subtitles.length ? "字幕时间线已建立" : "尚未生成字幕"}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CheckMark() {
  return <span aria-hidden="true">✓</span>;
}
