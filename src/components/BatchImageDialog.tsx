import {
  Ban,
  Check,
  CircleSlash,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ImageJob,
  ProviderProfile,
  VideoProject,
} from "../types";
import type { ImageGenerationRequestInput } from "../services/capabilities";
import { buildAnchoredImageRequest } from "../services/imageRequests";
import { resolveSceneAnchors } from "../services/consistency";
import { useStudioStore } from "../store/studio";
import { Button, Modal, Pill, Segmented } from "./ui";
import "./BatchImageDialog.css";

const statusLabels: Record<ImageJob["status"], string> = {
  pending: "等待中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断",
};

function statusTone(status: ImageJob["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running") return "info" as const;
  if (status === "pending") return "warning" as const;
  return "neutral" as const;
}

export function BatchImageDialog({
  open,
  onClose,
  project,
  provider,
  style,
  size,
  useAnchors,
  jobs,
  onEnqueue,
  onCancelJob,
  onRetryJob,
  onClearFinished,
}: {
  open: boolean;
  onClose: () => void;
  project: VideoProject;
  provider?: ProviderProfile;
  style: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  useAnchors: boolean;
  jobs: ImageJob[];
  onEnqueue: (requests: ImageGenerationRequestInput[]) => Promise<unknown>;
  onCancelJob: (jobId: string) => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onClearFinished: () => Promise<void>;
}) {
  const pushToast = useStudioStore((state) => state.pushToast);
  const [selected, setSelected] = useState<string[]>(() => {
    const pending = project.scenes
      .filter((scene) => !scene.assetId)
      .map((scene) => scene.id);
    return pending.length ? pending : project.scenes.map((scene) => scene.id);
  });
  const [count, setCount] = useState(1);
  const [anchorsEnabled, setAnchorsEnabled] = useState(useAnchors);
  const [submitting, setSubmitting] = useState(false);

  const selectedScenes = useMemo(
    () => project.scenes.filter((scene) => selected.includes(scene.id)),
    [project.scenes, selected],
  );
  const activeJobs = jobs.filter(
    (job) => job.status === "pending" || job.status === "running",
  );
  const finishedJobs = jobs.filter(
    (job) => !["pending", "running"].includes(job.status),
  );
  const plannedJobs = selectedScenes.length * count;

  const toggleScene = (sceneId: string) => {
    setSelected((current) =>
      current.includes(sceneId)
        ? current.filter((id) => id !== sceneId)
        : [...current, sceneId],
    );
  };

  const submit = async () => {
    if (!provider) {
      pushToast({ type: "error", title: "先配置一个 Image Provider" });
      return;
    }
    if (!selectedScenes.length) {
      pushToast({ type: "error", title: "至少选择一个镜头" });
      return;
    }
    setSubmitting(true);
    try {
      const requests = selectedScenes.map((scene) =>
        buildAnchoredImageRequest({
          project,
          scene,
          provider,
          style,
          size,
          count,
          useAnchors: anchorsEnabled,
        }),
      );
      await onEnqueue(requests);
      pushToast({
        type: "success",
        title: `已加入队列：${requests.length} 个镜头任务`,
        message: `${provider.name} · 每镜头 ${count} 张 · 最多同时生成 2 个任务`,
      });
    } catch (error) {
      pushToast({
        type: "error",
        title: "加入队列失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="批量生成队列"
      description="按镜头批量入队，队列会在后台按并发限制执行；关闭对话框或切换页面都不会中断任务。"
      width={980}
    >
      <div className="batch-dialog">
        <section className="batch-scenes">
          <header>
            <div>
              <span className="eyebrow">SHOT SELECTION</span>
              <h3>
                镜头选择
                <small>
                  {selected.length}/{project.scenes.length}
                </small>
              </h3>
            </div>
            <div className="batch-scenes__actions">
              <Button
                variant="ghost"
                size="sm"
                icon={<ListChecks size={14} />}
                onClick={() =>
                  setSelected(project.scenes.map((scene) => scene.id))
                }
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected([])}
              >
                清空
              </Button>
            </div>
          </header>

          <div className="batch-scene-list">
            {project.scenes.map((scene, index) => {
              const anchors = resolveSceneAnchors(project, scene);
              const checked = selected.includes(scene.id);
              return (
                <label
                  key={scene.id}
                  className={`batch-scene ${checked ? "is-checked" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleScene(scene.id)}
                  />
                  <span className="batch-scene__index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="batch-scene__body">
                    <strong>{scene.title}</strong>
                    <small>{scene.visualPrompt}</small>
                  </span>
                  <span className="batch-scene__meta">
                    {scene.assetId ? (
                      <Pill tone="success">已有素材</Pill>
                    ) : (
                      <Pill tone="neutral">未生成</Pill>
                    )}
                    <Pill tone={anchors.referenceAssetIds.length ? "accent" : "neutral"}>
                      {anchors.characters.length + (anchors.location ? 1 : 0)} 锚点 ·{" "}
                      {anchors.referenceAssetIds.length} 参考
                    </Pill>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="batch-settings">
            <div className="batch-setting-row">
              <span>每个镜头生成数量</span>
              <Segmented
                value={String(count)}
                onChange={(value) => setCount(Number(value))}
                label="批量生成数量"
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "4", label: "4" },
                ]}
              />
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={anchorsEnabled}
              className={`batch-anchor-switch ${anchorsEnabled ? "is-on" : ""}`}
              onClick={() => setAnchorsEnabled((value) => !value)}
            >
              {anchorsEnabled ? "使用设定集锚点" : "忽略锚点，仅用镜头提示词"}
              <small>
                锚点会带上角色/场景描述、参考图、负向词与固定种子。
              </small>
            </button>
            <p className="batch-summary">
              <Sparkles size={14} />
              {plannedJobs
                ? `将创建 ${selectedScenes.length} 个任务，共 ${plannedJobs} 张图片。`
                : "尚未选择镜头。"}
            </p>
          </div>
        </section>

        <section className="batch-queue">
          <header>
            <div>
              <span className="eyebrow">QUEUE</span>
              <h3>
                队列
                <small>
                  {activeJobs.length} 进行中 · {finishedJobs.length} 已结束
                </small>
              </h3>
            </div>
            {finishedJobs.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => void onClearFinished()}
              >
                清理已结束
              </Button>
            )}
          </header>

          <div className="batch-job-list">
            {jobs.length ? (
              jobs.map((job) => (
                <article key={job.id} className="batch-job">
                  <header>
                    <Pill tone={statusTone(job.status)} dot={job.status === "running"}>
                      {statusLabels[job.status]}
                    </Pill>
                    <strong>
                      {project.scenes.find((scene) => scene.id === job.sceneId)?.title ??
                        job.sceneId}
                    </strong>
                    <small>{job.count} 张</small>
                  </header>
                  <p>{job.promptExcerpt}</p>
                  <div className="batch-job__meta">
                    <span>{job.providerName}</span>
                    {job.anchorLabel && <span>{job.anchorLabel}</span>}
                    <span>
                      尝试 {job.attempt}/{job.maxAttempts}
                    </span>
                  </div>
                  {job.error && (
                    <p className="batch-job__error">{job.error}</p>
                  )}
                  {job.assets.length > 0 && (
                    <div className="batch-job__assets">
                      {job.assets.map((asset) => (
                        <img key={asset.id} src={asset.src} alt={asset.name} />
                      ))}
                    </div>
                  )}
                  <div className="batch-job__actions">
                    {job.status === "running" || job.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Ban size={13} />}
                        onClick={() => void onCancelJob(job.id)}
                      >
                        取消
                      </Button>
                    ) : ["failed", "canceled", "interrupted"].includes(
                        job.status,
                      ) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<RefreshCw size={13} />}
                        onClick={() => void onRetryJob(job.id)}
                      >
                        重试
                      </Button>
                    ) : (
                      <span className="batch-job__done">
                        <Check size={13} /> 已写入素材库
                      </span>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="batch-job-empty">
                <CircleSlash size={20} />
                <p>队列为空。选择镜头后加入队列，任务会在这里实时更新。</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="modal__footer">
        <Button variant="secondary" icon={<X size={15} />} onClick={onClose}>
          关闭
        </Button>
        <Button
          variant="primary"
          icon={
            submitting ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )
          }
          disabled={submitting || !selectedScenes.length || !provider}
          onClick={() => void submit()}
        >
          {submitting ? "正在入队…" : `加入队列 · ${plannedJobs} 张`}
        </Button>
      </div>
    </Modal>
  );
}
