import {
  ArrowRight,
  AudioLines,
  Check,
  Circle,
  Clapperboard,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import { Button, Pill, Progress } from "../components/ui";
import { buildProjectComposition, validateComposition } from "../remotion/schema";
import {
  generateCloudNarration,
} from "../services/capabilities";
import {
  applyNarrationAssets,
  automaticImageRequests,
  defaultAgentRoutes,
  waitForAutomaticImages,
  waitForWorkflowRun,
} from "../services/autoProduction";
import {
  getWorkflow,
  getWorkflowDefinition,
  pauseWorkflow,
  resumeWorkflow,
  startWorkflow,
  type WorkflowRun,
} from "../services/agentWorkflow";
import { flushDesktopStorage, isTauriDesktop } from "../services/desktop";
import { generateNarrationAudio } from "../services/media";
import {
  cancelRemotionRender,
  listenRenderProgress,
  startRemotionRender,
  waitForRender,
} from "../services/remotion";
import { useStudioStore } from "../store/studio";
import type {
  Asset,
  AutoProductionStage,
  AutoProductionState,
  ProviderCapability,
  ProviderProfile,
  VideoProject,
} from "../types";
import { formatBytes, makeId, nowIso } from "../utils";
import "./AutoStudio.css";

type StageStatus = "waiting" | "running" | "done" | "warning" | "failed";

const stages: Array<{
  key: AutoProductionStage | "input";
  title: string;
  detail: string;
  icon: typeof Sparkles;
}> = [
  { key: "input", title: "理解要求", detail: "主题、时长、画幅与受众", icon: WandSparkles },
  { key: "planning", title: "策划与分镜", detail: "研究、叙事、脚本和视觉方向", icon: FileText },
  { key: "media", title: "制作画面与声音", detail: "图层、素材、旁白和字幕", icon: AudioLines },
  { key: "quality", title: "质量门禁", detail: "结构、内容与可渲染性检查", icon: ShieldCheck },
  { key: "render", title: "渲染成片", detail: "Remotion + H.264 MP4", icon: Film },
  { key: "done", title: "交付完成", detail: "可以从这里审片或继续精修", icon: Check },
];

interface AutoState {
  phase: "ready" | "running" | "completed" | "failed" | "paused";
  stage: AutoProductionStage | "input";
  error: string;
  warnings: string[];
  renderProgress: number;
  imageProgress: { completed: number; total: number };
  outputPath: string;
  outputBytes: number;
}

const initialState: AutoState = {
  phase: "ready",
  stage: "input",
  error: "",
  warnings: [],
  renderProgress: 0,
  imageProgress: { completed: 0, total: 0 },
  outputPath: "",
  outputBytes: 0,
};

function stageIndex(stage: AutoProductionStage | "input") {
  return stages.findIndex((item) => item.key === stage);
}

function pickProvider(
  providers: ProviderProfile[],
  capability: ProviderCapability,
  preferredId?: string,
) {
  return (
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.id === preferredId &&
        provider.capabilities.includes(capability),
    ) ??
    providers.find(
      (provider) =>
        provider.enabled && provider.capabilities.includes(capability),
    )
  );
}

