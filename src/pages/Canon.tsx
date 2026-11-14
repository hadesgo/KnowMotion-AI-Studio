import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Copy,
  Image as ImageIcon,
  Lock,
  LockOpen,
  MapPin,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Users,
  Wand2,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Pill,
  Progress,
  TextArea,
  TextInput,
} from "../components/ui";
import { createCharacter, createLocation } from "../data/demo";
import {
  consistencyReport,
  paletteToText,
  parsePalette,
  referenceAssetsFor,
  resolveSceneAnchors,
  seedFromFingerprint,
  STYLE_LOCK_ENTITY_ID,
  stableHash,
  type ConsistencyEvaluation,
} from "../services/consistency";
import { useStudioStore } from "../store/studio";
import type { CharacterProfile, LocationProfile, ReferenceRole } from "../types";
import { createVisualDraftSvg, formatBytes, makeId, nowIso } from "../utils";
import "./Canon.css";

type Selection =
  | { kind: "character"; id: string }
  | { kind: "location"; id: string }
  | { kind: "style"; id: string };

const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

function toneFor(evaluation: ConsistencyEvaluation) {
  return evaluation.status === "consistent"
    ? evaluation.weak
      ? "warning"
      : "success"
    : evaluation.status === "stale"
      ? "danger"
      : evaluation.status === "unapplied"
        ? "info"
        : "neutral";
}

function shortStatus(evaluation: ConsistencyEvaluation) {
  if (evaluation.status === "consistent") {
    return evaluation.weak ? "文字一致" : "已一致";
  }
  if (evaluation.status === "stale") return "已过期";
  if (evaluation.status === "unapplied") return "未生成";
  return "未绑定";
}

