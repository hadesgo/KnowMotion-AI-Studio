import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Circle,
  GitBranch,
  History,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  TriangleAlert,
  Undo2,
  UserCheck,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeading, useCurrentProject } from "../components/AppShell";
import {
  Button,
  IconButton,
  Pill,
  Select,
  TextInput,
} from "../components/ui";
import { isTauriDesktop } from "../services/desktop";
import {
  approveWorkflowStep,
  getWorkflow,
  getWorkflowDefinition,
  listWorkflows,
  listenForWorkflowChanges,
  pauseWorkflow,
  rerunWorkflowStep,
  resumeWorkflow,
  retryWorkflow,
  startWorkflow,
  undoWorkflowRevision,
  type AgentModelRoute,
  type WorkflowDefinition,
  type WorkflowRun,
  fallbackWorkflowDefinition,
} from "../services/agentWorkflow";
import { useStudioStore } from "../store/studio";
import type { VideoProject } from "../types";
import "./AgentWorkflow.css";

const AUTO_ROUTE_KEY = "knowmotion-agent-routes-v1";

const statusTone: Record<
  string,
  "neutral" | "success" | "warning" | "info" | "danger" | "accent"
> = {
  pending: "neutral",
  running: "info",
  completed: "success",
  waiting_approval: "warning",
  failed: "danger",
  paused: "warning",
  changes_requested: "danger",
  stale: "neutral",
};

const statusLabel: Record<string, string> = {
  pending: "等待",
  running: "执行中",
  completed: "已完成",
  waiting_approval: "待审批",
  failed: "失败",
  paused: "已暂停",
  changes_requested: "需要修改",
  stale: "待重跑",
  pending_run: "待开始",
};

function StepStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <Check size={14} />;
  if (status === "running") return <LoaderCircle size={14} className="spin" />;
  if (status === "waiting_approval") return <UserCheck size={14} />;
  if (status === "failed" || status === "changes_requested")
    return <AlertTriangle size={14} />;
  return <Circle size={12} />;
}

function defaultRoutes(
  definition: WorkflowDefinition | null,
  providers: ReturnType<typeof useStudioStore.getState>["providers"],
  llmProviderId?: string,
): Record<string, AgentModelRoute> {
  const saved = window.localStorage.getItem(AUTO_ROUTE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved) as Record<string, AgentModelRoute>;
    } catch {
      window.localStorage.removeItem(AUTO_ROUTE_KEY);
    }
  }
  const provider =
    providers.find((item) => item.id === llmProviderId && item.enabled) ??
    providers.find(
      (item) => item.enabled && item.capabilities.includes("LLM"),
    );
  if (!provider || !definition) return {};
  return Object.fromEntries(
    definition.agents.map((agent) => [
      agent.key,
      { providerId: provider.id, model: provider.model },
    ]),
  );
}