export default function AutoStudio() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [state, setState] = useState<AutoState>(() =>
    project?.automation?.status === "completed" &&
    project.automation.outputPath
      ? {
          ...initialState,
          phase: "completed",
          stage: "done",
          outputPath: project.automation.outputPath,
          warnings: project.automation.warnings ?? [],
        }
      : initialState,
  );
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [activeRenderJobId, setActiveRenderJobId] = useState("");
  const startedRef = useRef(false);
  const activeRef = useRef(false);
  const stopRef = useRef(false);
  const runIdRef = useRef("");
  const projectId = project?.id;

  const patchState = (patch: Partial<AutoState>) =>
    setState((current) => ({ ...current, ...patch }));

  const setAutomation = (
    id: string,
    status: AutoProductionState["status"],
    stage: AutoProductionStage,
    patch: Partial<AutoProductionState> = {},
  ) => {
    const currentProject = useStudioStore
      .getState()
      .projects.find((item) => item.id === id);
    const previous = currentProject?.automation;
    updateProject(id, (current) => ({
      ...current,
      automation: {
        ...previous,
        ...patch,
        status,
        stage,
        warnings: patch.warnings ?? previous?.warnings ?? [],
        startedAt: previous?.startedAt ?? nowIso(),
        updatedAt: nowIso(),
      },
    }));
  };

  const applyRunProject = (id: string, nextRun: WorkflowRun) => {
    if (!nextRun.project) return;
    updateProject(id, () => ({
      ...(nextRun.project as VideoProject),
      id,
      automation: useStudioStore
        .getState()
        .projects.find((item) => item.id === id)?.automation,
    }));
  };

  const fail = (id: string, message: string) => {
    if (stopRef.current) {
      setAutomation(id, "paused", state.stage === "input" ? "queued" : state.stage);
      patchState({ phase: "paused", error: "" });
      return;
    }
    setAutomation(id, "failed", state.stage === "input" ? "queued" : state.stage, {
      error: message,
    });
    patchState({ phase: "failed", error: message });
  };

  const runPipeline = async (startMode = false) => {
    if (!projectId || activeRef.current) return;
    const store = useStudioStore.getState();
    const initialProject =
      store.projects.find((item) => item.id === projectId) ?? project;
    if (!initialProject) return;
    if (!isTauriDesktop) {
      patchState({
        phase: "failed",
        error: "自动成片需要在 Tauri 桌面版运行；当前浏览器预览只能保存项目。",
      });
      return;
    }
    const llmProvider = pickProvider(
      store.providers,
      "LLM",
      store.taskRoutes.LLM,
    ) ??
      store.providers.find(
        (provider) =>
          provider.enabled && provider.capabilities.includes("LLM"),
      );
    if (!llmProvider) {
      patchState({
        phase: "failed",
        error: "还没有可用的 LLM 模型。请先在 AI 模型页配置并测试一个模型服务。",
      });
      return;
    }

    activeRef.current = true;
    stopRef.current = false;
    patchState({
      ...initialState,
      phase: "running",
      stage: "planning",
      warnings: initialProject.automation?.warnings ?? [],
    });
    let renderUnlisten: (() => void) | undefined;

    try {
      let nextRun: WorkflowRun | null = null;
      if (initialProject.automation?.runId) {
        nextRun = await getWorkflow(initialProject.automation.runId).catch(
          () => null,
        );
        if (nextRun && ["paused", "waiting_approval"].includes(nextRun.status)) {
          nextRun = await resumeWorkflow(nextRun.id);
        }
      }

      if (!nextRun || startMode) {
        const definition = await getWorkflowDefinition();
        const routes = defaultAgentRoutes(
          definition,
          store.providers,
          store.taskRoutes.LLM,
        );
        nextRun = await startWorkflow(initialProject, store.providers, routes, {
          instruction:
            initialProject.settings.brief ?? initialProject.settings.topic,
          maxAttempts: 3,
          autoMode: true,
        });
      }

      runIdRef.current = nextRun.id;
      setRun(nextRun);
      setAutomation(projectId, "running", "planning", {
        runId: nextRun.id,
        renderJobId: undefined,
        outputPath: undefined,
        error: undefined,
        warnings: initialProject.automation?.warnings ?? [],
      });
      applyRunProject(projectId, nextRun);

      const completedRun =
        nextRun.status === "completed"
          ? nextRun
          : await waitForWorkflowRun(nextRun.id, (update) => {
              setRun(update);
              applyRunProject(projectId, update);
            });
      setRun(completedRun);
      if (stopRef.current) {
        await pauseWorkflow(completedRun.id).catch(() => undefined);
        patchState({ phase: "paused" });
        setAutomation(projectId, "paused", "planning");
        return;
      }
      if (completedRun.status !== "completed") {
        throw new Error(
          completedRun.error ??
            `Agent 工作流以 ${completedRun.status} 状态停止。`,
        );
      }

      applyRunProject(projectId, completedRun);
      const workflowProject =
        useStudioStore
          .getState()
          .projects.find((item) => item.id === projectId) ??
        (completedRun.project as VideoProject);
      if (!workflowProject?.scenes?.length) {
        throw new Error("Agent 没有生成可用的场景内容。");
      }

      patchState({ stage: "media" });
      setAutomation(projectId, "running", "media", {
        runId: completedRun.id,
        warnings: [...(workflowProject.automation?.warnings ?? [])],
      });
      let workingProject = workflowProject;
      const warnings: string[] = [...state.warnings];

      try {
        const ttsProvider = pickProvider(
          store.providers,
          "TTS",
          store.taskRoutes.TTS,
        );
        let generated: Asset[];
        if (ttsProvider) {
          try {
            generated = (
              await generateCloudNarration({
                projectId,
                provider: ttsProvider,
                scenes: workingProject.scenes.map((scene) => ({
                  id: scene.id,
                  title: scene.title,
                  narration: scene.narration,
                })),
                voice: workingProject.audio.voice,
                rate: workingProject.audio.rate,
              })
            ).assets;
          } catch (cloudError) {
            warnings.push(
              `配置的 TTS 服务失败，已切换到本机语音：${
                cloudError instanceof Error
                  ? cloudError.message
                  : String(cloudError)
              }`,
            );
            generated = await generateNarrationAudio(
              projectId,
              workingProject.scenes,
              workingProject.audio.voice,
              workingProject.audio.rate,
            );
          }
        } else {
          generated = await generateNarrationAudio(
            projectId,
            workingProject.scenes,
            workingProject.audio.voice,
            workingProject.audio.rate,
          );
        }
        if (!generated.length) {
          warnings.push("没有生成旁白音频，成片将只保留字幕。");
        } else {
          workingProject = applyNarrationAssets(workingProject, generated);
          updateProject(projectId, () => workingProject);
          patchState({ warnings });
        }
      } catch (error) {
        warnings.push(
          `旁白生成失败，继续渲染静音版本：${error instanceof Error ? error.message : String(error)}`,
        );
        patchState({ warnings });
      }
      if (stopRef.current) {
        setAutomation(projectId, "paused", "media", { runId: completedRun.id });
        patchState({ phase: "paused" });
        return;
      }

      const imageProvider = pickProvider(
        store.providers,
        "Image",
        store.taskRoutes.Image,
      );
      if (imageProvider) {
        patchState({ imageProgress: { completed: 0, total: 0 } });
        const requests = automaticImageRequests(
          workingProject,
          imageProvider,
          workingProject.settings.brief ?? workingProject.settings.topic,
        );
        if (requests.length) {
          patchState({
            imageProgress: { completed: 0, total: requests.length },
          });
          await flushDesktopStorage();
          const produced = await waitForAutomaticImages(
            workingProject,
            requests,
            (completed, total) =>
              patchState({ imageProgress: { completed, total } }),
          );
          workingProject = produced.project;
          warnings.push(...produced.warnings);
          updateProject(projectId, () => workingProject);
          patchState({ warnings });
        }
      }
      if (stopRef.current) {
        setAutomation(projectId, "paused", "media", { runId: completedRun.id });
        patchState({ phase: "paused" });
        return;
      }

      patchState({ stage: "quality" });
      setAutomation(projectId, "running", "quality", {
        runId: completedRun.id,
        warnings,
      });
      if (workingProject.qualityReport?.status === "fail") {
        throw new Error(
          `质量门禁未通过：${workingProject.qualityReport.summary ?? "请修复 Quality Agent 报告中的错误后重试。"}`,
        );
      }
      if (!workingProject.scenes.every((scene) => scene.narration.trim())) {
        throw new Error("有场景缺少旁白，无法生成完整成片。");
      }

      const composition = buildProjectComposition(workingProject);
      const validation = validateComposition(composition);
      if (!validation.valid) {
        throw new Error(`Scene DSL 校验失败：${validation.errors[0]}`);
      }

      patchState({ stage: "render", renderProgress: 0 });
      setAutomation(projectId, "running", "render", {
        runId: completedRun.id,
        warnings,
      });
      await flushDesktopStorage();
      const started = await startRemotionRender(
        projectId,
        composition,
        Date.parse(
          useStudioStore
            .getState()
            .projects.find((item) => item.id === projectId)?.updatedAt ??
            nowIso(),
        ),
      );
      setActiveRenderJobId(started.jobId);
      setAutomation(projectId, "running", "render", {
        runId: completedRun.id,
        renderJobId: started.jobId,
        warnings,
      });
      renderUnlisten = await listenRenderProgress((progress) => {
        if (progress.jobId !== started.jobId) return;
        patchState({ renderProgress: progress.percent });
      });
      const job = await waitForRender(
        projectId,
        started.jobId,
        (current) => patchState({ renderProgress: current.percent }),
      );
      if (job.status === "canceled") {
        throw new Error("渲染已停止。");
      }
      if (job.status !== "succeeded" || !job.outputPath || !job.bytes) {
        throw new Error(job.error ?? `渲染结束状态：${job.status}`);
      }

      const outputBytes = job.bytes;
      const outputPath = job.outputPath;
      updateProject(projectId, (current) => ({
        ...current,
        stage: "render",
        renders: [
          {
            id: makeId("render"),
            createdAt: nowIso(),
            resolution: `${composition.width}×${composition.height}`,
            format: "MP4 · H.264",
            duration: composition.durationInFrames / composition.fps,
            size: formatBytes(outputBytes),
            status: "ready",
            outputPath,
          },
          ...current.renders,
        ],
        automation: {
          status: "completed",
          stage: "done",
          runId: completedRun.id,
          renderJobId: started.jobId,
          outputPath,
          warnings,
          startedAt:
            current.automation?.startedAt ?? nowIso(),
          updatedAt: nowIso(),
        },
      }));
      patchState({
        phase: "completed",
        stage: "done",
        renderProgress: 100,
        outputPath,
        outputBytes,
        warnings,
      });
      pushToast({
        type: "success",
        title: "自动成片完成",
        message: `${formatBytes(outputBytes)} · 可以从输出目录打开 MP4。`,
      });
    } catch (error) {
      fail(projectId, error instanceof Error ? error.message : String(error));
    } finally {
      renderUnlisten?.();
      setActiveRenderJobId("");
      activeRef.current = false;
    }
  };

  useEffect(() => {
    if (!project || !isTauriDesktop || startedRef.current) return;
    if (params.get("run") !== "1") return;
    if (project.automation?.status === "completed" && project.automation.outputPath) {
      return;
    }
    startedRef.current = true;
    // The autopilot is an external side effect; its first state update happens in the async task.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runPipeline();
    // runPipeline reads the latest persisted project and is intentionally started once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, projectId]);

  const stop = async () => {
    stopRef.current = true;
    patchState({ phase: "paused" });
    if (runIdRef.current) {
      await pauseWorkflow(runIdRef.current).catch(() => undefined);
    }
    if (activeRenderJobId) {
      await cancelRemotionRender(projectId ?? "", activeRenderJobId).catch(
        () => undefined,
      );
    }
    if (projectId) setAutomation(projectId, "paused", state.stage === "input" ? "queued" : state.stage);
  };

  if (!project) return null;
  const currentStageIndex = stageIndex(state.stage);
  const completed = state.phase === "completed";
  const stageStatus = (index: number): StageStatus => {
    if (completed) return "done";
    if (state.phase === "failed" && index === currentStageIndex) return "failed";
    if (index < currentStageIndex) return "done";
    if (index === currentStageIndex && state.phase === "running") return "running";
    return "waiting";
  };
  const stageFraction =
    state.stage === "render"
      ? state.renderProgress / 100
      : state.stage === "media" && state.imageProgress.total > 0
        ? state.imageProgress.completed /
          Math.max(1, state.imageProgress.total)
        : 0;
  const totalStepProgress = completed
    ? 100
    : state.phase === "ready"
      ? 0
      : Math.min(
          99,
          Math.max(
            1,
            Math.round(
              ((Math.max(0, currentStageIndex) + stageFraction) /
                (stages.length - 1)) *
                100,
            ),
          ),
        );

  return (
    <div className="auto-studio-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="AUTOPILOT PRODUCTION"
        title={completed ? "视频已经生成" : "让 AI 从一句话完成整支视频"}
        description="研究、策划、脚本、分镜、动画、旁白、字幕与渲染会在同一条连续流水线中完成。"
        actions={
          <>
            <Pill
              tone={
                completed
                  ? "success"
                  : state.phase === "failed"
                    ? "danger"
                    : state.phase === "running"
                      ? "info"
                      : "neutral"
              }
              dot={state.phase === "running"}
            >
              {completed
                ? "已交付"
                : state.phase === "failed"
                  ? "需要处理"
                  : state.phase === "running"
                    ? "自动制作中"
                    : "准备开始"}
            </Pill>
            {state.phase === "running" && (
              <Button
                variant="secondary"
                icon={<Pause size={15} />}
                onClick={() => void stop()}
              >
                暂停制作
              </Button>
            )}
            {state.phase === "paused" && (
              <Button
                variant="primary"
                icon={<Play size={15} />}
                onClick={() => void runPipeline()}
              >
                继续制作
              </Button>
            )}
            {state.phase === "failed" && (
              <Button
                variant="primary"
                icon={<RotateCcw size={15} />}
                onClick={() => void runPipeline(true)}
              >
                重新生成
              </Button>
            )}
          </>
        }
      />

      {!isTauriDesktop && (
        <div className="auto-callout auto-callout--warning">
          <TriangleAlert size={18} />
          <div>
            <strong>当前是浏览器预览</strong>
            <p>自动 Agent、旁白和 MP4 渲染需要桌面版。项目内容已经保存，可在桌面版继续。</p>
          </div>
        </div>
      )}

      {state.error && (
        <div className="auto-callout auto-callout--error">
          <TriangleAlert size={18} />
          <div>
            <strong>自动制作已停止</strong>
            <p>{state.error}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate("/settings/models")}
          >
            检查模型
          </Button>
        </div>
      )}

      <section className={`auto-hero ${completed ? "is-complete" : ""}`}>
        <div className="auto-hero__copy">
          <span className="eyebrow">GENERATION BRIEF</span>
          <h2>{project.settings.topic}</h2>
          <p>
            {project.settings.brief ||
              "根据项目主题自动安排研究、叙事、视觉、声音与交付。"}
          </p>
          <div className="auto-hero__chips">
            <span>{project.settings.aspectRatio}</span>
            <span>{project.settings.duration} 秒</span>
            <span>{project.settings.style}</span>
            <span>{project.settings.language}</span>
            <span>{project.settings.audience}</span>
          </div>
          {state.phase === "ready" && isTauriDesktop && (
            <Button
              variant="primary"
              size="lg"
              icon={<Sparkles size={18} />}
              onClick={() => void runPipeline()}
            >
              开始自动成片
            </Button>
          )}
          {completed && (
            <div className="auto-output-card">
              <span><Film size={20} /></span>
              <div>
                <strong>H.264 MP4 · {formatBytes(state.outputBytes)}</strong>
                <small>{state.outputPath}</small>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Clapperboard size={14} />}
                onClick={() => navigate(`/projects/${project.id}/render`)}
              >
                查看成片
              </Button>
            </div>
          )}
        </div>

        <div className="auto-hero__meter">
          <div className="auto-meter-ring">
            <svg viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="49" />
              <circle
                cx="60"
                cy="60"
                r="49"
                style={{
                  strokeDasharray: `${Math.round(
                    (completed ? 100 : totalStepProgress) * 3.08,
                  )} 308`,
                }}
              />
            </svg>
            <span>
              <strong>{completed ? 100 : totalStepProgress}%</strong>
              <small>{stages[currentStageIndex]?.title ?? "准备"}</small>
            </span>
          </div>
          <div className="auto-meter-meta">
            <div>
              <span>当前环节</span>
              <strong>{stages[currentStageIndex]?.title ?? "准备开始"}</strong>
            </div>
            <div>
              <span>Agent</span>
              <strong>
                {run
                  ? `${run.steps.filter((step) => step.status === "completed").length}/${run.steps.length}`
                  : "9 步待执行"}
              </strong>
            </div>
            <div>
              <span>成片</span>
              <strong>{completed ? "READY" : state.phase === "running" ? "BUILDING" : "WAITING"}</strong>
            </div>
          </div>
          {state.stage === "render" && (
            <div className="auto-render-progress">
              <Progress value={state.renderProgress} />
              <span>{Math.round(state.renderProgress)}% · Remotion Renderer</span>
            </div>
          )}
          {state.stage === "media" && state.imageProgress.total > 0 && (
            <div className="auto-render-progress">
              <Progress
                value={
                  (state.imageProgress.completed /
                    Math.max(1, state.imageProgress.total)) *
                  100
                }
              />
              <span>
                图片 {state.imageProgress.completed}/{state.imageProgress.total}
              </span>
            </div>
          )}
        </div>
      </section>

      <div className="auto-layout">
        <section className="auto-pipeline">
          <header>
            <div>
              <span className="eyebrow">PRODUCTION PIPELINE</span>
              <h2>自动制作流水线</h2>
            </div>
            <span>一个上下文，连续交付</span>
          </header>
          <div className="auto-stage-list">
            {stages.map((stage, index) => {
              const status = stageStatus(index);
              const Icon = stage.icon;
              return (
                <div key={stage.key} className={`auto-stage auto-stage--${status}`}>
                  <span className="auto-stage__line" />
                  <span className="auto-stage__status">
                    {status === "done" ? (
                      <Check size={14} />
                    ) : status === "running" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : status === "failed" ? (
                      <TriangleAlert size={14} />
                    ) : (
                      <Circle size={11} />
                    )}
                  </span>
                  <span className="auto-stage__icon"><Icon size={17} /></span>
                  <div>
                    <strong>{stage.title}</strong>
                    <small>{stage.detail}</small>
                  </div>
                  <em>
                    {status === "done"
                      ? "完成"
                      : status === "running"
                        ? "进行中"
                        : status === "failed"
                          ? "停止"
                          : "等待"}
                  </em>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="auto-details">
          <span className="eyebrow">AUTOPILOT POLICY</span>
          <h2>自动执行策略</h2>
          <div className="auto-policy-list">
            <div>
              <ShieldCheck size={16} />
              <span><strong>安全工具白名单</strong><small>模型只修改结构化项目数据</small></span>
            </div>
            <div>
              <FileText size={16} />
              <span><strong>连续 DAG</strong><small>自动跳过人工审批节点</small></span>
            </div>
            <div>
              <AudioLines size={16} />
              <span><strong>声音优先</strong><small>自动生成旁白、字幕和音轨</small></span>
            </div>
            <div>
              <ImageIcon size={16} />
              <span><strong>按需图片</strong><small>有 Image Provider 时补位图素材</small></span>
            </div>
            <div>
              <Film size={16} />
              <span><strong>质量门禁</strong><small>DSL 或质量失败时不交付坏片</small></span>
            </div>
          </div>

          {run && (
            <div className="auto-agent-status">
              <span className="eyebrow">AGENT RUN</span>
              {run.steps.map((step) => (
                <div key={step.key}>
                  <span className={`auto-agent-dot auto-agent-dot--${step.status}`} />
                  <strong>{step.title.replace(" Agent", "")}</strong>
                  <small>{step.status}</small>
                </div>
              ))}
            </div>
          )}
          {state.warnings.length > 0 && (
            <div className="auto-warnings">
              <span className="eyebrow">NON-BLOCKING NOTES</span>
              {state.warnings.map((warning, index) => (
                <p key={`${warning}-${index}`}>{warning}</p>
              ))}
            </div>
          )}
          <div className="auto-detail-actions">
            <Button
              variant="soft"
              icon={<ArrowRight size={15} />}
              onClick={() => navigate(`/projects/${project.id}/workflow`)}
            >
              查看专家工作流
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate(`/projects/${project.id}/plan`)}
            >
              打开内容策划
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
