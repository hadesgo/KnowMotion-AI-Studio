import { Fingerprint, ScanFace, ShieldCheck, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Pill, Progress, Select } from "./ui";
import { useStudioStore } from "../store/studio";
import type {
  CharacterLockMode,
  CharacterProfile,
  ControlNetType,
  VideoProject,
} from "../types";
import {
  buildCharacterIdentity,
  characterReferenceAssets,
  verifyProjectIdentities,
} from "../services/identityPipeline";
import { IDENTITY_THRESHOLDS } from "../services/identity";
import {
  channelLabel,
  planConditioning,
  providerConditioningModes,
  resolveCharacterLock,
  strengthFromWeight,
} from "../services/characterLock";

const LOCK_MODES: Array<{ value: CharacterLockMode; label: string }> = [
  { value: "ip-adapter", label: "IP-Adapter 参考注入" },
  { value: "controlnet", label: "ControlNet 结构条件" },
  { value: "img2img-reference", label: "img2img 参考重绘" },
  { value: "prompt", label: "仅提示词锚点" },
];

const CONTROL_TYPES: Array<{ value: ControlNetType; label: string }> = [
  { value: "reference", label: "参考图通道" },
  { value: "pose", label: "姿势 Pose" },
  { value: "depth", label: "深度 Depth" },
  { value: "canny", label: "边缘 Canny" },
  { value: "lineart", label: "线稿 Lineart" },
];

const VERDICT_LABEL: Record<string, string> = {
  pass: "通过",
  warn: "可疑",
  fail: "不一致",
};

function verdictTone(verdict: string): "success" | "warning" | "danger" {
  return verdict === "pass" ? "success" : verdict === "warn" ? "warning" : "danger";
}

/**
 * 角色身份面板：把「参考图 → 身份质心 → 逐镜头像素验证」这条链路
 * 和「角色锁协商」放在同一张卡里，避免用户以为改了权重就已经锁住了脸。
 */