export default function Canon() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const upsertCharacter = useStudioStore((state) => state.upsertCharacter);
  const removeCharacter = useStudioStore((state) => state.removeCharacter);
  const upsertLocation = useStudioStore((state) => state.upsertLocation);
  const removeLocation = useStudioStore((state) => state.removeLocation);
  const updateStyleLock = useStudioStore((state) => state.updateStyleLock);
  const attachReference = useStudioStore((state) => state.attachReference);
  const updateReferenceAsset = useStudioStore(
    (state) => state.updateReferenceAsset,
  );
  const removeReferenceAsset = useStudioStore(
    (state) => state.removeReferenceAsset,
  );
  const setSceneAnchors = useStudioStore((state) => state.setSceneAnchors);
  const pushToast = useStudioStore((state) => state.pushToast);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Selection | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const report = useMemo(
    () => (project ? consistencyReport(project) : null),
    [project],
  );

  const selected = useMemo<Selection>(() => {
    if (!project) return { kind: "style", id: STYLE_LOCK_ENTITY_ID };
    if (
      selection?.kind === "character" &&
      project.characters.some((item) => item.id === selection.id)
    ) {
      return selection;
    }
    if (
      selection?.kind === "location" &&
      project.locations.some((item) => item.id === selection.id)
    ) {
      return selection;
    }
    if (selection?.kind === "style") return selection;
    const firstCharacter = project.characters[0];
    if (firstCharacter) return { kind: "character", id: firstCharacter.id };
    const firstLocation = project.locations[0];
    if (firstLocation) return { kind: "location", id: firstLocation.id };
    return { kind: "style", id: STYLE_LOCK_ENTITY_ID };
  }, [project, selection]);

  if (!project || !report) return null;

  const character =
    selected.kind === "character"
      ? project.characters.find((item) => item.id === selected.id)
      : undefined;
  const location =
    selected.kind === "location"
      ? project.locations.find((item) => item.id === selected.id)
      : undefined;
  const styleLock = project.styleLock;
  const role: ReferenceRole = selected.kind;
  const entityId =
    selected.kind === "style" ? STYLE_LOCK_ENTITY_ID : selected.id;
  const references = referenceAssetsFor(project, role, entityId);
  const previewScene = project.scenes[0];
  const previewAnchors = previewScene
    ? resolveSceneAnchors(project, previewScene)
    : null;
  const title = character?.name ?? location?.name ?? "全局风格锁定";
  const description =
    character?.summary ||
    location?.summary ||
    "统一所有镜头的视觉语言、调色板与负向提示词。";

  const patchCharacter = (patch: Partial<CharacterProfile>) => {
    if (!character) return;
    upsertCharacter(project.id, { ...character, ...patch });
  };

  const patchLocation = (patch: Partial<LocationProfile>) => {
    if (!location) return;
    upsertLocation(project.id, { ...location, ...patch });
  };

  const createEntity = (kind: "character" | "location") => {
    if (kind === "location") {
      const next = createLocation(`场景 ${project.locations.length + 1}`);
      upsertLocation(project.id, next);
      setSelection({ kind: "location", id: next.id });
    } else {
      const next = createCharacter(`角色 ${project.characters.length + 1}`);
      upsertCharacter(project.id, next);
      setSelection({ kind: "character", id: next.id });
    }
    pushToast({
      type: "success",
      title: "已创建新的设定卡",
      message: "填写外观锚点后可以补充参考图。",
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "character") {
      removeCharacter(project.id, pendingDelete.id);
    } else if (pendingDelete.kind === "location") {
      removeLocation(project.id, pendingDelete.id);
    }
    setPendingDelete(null);
    setSelection(null);
    pushToast({
      type: "info",
      title: "设定卡已删除",
      message: "相关镜头绑定与参考图已一并移除。",
    });
  };

  const addReferenceAsset = (input: {
    src: string;
    name: string;
    prompt: string;
    label: string;
    weight: number;
    locked: boolean;
    notes: string;
  }) => {
    const asset = {
      id: makeId("asset"),
      sceneId: "",
      name: input.name,
      kind: "image" as const,
      src: input.src,
      prompt: input.prompt,
      createdAt: nowIso(),
      local: true,
      reference: {
        role,
        entityId,
        label: input.label,
        weight: input.weight,
        locked: input.locked,
        notes: input.notes,
      },
    };
    attachReference(project.id, asset);
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      pushToast({
        type: "error",
        title: "参考图过大",
        message: `上限 2 MB，你选择的是 ${formatBytes(file.size)}。`,
      });
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      addReferenceAsset({
        src: String(reader.result),
        name: file.name,
        prompt: "用户上传的设定参考图",
        label: `${title} · ${file.name}`,
        weight: 0.85,
        locked: true,
        notes: "用户上传",
      });
      setUploading(false);
      pushToast({ type: "success", title: "参考图已加入设定集" });
    };
    reader.onerror = () => {
      setUploading(false);
      pushToast({ type: "error", title: "无法读取该图片" });
    };
    reader.readAsDataURL(file);
  };

  const generateDraft = () => {
    const promptParts =
      selected.kind === "character"
        ? [character?.name, character?.appearance, character?.wardrobe]
        : selected.kind === "location"
          ? [location?.name, location?.environment, location?.lighting]
          : [styleLock.descriptor];
    const prompt = promptParts.filter(Boolean).join("，") || title;
    const palette =
      character?.palette ?? location?.palette ?? styleLock.palette;
    const visual = createVisualDraftSvg(prompt, "SETTING REFERENCE", references.length + 1, {
      seed: seedFromFingerprint(stableHash(`${entityId}:${prompt}:${references.length}`)),
      palette,
      anchorLabel: title,
    });
    addReferenceAsset({
      src: visual.src,
      name: `${title} · 参考草案 ${String(references.length + 1).padStart(2, "0")}`,
      prompt,
      label: `${title} · 参考草案`,
      weight: 0.6,
      locked: false,
      notes: "本地矢量草案：可替换为真实生成或上传的定妆图",
    });
    pushToast({
      type: "success",
      title: "已生成可编辑的参考草案",
      message: "草案会参与锚点指纹；替换为真实参考图后需要重新生成镜头画面。",
    });
  };

  const applyToAllScenes = () => {
    project.scenes.forEach((scene) => {
      if (selected.kind === "character") {
        const ids = scene.characterIds ?? [];
        if (!ids.includes(selected.id)) {
          setSceneAnchors(project.id, scene.id, {
            characterIds: [...ids, selected.id],
          });
        }
      } else if (selected.kind === "location") {
        setSceneAnchors(project.id, scene.id, { locationId: selected.id });
      }
    });
    pushToast({
      type: "success",
      title: "已把当前设定应用到全部镜头",
      message: "已有素材会因为锚点变化被标记为过期。",
    });
  };

  const toggleCharacterInScene = (sceneId: string, id: string) => {
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const ids = scene.characterIds ?? [];
    setSceneAnchors(project.id, sceneId, {
      characterIds: ids.includes(id)
        ? ids.filter((item) => item !== id)
        : [...ids, id],
    });
  };

  const copyDirective = async () => {
    if (!previewScene) return;
    const anchors = resolveSceneAnchors(project, previewScene);
    try {
      await navigator.clipboard.writeText(anchors.directive || "当前没有锚点指令");
      pushToast({ type: "success", title: "锚点指令已复制" });
    } catch {
      pushToast({ type: "error", title: "剪贴板不可用" });
    }
  };

  return (
    <div className="canon-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        title="先定义角色与场景，再让每一帧都认识它们"
        description="角色、环境与风格各有一张设定卡：外观锚点、调色板、参考图和固定种子会一起组成统一指纹，并在每次生成时复用。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<ImageIcon size={15} />}
              onClick={() => navigate(`/projects/${project.id}/assets`)}
            >
              去生成素材
            </Button>
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() =>
                navigate(`/projects/${project.id}/storyboard`)
              }
            >
              回到分镜
            </Button>
          </>
        }
      />

      <section className="canon-score" aria-label="一致性覆盖报告">
        <div className="canon-score__main">
          <span className="eyebrow">CONSISTENCY COVERAGE</span>
          <strong>{report.score}%</strong>
          <p>
            结构一致性评分：{report.consistent}/{report.scenes} 个镜头与当前指纹一致，
            {report.stale} 个过期、{report.unanchored} 个未绑定锚点。这是锚点覆盖率判定，不是图像相似度。
          </p>
          <Progress value={report.score} />
        </div>
        <div className="canon-score__stats">
          <div>
            <span>已绑定锚点</span>
            <strong>
              {report.anchored}/{report.scenes}
            </strong>
          </div>
          <div>
            <span>与设定一致</span>
            <strong>{report.consistent}</strong>
          </div>
          <div>
            <span>需要重生成</span>
            <strong>{report.stale}</strong>
          </div>
          <div>
            <span>参考图</span>
            <strong>{report.referenceImages}</strong>
          </div>
        </div>
      </section>

      <div className="canon-layout">
        <section className="canon-entities">
          <header>
            <div>
              <span className="eyebrow">CAST</span>
              <h2>角色 · {project.characters.length}</h2>
            </div>
            <IconButton
              label="新增角色"
              onClick={() => createEntity("character")}
            >
              <Plus size={16} />
            </IconButton>
          </header>
          <div className="canon-entity-list">
            {project.characters.length ? (
              project.characters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`canon-entity ${
                    selected.kind === "character" && selected.id === item.id
                      ? "is-selected"
                      : ""
                  }`}
                  onClick={() => setSelection({ kind: "character", id: item.id })}
                >
                  <span className="canon-entity__icon">
                    <UserRound size={15} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.role || "未设角色"} · {item.referenceAssetIds.length} 张参考
                    </small>
                  </span>
                  {item.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              ))
            ) : (
              <p className="canon-hint">还没有角色。先建一个反复出场的讲解者或主角。</p>
            )}
          </div>

          <header>
            <div>
              <span className="eyebrow">LOCATIONS</span>
              <h2>场景 · {project.locations.length}</h2>
            </div>
            <IconButton
              label="新增场景"
              onClick={() => createEntity("location")}
            >
              <Plus size={16} />
            </IconButton>
          </header>
          <div className="canon-entity-list">
            {project.locations.length ? (
              project.locations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`canon-entity ${
                    selected.kind === "location" && selected.id === item.id
                      ? "is-selected"
                      : ""
                  }`}
                  onClick={() => setSelection({ kind: "location", id: item.id })}
                >
                  <span className="canon-entity__icon">
                    <MapPin size={15} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.timeOfDay || "未设时间"} · {item.referenceAssetIds.length} 张参考
                    </small>
                  </span>
                  {item.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              ))
            ) : (
              <p className="canon-hint">场景锚点可以固定光线、时段和环境布局。</p>
            )}
          </div>

          <button
            type="button"
            className={`canon-style-card ${
              selected.kind === "style" ? "is-selected" : ""
            }`}
            onClick={() => setSelection({ kind: "style", id: STYLE_LOCK_ENTITY_ID })}
          >
            <span className="canon-entity__icon">
              <BookOpen size={15} />
            </span>
            <span>
              <strong>全局风格锁定</strong>
              <small>
                {styleLock.enabled ? "已启用" : "未启用"} ·{" "}
                {styleLock.referenceAssetIds.length} 张参考
              </small>
            </span>
            <Pill tone={styleLock.enabled ? "accent" : "neutral"}>
              {styleLock.enabled ? "ON" : "OFF"}
            </Pill>
          </button>
        </section>

        <section className="canon-editor">
          <header className="canon-editor__head">
            <div>
              <span className="eyebrow">
                {selected.kind === "character"
                  ? "CHARACTER CARD"
                  : selected.kind === "location"
                    ? "LOCATION CARD"
                    : "STYLE LOCK"}
              </span>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            <div className="canon-editor__actions">
              {selected.kind !== "style" && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Users size={14} />}
                  onClick={applyToAllScenes}
                >
                  应用到全部镜头
                </Button>
              )}
              {selected.kind !== "style" && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    (character?.locked ?? location?.locked) ? (
                      <Lock size={14} />
                    ) : (
                      <LockOpen size={14} />
                    )
                  }
                  onClick={() =>
                    character
                      ? patchCharacter({ locked: !character.locked })
                      : patchLocation({ locked: !location?.locked })
                  }
                >
                  {(character?.locked ?? location?.locked) ? "已锁定" : "锁定锚点"}
                </Button>
              )}
              {selected.kind !== "style" && (
                <IconButton
                  label="删除设定卡"
                  onClick={() => setPendingDelete(selected)}
                >
                  <Trash2 size={15} />
                </IconButton>
              )}
            </div>
          </header>

          {selected.kind === "character" && character && (
            <div className="canon-fields">
              <div className="canon-fields__row">
                <Field label="角色名">
                  <TextInput
                    value={character.name}
                    onChange={(event) =>
                      patchCharacter({ name: event.target.value })
                    }
                  />
                </Field>
                <Field label="叙事角色">
                  <TextInput
                    value={character.role}
                    placeholder="解说者 / 主角 / 历史人物"
                    onChange={(event) =>
                      patchCharacter({ role: event.target.value })
                    }
                  />
                </Field>
              </div>
              <Field
                label="外观锚点"
                hint="写脸型、发型、年龄、标志性特征；这一段会原样进入每个镜头的提示词。"
              >
                <TextArea
                  rows={4}
                  value={character.appearance}
                  placeholder="短卷发、圆框眼镜、三十岁上下、左眉有一道浅疤"
                  onChange={(event) =>
                    patchCharacter({ appearance: event.target.value })
                  }
                />
              </Field>
              <Field label="服装锚点">
                <TextInput
                  value={character.wardrobe}
                  placeholder="米白色实验服，深色高领毛衣"
                  onChange={(event) =>
                    patchCharacter({ wardrobe: event.target.value })
                  }
                />
              </Field>
              <div className="canon-fields__row">
                <Field label="调色板" hint="逗号分隔的十六进制色值">
                  <TextInput
                    value={paletteToText(character.palette)}
                    placeholder="#c8ff65, #0c3540"
                    onChange={(event) =>
                      patchCharacter({ palette: parsePalette(event.target.value) })
                    }
                  />
                </Field>
                <Field label="固定种子" hint="留空则按指纹自动派生">
                  <TextInput
                    value={character.seed ?? ""}
                    inputMode="numeric"
                    placeholder="auto"
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      patchCharacter({
                        seed: value ? Number(value) || undefined : undefined,
                      });
                    }}
                  />
                </Field>
              </div>
              <Field label="负向提示词">
                <TextInput
                  value={character.negative}
                  placeholder="换发型，换眼镜，写实照片"
                  onChange={(event) =>
                    patchCharacter({ negative: event.target.value })
                  }
                />
              </Field>
            </div>
          )}

          {selected.kind === "location" && location && (
            <div className="canon-fields">
              <div className="canon-fields__row">
                <Field label="场景名">
                  <TextInput
                    value={location.name}
                    onChange={(event) =>
                      patchLocation({ name: event.target.value })
                    }
                  />
                </Field>
                <Field label="时段">
                  <TextInput
                    value={location.timeOfDay}
                    placeholder="深夜 / 清晨 / 黄昏"
                    onChange={(event) =>
                      patchLocation({ timeOfDay: event.target.value })
                    }
                  />
                </Field>
              </div>
              <Field
                label="环境锚点"
                hint="建筑结构、关键道具、材质与空间关系。"
              >
                <TextArea
                  rows={4}
                  value={location.environment}
                  placeholder="圆顶观测室，黄铜望远镜，木质星图柜，地面散落手绘星图"
                  onChange={(event) =>
                    patchLocation({ environment: event.target.value })
                  }
                />
              </Field>
              <Field label="光线锚点">
                <TextInput
                  value={location.lighting}
                  placeholder="冷蓝月光与暖色台灯混合，低照度"
                  onChange={(event) =>
                    patchLocation({ lighting: event.target.value })
                  }
                />
              </Field>
              <div className="canon-fields__row">
                <Field label="调色板" hint="逗号分隔的十六进制色值">
                  <TextInput
                    value={paletteToText(location.palette)}
                    placeholder="#0c3540, #79a9ff"
                    onChange={(event) =>
                      patchLocation({ palette: parsePalette(event.target.value) })
                    }
                  />
                </Field>
                <Field label="固定种子" hint="留空则按指纹自动派生">
                  <TextInput
                    value={location.seed ?? ""}
                    inputMode="numeric"
                    placeholder="auto"
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      patchLocation({
                        seed: value ? Number(value) || undefined : undefined,
                      });
                    }}
                  />
                </Field>
              </div>
              <Field label="负向提示词">
                <TextInput
                  value={location.negative}
                  placeholder="白天，现代办公室，塑料质感"
                  onChange={(event) =>
                    patchLocation({ negative: event.target.value })
                  }
                />
              </Field>
            </div>
          )}

          {selected.kind === "style" && (
            <div className="canon-fields">
              <button
                type="button"
                className={`canon-switch ${styleLock.enabled ? "is-on" : ""}`}
                onClick={() =>
                  updateStyleLock(project.id, { enabled: !styleLock.enabled })
                }
              >
                <span>{styleLock.enabled ? "风格锁定已启用" : "风格锁定已关闭"}</span>
                <small>
                  启用后，描述、调色板与负向词会写入每个镜头；关闭时只使用项目风格文本。
                </small>
              </button>
              <Field label="风格描述">
                <TextArea
                  rows={4}
                  value={styleLock.descriptor}
                  placeholder="扁平矢量科普动画，明亮蓝天，圆润几何形状，粗体无衬线标题"
                  onChange={(event) =>
                    updateStyleLock(project.id, { descriptor: event.target.value })
                  }
                />
              </Field>
              <Field label="调色板" hint="逗号分隔的十六进制色值">
                <TextInput
                  value={paletteToText(styleLock.palette)}
                  onChange={(event) =>
                    updateStyleLock(project.id, {
                      palette: parsePalette(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="负向提示词">
                <TextArea
                  rows={2}
                  value={styleLock.negative}
                  placeholder="写实照片，恐怖氛围，文字水印"
                  onChange={(event) =>
                    updateStyleLock(project.id, { negative: event.target.value })
                  }
                />
              </Field>
            </div>
          )}

          <div className="canon-references">
            <header>
              <div>
                <span className="eyebrow">REFERENCE LIBRARY</span>
                <h3>
                  参考图 · {references.length}
                  <span className="canon-references__hint">
                    参考图会改变锚点指纹，替换后需重新生成相关镜头
                  </span>
                </h3>
              </div>
              <div className="canon-references__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Sparkles size={14} />}
                  onClick={generateDraft}
                >
                  生成草案
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Upload size={14} />}
                  disabled={uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  上传
                </Button>
              </div>
            </header>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              hidden
              onChange={upload}
            />

            {references.length ? (
              <div className="canon-reference-grid">
                {references.map((asset) => {
                  const meta = asset.reference;
                  if (!meta) return null;
                  return (
                    <article key={asset.id} className="canon-reference">
                      <div className="canon-reference__image">
                        <img src={asset.src} alt={asset.name} />
                        {meta.locked && (
                          <span className="canon-reference__badge">
                            <Lock size={11} /> 强制参考
                          </span>
                        )}
                      </div>
                      <div className="canon-reference__body">
                        <strong>{meta.label}</strong>
                        <small>
                          权重 {meta.weight.toFixed(2)} · {meta.notes || "参考图"}
                        </small>
                        <div className="canon-reference__controls">
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={meta.weight}
                            aria-label={`${meta.label} 参考权重`}
                            onChange={(event) =>
                              updateReferenceAsset(project.id, asset.id, {
                                reference: {
                                  ...meta,
                                  weight: Number(event.target.value),
                                },
                              })
                            }
                          />
                          <IconButton
                            label={meta.locked ? "取消强制参考" : "设为强制参考"}
                            onClick={() =>
                              updateReferenceAsset(project.id, asset.id, {
                                reference: { ...meta, locked: !meta.locked },
                              })
                            }
                          >
                            {meta.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                          </IconButton>
                          <IconButton
                            label="移除参考图"
                            onClick={() => removeReferenceAsset(project.id, asset.id)}
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={<ImageIcon size={22} />}
                title="这张设定卡还没有参考图"
                description="上传定妆图/场景图，或先生成一张可编辑的矢量草案；有参考图后锚点才会进入像素级条件。"
                action={
                  <Button
                    variant="secondary"
                    icon={<Wand2 size={15} />}
                    onClick={generateDraft}
                  >
                    生成参考草案
                  </Button>
                }
              />
            )}
          </div>

          <details className="canon-preview">
            <summary>
              <span className="eyebrow">PROMPT PREVIEW</span>
              查看锚点指令（以首个镜头为例）
              <button
                type="button"
                className="canon-copy"
                onClick={(event) => {
                  event.preventDefault();
                  void copyDirective();
                }}
              >
                <Copy size={13} /> 复制
              </button>
            </summary>
            <pre>{previewAnchors?.directive || "尚未绑定任何锚点。"}</pre>
            <p>
              指纹 <code>{previewAnchors?.fingerprint ?? "—"}</code>
              {" · "}种子 <code>{previewAnchors?.seed ?? "—"}</code>
            </p>
          </details>
        </section>

        <aside className="canon-scenes">
          <header>
            <div>
              <span className="eyebrow">SHOT BINDING</span>
              <h2>镜头绑定</h2>
            </div>
            <Pill tone={report.score >= 80 ? "success" : "warning"}>
              {report.score}%
            </Pill>
          </header>
          <div className="canon-scene-list">
            {report.entries.map(({ scene, index, anchors, evaluation }) => (
              <article key={scene.id} className="canon-scene">
                <header>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{scene.title}</strong>
                  <Pill tone={toneFor(evaluation)}>{shortStatus(evaluation)}</Pill>
                </header>
                <p>{evaluation.detail}</p>
                <div className="canon-scene__chips">
                  {project.characters.length ? (
                    project.characters.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={
                          anchors.characters.some(
                            (characterItem) => characterItem.id === item.id,
                          )
                            ? "is-on"
                            : ""
                        }
                        onClick={() => toggleCharacterInScene(scene.id, item.id)}
                      >
                        {item.name}
                      </button>
                    ))
                  ) : (
                    <small>先在左侧创建角色</small>
                  )}
                </div>
                <select
                  value={scene.locationId ?? ""}
                  aria-label={`${scene.title} 场景锚点`}
                  onChange={(event) =>
                    setSceneAnchors(project.id, scene.id, {
                      locationId: event.target.value,
                    })
                  }
                >
                  <option value="">不绑定场景</option>
                  {project.locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <footer>
                  <span>
                    {anchors.referenceAssetIds.length
                      ? `${anchors.referenceAssetIds.length} 张参考`
                      : "仅文字锚点"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/projects/${project.id}/assets?sceneId=${scene.id}`)
                    }
                  >
                    <BadgeCheck size={13} /> 生成画面
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </aside>
      </div>

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="删除这张设定卡？"
        description="删除会移除它的参考图，并从所有镜头解绑。已经生成的镜头素材会变成普通素材，但不会自动删除。"
        width={480}
      >
        <div className="modal__footer">
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>
            取消
          </Button>
          <Button variant="danger" onClick={confirmDelete}>
            删除设定卡
          </Button>
        </div>
      </Modal>
    </div>
  );
}