export default function AgentWorkflow() {
  const project = useCurrentProject();
  const providers = useStudioStore((state) => state.providers);
  const llmProviderId = useStudioStore((state) => state.taskRoutes.LLM);
  const updateProject = useStudioStore((state) => state.updateProject);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [definition, setDefinition] = useState<WorkflowDefinition>(
    fallbackWorkflowDefinition,
  );
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [selectedStepKey, setSelectedStepKey] = useState("");
  const [routes, setRoutes] = useState<Record<string, AgentModelRoute>>(() =>
    defaultRoutes(fallbackWorkflowDefinition, providers, llmProviderId),
  );
  const [instruction, setInstruction] = useState("");
  const [targetAgent, setTargetAgent] = useState("director");
  const [approvalNote, setApprovalNote] = useState("");
  const [loading, setLoading] = useState(isTauriDesktop);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const currentRunRef = useRef("");
  const projectId = project?.id;

  const loadRun = useCallback(async (runId: string) => {
    const next = await getWorkflow(runId);
    currentRunRef.current = next.id;
    setRun(next);
    setSelectedStepKey((current) => current || next.steps[0]?.key || "");
    if (next.project && projectId) {
      updateProject(projectId, () => ({
        ...(next.project as VideoProject),
        id: projectId,
      }));
    }
  }, [projectId, updateProject]);

  useEffect(() => {
    if (!isTauriDesktop || !projectId) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const initialize = async () => {
      try {
        const [workflowDefinition, history] = await Promise.all([
          getWorkflowDefinition(),
          listWorkflows(projectId, 15),
        ]);
        if (disposed) return;
        setDefinition(workflowDefinition);
        setRuns(history);
        setRoutes(
          defaultRoutes(workflowDefinition, providers, llmProviderId),
        );
        if (history[0]) {
          setRun(history[0]);
          currentRunRef.current = history[0].id;
          setSelectedStepKey(
            history[0].currentStepKey ?? history[0].steps[0]?.key ?? "",
          );
          if (history[0].project) {
            updateProject(projectId, () => ({
              ...(history[0].project as VideoProject),
              id: projectId,
            }));
          }
        }
        unlisten = await listenForWorkflowChanges((event) => {
          if (event.runId === currentRunRef.current || !currentRunRef.current) {
            void loadRun(event.runId);
          }
          void listWorkflows(projectId, 15).then(setRuns);
        });
      } catch (initError) {
        setError(
          initError instanceof Error ? initError.message : String(initError),
        );
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void initialize();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    llmProviderId,
    loadRun,
    projectId,
    providers,
    updateProject,
  ]);

  useEffect(() => {
    if (Object.keys(routes).length) {
      window.localStorage.setItem(AUTO_ROUTE_KEY, JSON.stringify(routes));
    }
  }, [routes]);

  const selectedAgent = definition?.agents.find(
    (agent) => agent.key === selectedStepKey,
  );
  const selectedStep = run?.steps.find(
    (step) => step.key === selectedStepKey,
  );
  const completed = run?.steps.filter((step) => step.status === "completed").length ?? 0;
  const total = run?.steps.length ?? definition?.agents.length ?? 0;
  const activeProviders = providers.filter(
    (provider) => provider.enabled && provider.capabilities.includes("LLM"),
  );

  const setRoute = (
    agentKey: string,
    patch: Partial<AgentModelRoute>,
  ) => {
    setRoutes((current) => ({
      ...current,
      [agentKey]: {
        providerId:
          patch.providerId ??
          current[agentKey]?.providerId ??
          activeProviders[0]?.id ??
          "",
        model:
          patch.model !== undefined
            ? patch.model
            : current[agentKey]?.model,
      },
    }));
  };

  if (!project) return null;

  const start = async () => {
    if (!isTauriDesktop) return;
    if (!activeProviders.length) {
      pushToast({
        type: "error",
        title: "没有可用的 LLM Provider",
        message: "请先在 AI 模型页面配置并检测一个模型服务。",
      });
      return;
    }
    const missing = definition?.agents.filter(
      (agent) => !routes[agent.key]?.providerId,
    );
    if (missing?.length) {
      pushToast({
        type: "error",
        title: "Agent 模型映射不完整",
        message: `还有 ${missing.length} 个 Agent 未指定模型。`,
      });
      return;
    }
    setBusyAction("start");
    setError("");
    try {
      const next = await startWorkflow(project, providers, routes, {
        instruction: instruction.trim() || undefined,
        maxAttempts: 2,
      });
      currentRunRef.current = next.id;
      setRun(next);
      setSelectedStepKey(next.steps[0]?.key ?? "");
      const history = await listWorkflows(project.id, 15);
      setRuns(history);
      pushToast({
        type: "success",
        title: "Agent 工作流已启动",
        message: "任务状态会实时持久化，审批节点会自动暂停。",
      });
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      setBusyAction("");
    }
  };

  const runAction = async (
    actionName: string,
    action: () => Promise<WorkflowRun>,
  ) => {
    setBusyAction(actionName);
    setError("");
    try {
      const next = await action();
      currentRunRef.current = next.id;
      setRun(next);
      setSelectedStepKey((current) =>
        next.currentStepKey ?? current ?? next.steps[0]?.key ?? "",
      );
      if (next.project) {
        updateProject(project.id, () => ({
          ...(next.project as VideoProject),
          id: project.id,
        }));
      }
      void listWorkflows(project.id, 15).then(setRuns);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : String(actionError),
      );
    } finally {
      setBusyAction("");
    }
  };

  const startInstruction = async () => {
    if (!instruction.trim()) {
      pushToast({ type: "error", title: "请描述希望修改的内容" });
      return;
    }
    setBusyAction("instruction");
    setError("");
    try {
      const next = await startWorkflow(project, providers, routes, {
        instruction: instruction.trim(),
        targetAgent,
        maxAttempts: 2,
      });
      currentRunRef.current = next.id;
      setRun(next);
      setSelectedStepKey(targetAgent);
      const history = await listWorkflows(project.id, 15);
      setRuns(history);
      setInstruction("");
      pushToast({
        type: "success",
        title: "增量修改已排队",
        message: `已指定 ${definition?.agents.find((agent) => agent.key === targetAgent)?.title ?? targetAgent} 执行。`,
      });
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : String(actionError),
      );
    } finally {
      setBusyAction("");
    }
  };

  return (
    <div className="agent-workflow-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="AGENT ORCHESTRATION"
        title="让 AI 接管创作流程，但把决定权留在你手里"
        description="九个专业 Agent 通过结构化工具修改项目。每一步都有依赖、状态、模型路由、审批和可撤销修订。"
        actions={
          <>
            {isTauriDesktop ? (
              <Pill tone={run ? statusTone[run.status] ?? "neutral" : "neutral"} dot>
                {run ? statusLabel[run.status] ?? run.status : "尚未运行"}
              </Pill>
            ) : (
              <Pill tone="warning">需要桌面运行</Pill>
            )}
            <Button
              variant="primary"
              icon={
                busyAction === "start" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Sparkles size={16} />
                )
              }
              onClick={() => void start()}
              disabled={!isTauriDesktop || Boolean(busyAction)}
            >
              {run && !["completed", "failed"].includes(run.status)
                ? "启动新工作流"
                : "运行完整工作流"}
            </Button>
          </>
        }
      />

      {!isTauriDesktop && (
        <div className="workflow-desktop-notice">
          <Zap size={19} />
          <div>
            <strong>Agent 执行需要 Tauri 桌面运行时</strong>
            <p>
              当前浏览器预览仍可编辑项目和模型元数据。真实 Agent 调用、SQLite
              任务状态、系统凭据和安全文件工具只在桌面版启用。
            </p>
          </div>
          <code>npm run desktop:dev</code>
        </div>
      )}

      {error && (
        <div className="workflow-error">
          <TriangleAlert size={17} />
          <div>
            <strong>工作流操作失败</strong>
            <p>{error}</p>
          </div>
          <IconButton label="关闭错误" onClick={() => setError("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}

      <div className="workflow-overview">
        <section className="workflow-run-card">
          <div className="workflow-run-card__head">
            <div>
              <span className="eyebrow">CURRENT RUN</span>
              <h2>{run ? `#${run.id.slice(0, 8)}` : "尚未启动"}</h2>
            </div>
            {run && (
              <Pill tone={statusTone[run.status] ?? "neutral"} dot>
                {statusLabel[run.status] ?? run.status}
              </Pill>
            )}
          </div>
          <div className="workflow-progress-ring">
            <svg viewBox="0 0 90 90" aria-label={`已完成 ${completed}/${total}`}>
              <circle cx="45" cy="45" r="36" />
              <circle
                cx="45"
                cy="45"
                r="36"
                style={{
                  strokeDasharray: `${Math.round((completed / Math.max(1, total)) * 226)} 226`,
                }}
              />
            </svg>
            <span>
              <strong>{completed}</strong>
              /{total}
            </span>
          </div>
          <div className="workflow-run-card__meta">
            <div>
              <span>当前 Agent</span>
              <strong>
                {run?.currentStepKey
                  ? definition?.agents.find(
                      (agent) => agent.key === run.currentStepKey,
                    )?.title ?? run.currentStepKey
                  : "无"}
              </strong>
            </div>
            <div>
              <span>项目修订</span>
              <strong>{run?.revisions.length ?? 0}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>
                {run
                  ? new Date(run.updatedAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </strong>
            </div>
          </div>
          {run && (
            <div className="workflow-run-actions">
              {["running", "pending"].includes(run.status) && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Pause size={14} />}
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction("pause", () => pauseWorkflow(run.id))
                  }
                >
                  暂停
                </Button>
              )}
              {run.status === "paused" && (
                <Button
                  variant="soft"
                  size="sm"
                  icon={<Play size={14} />}
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction("resume", () => resumeWorkflow(run.id))
                  }
                >
                  恢复
                </Button>
              )}
              {run.status === "failed" && (
                <Button
                  variant="soft"
                  size="sm"
                  icon={<RotateCcw size={14} />}
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction("retry", () => retryWorkflow(run.id))
                  }
                >
                  重试失败步骤
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={14} />}
                disabled={Boolean(busyAction)}
                onClick={() => void loadRun(run.id)}
              >
                刷新状态
              </Button>
            </div>
          )}
          {run?.instruction && (
            <div className="workflow-instruction-echo">
              <Sparkles size={14} />
              <p>{run.instruction}</p>
            </div>
          )}
        </section>

        <section className="workflow-command-card">
          <div>
            <span className="eyebrow">NATURAL LANGUAGE EDIT</span>
            <h2>修改现有项目</h2>
            <p>选择一个 Agent，说明修改意图。变更仍会经过工具白名单、审批和修订记录。</p>
          </div>
          <div className="workflow-command-form">
            <Select
              value={targetAgent}
              onChange={(event) => setTargetAgent(event.target.value)}
              aria-label="修改目标 Agent"
            >
              {definition?.agents.map((agent) => (
                <option key={agent.key} value={agent.key}>
                  {agent.title}
                </option>
              ))}
            </Select>
            <TextInput
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void startInstruction();
              }}
              placeholder="例如：把第二个场景改得更紧凑，但保留原有事实…"
            />
            <Button
              variant="primary"
              icon={
                busyAction === "instruction" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Send size={15} />
                )
              }
              onClick={() => void startInstruction()}
              disabled={!isTauriDesktop || Boolean(busyAction) || !instruction.trim()}
            >
              执行修改
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              "把第二个场景增加镜头推进，旁白保持不变",
              "让第三个场景更有趣，但不要改旁白",
              "只调整最后一个场景的转场",
            ].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="rounded-full border border-[var(--border-soft)] bg-white/[.018] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:border-[rgba(200,255,101,.24)] hover:text-[var(--accent)]"
                onClick={() => {
                  setTargetAgent("animation");
                  setInstruction(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="workflow-layout">
        <section className="agent-dag-panel">
          <header>
            <div>
              <span className="eyebrow">AGENT DAG</span>
              <h2>调度图</h2>
            </div>
            <span>{total} 个专业 Agent</span>
          </header>
          <div className="agent-dag">
            {(definition?.agents ?? []).map((agent, index) => {
              const step = run?.steps.find((item) => item.key === agent.key);
              const status = step?.status ?? "pending";
              return (
                <div className="agent-node-wrap" key={agent.key}>
                  {index > 0 && <ArrowDown className="agent-node-arrow" size={15} />}
                  <button
                    type="button"
                    className={`agent-node agent-node--${status} ${
                      selectedStepKey === agent.key ? "is-selected" : ""
                    }`}
                    onClick={() => setSelectedStepKey(agent.key)}
                  >
                    <span className="agent-node__index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="agent-node__status">
                      <StepStatusIcon status={status} />
                    </span>
                    <div className="agent-node__copy">
                      <strong>{agent.title}</strong>
                      <small>{agent.description}</small>
                    </div>
                    <div className="agent-node__route">
                      <span>
                        {step?.model ??
                          routes[agent.key]?.model ??
                          providers.find(
                            (provider) =>
                              provider.id === routes[agent.key]?.providerId,
                          )?.model ??
                          "未配置"}
                      </span>
                      {agent.requiresApproval && (
                        <Pill tone="warning">{agent.approvalLabel}</Pill>
                      )}
                    </div>
                    <ChevronRight size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="agent-inspector">
          <header>
            <div>
              <span className="eyebrow">INSPECTOR</span>
              <h2>{selectedAgent?.title ?? "选择 Agent"}</h2>
            </div>
            {selectedAgent && <Pill tone="info">v{selectedAgent.version}</Pill>}
          </header>
          {selectedAgent ? (
            <>
              <p className="agent-inspector__description">
                {selectedAgent.description}
              </p>
              <div className="agent-inspector__section">
                <span className="eyebrow">DEPENDENCIES</span>
                <div className="agent-dependency-list">
                  {selectedAgent.dependencies.length ? (
                    selectedAgent.dependencies.map((dependency) => (
                      <span key={dependency}>
                        <GitBranch size={13} />
                        {definition?.agents.find((agent) => agent.key === dependency)
                          ?.title ?? dependency}
                      </span>
                    ))
                  ) : (
                    <span>起点 Agent</span>
                  )}
                </div>
              </div>
              <div className="agent-inspector__section">
                <span className="eyebrow">CONTROLLED TOOLS</span>
                <div className="agent-tool-list">
                  {selectedAgent.allowedTools.map((tool) => (
                    <code key={tool}>{tool}</code>
                  ))}
                </div>
              </div>
              <label className="route-field">
                <span>Provider</span>
                <Select
                  value={routes[selectedAgent.key]?.providerId ?? ""}
                  onChange={(event) => {
                    const provider = providers.find(
                      (item) => item.id === event.target.value,
                    );
                    setRoute(selectedAgent.key, {
                      providerId: event.target.value,
                      model: provider?.model,
                    });
                  }}
                >
                  <option value="">选择 Provider</option>
                  {activeProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="route-field">
                <span>Model override</span>
                <TextInput
                  value={routes[selectedAgent.key]?.model ?? ""}
                  onChange={(event) =>
                    setRoute(selectedAgent.key, { model: event.target.value })
                  }
                  placeholder="使用 Provider 默认模型"
                />
              </label>
              {selectedStep?.summary && (
                <div className="agent-result-card">
                  <span className="eyebrow">LATEST OUTPUT</span>
                  <p>{selectedStep.summary}</p>
                  {selectedStep.warnings.map((warning) => (
                    <div key={warning}>
                      <AlertTriangle size={13} />
                      {warning}
                    </div>
                  ))}
                </div>
              )}
              {selectedStep?.error && (
                <div className="agent-error-card">
                  <AlertTriangle size={15} />
                  <p>{selectedStep.error}</p>
                </div>
              )}
              {run && selectedStep && (
                <Button
                  variant="secondary"
                  className="full-button"
                  icon={<RotateCcw size={14} />}
                  disabled={
                    Boolean(busyAction) ||
                    !["completed", "failed", "changes_requested", "waiting_approval"].includes(
                      selectedStep.status,
                    )
                  }
                  onClick={() =>
                    void runAction("rerun", () =>
                      rerunWorkflowStep(run.id, selectedStep.key),
                    )
                  }
                >
                  从此步骤局部重跑
                </Button>
              )}
            </>
          ) : (
            <div className="agent-inspector__empty">
              <Bot size={22} />
              <p>选择一个 Agent，查看职责、工具、模型和最近输出。</p>
            </div>
          )}
        </aside>
      </div>

      <div className="workflow-bottom-grid">
        <section className="approval-panel">
          <header>
            <div>
              <span className="eyebrow">HUMAN IN THE LOOP</span>
              <h2>审批与修改</h2>
            </div>
            <Pill
              tone={
                run?.status === "waiting_approval" ? "warning" : "neutral"
              }
              dot
            >
              {run?.status === "waiting_approval" ? "等待决定" : "无待审批节点"}
            </Pill>
          </header>
          {run?.status === "waiting_approval" && run.currentStepKey ? (
            <>
              <p>
                {definition?.agents.find(
                  (agent) => agent.key === run.currentStepKey,
                )?.approvalLabel ?? "内容审批"}
                ：确认当前项目变更后，下游 Agent 才能继续。
              </p>
              <textarea
                value={approvalNote}
                onChange={(event) => setApprovalNote(event.target.value)}
                rows={2}
                placeholder="可选：说明需要修改的具体内容"
              />
              <div>
                <Button
                  variant="secondary"
                  icon={<ArrowDown size={14} />}
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction("changes", () =>
                      approveWorkflowStep(
                        run.id,
                        run.currentStepKey!,
                        "request_changes",
                        approvalNote,
                      ),
                    )
                  }
                >
                  要求修改
                </Button>
                <Button
                  variant="primary"
                  icon={<Check size={15} />}
                  disabled={Boolean(busyAction)}
                  onClick={() =>
                    void runAction("approve", () =>
                      approveWorkflowStep(
                        run.id,
                        run.currentStepKey!,
                        "approve",
                        approvalNote,
                      ),
                    )
                  }
                >
                  批准并继续
                </Button>
              </div>
            </>
          ) : (
            <div className="approval-empty">
              <UserCheck size={19} />
              <p>工作流遇到大纲、分镜或最终质量节点时会自动暂停。</p>
            </div>
          )}
        </section>

        <section className="revision-panel">
          <header>
            <div>
              <span className="eyebrow">PROJECT REVISIONS</span>
              <h2>变更记录</h2>
            </div>
            <Pill tone="neutral">{run?.revisions.length ?? 0} 条</Pill>
          </header>
          <div className="revision-list">
            {run?.revisions.length ? (
              run.revisions.slice(0, 8).map((revision) => (
                <div key={revision.id}>
                  <span>r{revision.revision}</span>
                  <div>
                    <strong>{revision.summary}</strong>
                    <small>
                      {revision.stepKey} ·{" "}
                      {new Date(revision.createdAt).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </small>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Undo2 size={13} />}
                    disabled={!revision.undoable || Boolean(busyAction)}
                    onClick={() =>
                      void runAction("undo", () =>
                        undoWorkflowRevision(run.id, revision.id),
                      )
                    }
                  >
                    撤销
                  </Button>
                </div>
              ))
            ) : (
              <p className="revision-empty">Agent 完成第一个工具调用后会生成可撤销修订。</p>
            )}
          </div>
        </section>

        <section className="run-history-panel">
          <header>
            <div>
              <span className="eyebrow">RUN HISTORY</span>
              <h2>运行历史</h2>
            </div>
            <History size={17} />
          </header>
          <div>
            {runs.length ? (
              runs.slice(0, 5).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === run?.id ? "is-active" : ""}
                  onClick={() => {
                    void loadRun(item.id);
                    setSelectedStepKey(item.currentStepKey ?? item.steps[0]?.key ?? "");
                  }}
                >
                  <span>
                    <WorkflowIcon size={14} />
                  </span>
                  <div>
                    <strong>#{item.id.slice(0, 8)}</strong>
                    <small>{item.instruction || item.workflowKey}</small>
                  </div>
                  <Pill tone={statusTone[item.status] ?? "neutral"}>
                    {statusLabel[item.status] ?? item.status}
                  </Pill>
                </button>
              ))
            ) : (
              <p>还没有运行记录。</p>
            )}
          </div>
          <Link to="/settings/models" className="workflow-model-link">
            <Zap size={14} /> 管理 Agent 模型和连接 <ArrowRight size={14} />
          </Link>
        </section>
      </div>

      {loading && (
        <div className="workflow-loading">
          <LoaderCircle className="spin" size={18} />
          正在读取持久化工作流…
        </div>
      )}
    </div>
  );
}