export function IdentityPanel({
  project,
  character,
}: {
  project: VideoProject;
  character: CharacterProfile;
}) {
  const setCharacterIdentity = useStudioStore((state) => state.setCharacterIdentity);
  const updateCharacterLock = useStudioStore((state) => state.updateCharacterLock);
  const setAssetIdentity = useStudioStore((state) => state.setAssetIdentity);
  const pushToast = useStudioStore((state) => state.pushToast);
  const providers = useStudioStore((state) => state.providers);

  const [busy, setBusy] = useState<"build" | "verify" | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const references = characterReferenceAssets(project, character);
  const lock = resolveCharacterLock(character);
  const identity = character.identity;

  const imageProvider = providers.find(
    (provider) => provider.enabled && provider.capabilities.includes("Image"),
  );
  const scene = project.scenes.find((item) =>
    (item.characterIds ?? []).includes(character.id),
  );
  const plan = useMemo(
    () => (imageProvider && scene ? planConditioning(project, scene, imageProvider) : null),
    [project, scene, imageProvider],
  );

  const results = useMemo(
    () =>
      project.scenes
        .map((item) => {
          const asset = item.assetId
            ? project.assets.find((candidate) => candidate.id === item.assetId)
            : undefined;
          const verification = asset?.identity;
          return verification && verification.characterId === character.id
            ? { scene: item, asset, verification }
            : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [project, character.id],
  );

  const supported = imageProvider ? providerConditioningModes(imageProvider) : [];

  const rebuild = async () => {
    setBusy("build");
    setNotes([]);
    try {
      const { profile, errors } = await buildCharacterIdentity(project, character);
      setNotes(errors);
      if (!profile) {
        pushToast({
          type: "error",
          title: "无法建立身份指纹",
          message: errors[0] ?? "参考图像素读取失败",
        });
        return;
      }
      setCharacterIdentity(project.id, character.id, profile);
      pushToast({
        type: "success",
        title: `「${character.name}」身份指纹已建立`,
        message: `${profile.sampleAssetIds.length} 张参考图合成质心 · 参考一致度 ${Math.round(
          profile.consensus * 100,
        )}%`,
      });
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy("verify");
    setNotes([]);
    try {
      const { results: verified, errors, checked } = await verifyProjectIdentities(
        project,
      );
      verified.forEach((entry) =>
        setAssetIdentity(project.id, entry.assetId, entry.verification),
      );
      setNotes(errors);
      const failed = verified.filter((entry) => entry.verification.verdict === "fail").length;
      pushToast({
        type: checked ? "success" : "error",
        title: checked ? `已验证 ${checked} 个镜头素材` : "没有可验证的镜头素材",
        message: checked
          ? `${verified.length - failed} 个接近设定，${failed} 个像素级不一致${
              errors.length ? ` · ${errors.length} 项被跳过` : ""
            }`
          : errors[0] ?? "先为出场角色建立身份指纹，并生成镜头画面。",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="canon-identity">
      <header>
        <div>
          <span className="eyebrow">IDENTITY LOCK</span>
          <h3>
            <Fingerprint size={15} /> 像素级身份验证与角色锁
          </h3>
        </div>
        <Pill tone={identity ? "success" : "neutral"}>
          {identity ? `样本 ${identity.signature.sampleCount}` : "未建立指纹"}
        </Pill>
      </header>

      <p className="canon-identity__hint">
        参考图会在本机画成 64×64 工作网格，抽取梯度结构、亮度、颜色直方图与感知哈希，
        并单独估计人脸区域。判定是像素相似度，不是人脸识别置信度；图像不会上传。
      </p>

      <div className="canon-identity__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<ScanFace size={14} />}
          disabled={busy !== null || !references.length}
          onClick={() => void rebuild()}
        >
          {identity ? "重建身份指纹" : "建立身份指纹"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<ShieldCheck size={14} />}
          disabled={busy !== null}
          onClick={() => void verify()}
        >
          验证全部镜头
        </Button>
      </div>

      {identity ? (
        <div className="canon-identity__stats">
          <div>
            <span>参考样本</span>
            <strong>{identity.sampleAssetIds.length}</strong>
          </div>
          <div>
            <span>参考一致度</span>
            <strong>{Math.round(identity.consensus * 100)}%</strong>
          </div>
          <div>
            <span>已验证镜头</span>
            <strong>{results.length}</strong>
          </div>
          <div>
            <span>阈值</span>
            <strong>
              {IDENTITY_THRESHOLDS.pass.toFixed(2)} / {IDENTITY_THRESHOLDS.warn.toFixed(2)}
            </strong>
          </div>
        </div>
      ) : (
        <p className="canon-identity__hint canon-identity__hint--warn">
          {references.length
            ? "还没有身份指纹。建立后，每个采用素材都会和这个角色的参考质心做像素比对。"
            : "先上传至少一张定妆参考图，才能建立身份指纹。"}
        </p>
      )}

      <div className="canon-identity__lock">
        <div className="canon-identity__lock-head">
          <strong>角色锁通道</strong>
          <span>
            {plan ? channelLabel(plan.channel) : "未找到 Image Provider"}
            {plan && plan.channel !== "prompt"
              ? ` · 强度 ${plan.strength.toFixed(2)}`
              : ""}
          </span>
        </div>
        <div className="canon-identity__grid">
          <label>
            <span>锁定方式</span>
            <Select
              value={lock.mode}
              onChange={(event) =>
                updateCharacterLock(project.id, character.id, {
                  mode: event.target.value as CharacterLockMode,
                })
              }
            >
              {LOCK_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                  {supported.length && !supported.includes(mode.value) ? "（会降级）" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span>控制图类型</span>
            <Select
              value={lock.controlType}
              disabled={lock.mode !== "controlnet"}
              onChange={(event) =>
                updateCharacterLock(project.id, character.id, {
                  controlType: event.target.value as ControlNetType,
                })
              }
            >
              {CONTROL_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span>主参考图</span>
            <Select
              value={lock.sourceAssetId ?? ""}
              onChange={(event) =>
                updateCharacterLock(project.id, character.id, {
                  sourceAssetId: event.target.value || undefined,
                })
              }
            >
              <option value="">自动选择最高权重</option>
              {references.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.reference?.label ?? asset.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="canon-identity__weight">
          <span>
            锁定权重 <strong>{lock.weight.toFixed(2)}</strong>
            <small>img2img 强度 {strengthFromWeight(lock.weight).toFixed(2)}</small>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={lock.weight}
            onChange={(event) =>
              updateCharacterLock(project.id, character.id, {
                weight: Number(event.target.value),
              })
            }
          />
        </label>
        <button
          type="button"
          className={`canon-switch ${lock.enabled ? "is-on" : ""}`}
          onClick={() =>
            updateCharacterLock(project.id, character.id, { enabled: !lock.enabled })
          }
        >
          <span>{lock.enabled ? "角色锁已启用" : "角色锁已关闭"}</span>
          <small>
            关闭后参考图只进入提示词与设定指纹，不再影响采样。
          </small>
        </button>
        {plan?.degradations.map((reason) => (
          <p key={reason} className="canon-identity__note">
            <ShieldAlert size={13} /> {reason}
          </p>
        ))}
        {plan?.warnings.map((warning) => (
          <p key={warning} className="canon-identity__note">
            <ShieldAlert size={13} /> {warning}
          </p>
        ))}
      </div>

      {results.length ? (
        <ul className="canon-identity__results">
          {results.map(({ scene: item, verification }) => (
            <li key={item.id}>
              <header>
                <strong>{item.title}</strong>
                <Pill tone={verdictTone(verification.verdict)}>
                  {VERDICT_LABEL[verification.verdict] ?? verification.verdict}
                </Pill>
              </header>
              <Progress value={Math.round(verification.score * 100)} />
              <small>
                {Math.round(verification.score * 100)}% · 结构{" "}
                {verification.components.structure.toFixed(2)} · 颜色{" "}
                {verification.components.color.toFixed(2)} · 人脸{" "}
                {verification.components.face.toFixed(2)}
                {verification.faceDetected ? "" : "（未检出人脸，按中心区域比较）"}
              </small>
            </li>
          ))}
        </ul>
      ) : null}

      {notes.length ? (
        <ul className="canon-identity__notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
