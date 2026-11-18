import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  FolderOpen,
  HardDrive,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PageHeading } from "../components/AppShell";
import {
  Button,
  Field,
  IconButton,
  Modal,
  Pill,
  Select,
  TextInput,
} from "../components/ui";
import { useStudioStore } from "../store/studio";
import type {
  GgufInferenceBackend,
  ProviderCapability,
  ProviderProfile,
} from "../types";
import { makeId } from "../utils";
import {
  exportDesktopDiagnostics,
  isTauriDesktop,
} from "../services/desktop";
import {
  clearProviderSecret,
  saveProviderSecret,
  testProviderConnection,
} from "../services/agentWorkflow";
import {
  ensureLocalRuntime,
  getLocalModelSchedulerStatus,
  unloadLocalModels,
  type LocalRuntimeId,
  type LocalModelSchedulerStatus,
} from "../services/localRuntime";
import "./Models.css";

const capabilities: ProviderCapability[] = [
  "LLM",
  "Image",
  "TTS",
  "ASR",
  "Embedding",
];

type ConnectionType = "external" | "local";

const localProtocols: ProviderProfile["protocol"][] = [
  "GGUF",
  "audio.cpp",
  "stable-diffusion.cpp",
];

function runtimeForProtocol(
  protocol: ProviderProfile["protocol"],
): LocalRuntimeId | null {
  if (protocol === "GGUF") return "llama.cpp";
  if (protocol === "audio.cpp") return "audio.cpp";
  if (protocol === "stable-diffusion.cpp") return "stable-diffusion.cpp";
  return null;
}

/**
 * GGUF 既接受具体模型文件，也接受模型目录（目录里只有一份可加载模型时由后端
 * 自动挑选，`mmproj-*.gguf` 投影器会被排除）。
 */
function isGgufModelPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase().endsWith(".gguf")) return true;
  const lastSegment = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return lastSegment.length > 0 && !lastSegment.includes(".");
}

const localProtocolDefaults: Partial<
  Record<ProviderProfile["protocol"], { baseUrl: string; model: string }>
> = {
  "audio.cpp": {
    baseUrl: "http://127.0.0.1:8080",
    model: "qwen3-tts",
  },
  "stable-diffusion.cpp": {
    baseUrl: "http://127.0.0.1:1234",
    model: "sd-cpp-local",
  },
};

const externalProtocolDefaults: Partial<
  Record<
    ProviderProfile["protocol"],
    {
      baseUrl: string;
      model: string;
      capabilities: ProviderCapability[];
    }
  >
> = {
  "OpenAI Compatible": {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.1",
    capabilities: ["LLM"],
  },
  Anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    capabilities: ["LLM"],
  },
  Gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
    capabilities: ["LLM"],
  },
  Ollama: {
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3",
    capabilities: ["LLM"],
  },
  ModelScope: {
    baseUrl: "https://api-inference.modelscope.cn",
    model: "Qwen/Qwen-Image-2.1-Turbo",
    capabilities: ["Image"],
  },
  "Fish Audio": {
    baseUrl: "https://api.fish.audio",
    model: "s2.1-pro-free",
    capabilities: ["TTS"],
  },
};

interface ProviderDraft {
  id?: string;
  name: string;
  connectionType: ConnectionType;
  protocol: ProviderProfile["protocol"];
  baseUrl: string;
  model: string;
  contextSize: number;
  inferenceBackend: GgufInferenceBackend;
  runtimeModelPath: string;
  runtimeModelFamily: string;
  runtimeIdleSeconds: number;
  capabilities: ProviderCapability[];
  apiKey: string;
  enabled: boolean;
  hasSecret: boolean;
}

const emptyDraft: ProviderDraft = {
  name: "",
  connectionType: "external",
  protocol: "OpenAI Compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.1",
  contextSize: 8192,
  inferenceBackend: "auto",
  runtimeModelPath: "",
  runtimeModelFamily: "",
  runtimeIdleSeconds: 60,
  capabilities: ["LLM"],
  apiKey: "",
  enabled: true,
  hasSecret: false,
};

export default function Models() {
  const providers = useStudioStore((state) => state.providers);
  const taskRoutes = useStudioStore((state) => state.taskRoutes);
  const addProvider = useStudioStore((state) => state.addProvider);
  const updateProvider = useStudioStore((state) => state.updateProvider);
  const deleteProvider = useStudioStore((state) => state.deleteProvider);
  const setTaskRoute = useStudioStore((state) => state.setTaskRoute);
  const pushToast = useStudioStore((state) => state.pushToast);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [runtimeInstall, setRuntimeInstall] = useState<{
    runtime: LocalRuntimeId;
    status: "downloading" | "ready" | "error" | "unsupported";
    message: string;
  } | null>(null);
  const [schedulerStatus, setSchedulerStatus] =
    useState<LocalModelSchedulerStatus | null>(null);
  const [unloadingModels, setUnloadingModels] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);

  useEffect(() => {
    if (!isTauriDesktop) return;
    let cancelled = false;
    const refresh = () => {
      void getLocalModelSchedulerStatus()
        .then((status) => {
          if (!cancelled) setSchedulerStatus(status);
        })
        .catch(() => {
          if (!cancelled) setSchedulerStatus(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const unloadAllLocalModels = async () => {
    setUnloadingModels(true);
    try {
      const status = await unloadLocalModels();
      setSchedulerStatus(status);
      pushToast({
        type: "success",
        title: "本地模型已卸载",
        message: "GPU 显存租约已释放，下次请求会按需重新启动并加载模型。",
      });
    } catch (error) {
      pushToast({
        type: "error",
        title: "模型卸载失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUnloadingModels(false);
    }
  };

  const exportDiagnostics = async () => {
    setExportingDiagnostics(true);
    try {
      const output = await exportDesktopDiagnostics();
      pushToast({
        type: "success",
        title: "诊断包已导出",
        message: output
          ? `已脱敏日志与运行状态保存到 ${output}`
          : "诊断包仅支持桌面版导出。",
      });
    } catch (error) {
      pushToast({
        type: "error",
        title: "诊断包导出失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const installRuntimeForProtocol = async (
    protocol: ProviderProfile["protocol"],
    force = false,
    acceleration: "auto" | "vulkan" | "cuda" | "cuda13" = "auto",
  ) => {
    const runtime = runtimeForProtocol(protocol);
    if (!runtime) return;
    if (!isTauriDesktop) {
      setRuntimeInstall({
        runtime,
        status: "unsupported",
        message: "浏览器预览不能安装本地运行时，请运行桌面版。",
      });
      return;
    }
    setRuntimeInstall({
      runtime,
      status: "downloading",
      message: force
        ? `正在重新下载 ${runtime}（${acceleration === "auto" ? "自动选择后端" : acceleration}，忽略已安装副本）并逐文件校验。`
        : `正在检测 CUDA 并获取 ${runtime}，首次使用需要下载。`,
    });
    try {
      const result = await ensureLocalRuntime(runtime, force, acceleration);
      setRuntimeInstall({
        runtime,
        status: "ready",
        message: force
          ? `${runtime} · ${result.acceleration} 已重新安装并完成逐文件校验`
          : result.repairPerformed
            ? `${runtime} · ${result.acceleration} 检测到文件损坏，已自动修复`
            : result.alreadyInstalled
              ? `${runtime} · ${result.acceleration} 已安装，关键文件哈希通过`
              : `${runtime} · ${result.acceleration} 已下载并完成逐文件校验`,
      });
      if (force || !result.alreadyInstalled || result.repairPerformed) {
        pushToast({
          type: "success",
          title: force
            ? "本地运行时已重新安装"
            : result.repairPerformed
              ? "本地运行时已自动修复"
              : "本地运行时已就绪",
          message: `${runtime} · ${result.acceleration} · ${result.version} · 关键文件哈希通过`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 模型文件与运行时是两件事：这里点名「运行时」，避免看起来像模型下载失败。
      const message = `本地运行时 ${runtime} 不可用：${detail}`;
      setRuntimeInstall({
        runtime,
        status: "error",
        message,
      });
      pushToast({
        type: "error",
        title: force ? "运行时重新下载失败" : "本地运行时不可用",
        message,
      });
    }
  };

  const openCreate = () => {
    setDraft({ ...emptyDraft, id: undefined });
    setFormError("");
    setRuntimeInstall(null);
    setModalOpen(true);
  };

  const openEdit = (provider: ProviderProfile) => {
    setDraft({
      ...provider,
      connectionType: localProtocols.includes(provider.protocol)
        ? "local"
        : "external",
      contextSize: provider.contextSize ?? 8192,
      inferenceBackend: provider.inferenceBackend ?? "auto",
      runtimeModelPath:
        provider.runtime?.modelDirectory ?? provider.runtime?.modelPath ?? "",
      runtimeModelFamily: provider.runtime?.modelFamily ?? "",
      runtimeIdleSeconds:
        provider.runtime?.idleUnloadSeconds ??
        (provider.protocol === "audio.cpp" ? 60 : 120),
      apiKey: "",
    });
    setFormError("");
    setRuntimeInstall(null);
    setModalOpen(true);
  };

  const saveProvider = async () => {
    if (!draft.name.trim()) {
      setFormError("给这个 Provider 一个可识别的名称。");
      return;
    }
    const isGguf = draft.protocol === "GGUF";
    if (isGguf) {
      if (!isGgufModelPath(draft.baseUrl)) {
        setFormError("请选择 .gguf 模型文件，或填写包含模型的目录路径。");
        return;
      }
    } else {
      try {
        new URL(draft.baseUrl);
      } catch {
        setFormError("API 地址必须是完整的 http(s) URL。");
        return;
      }
    }
    if (!draft.model.trim()) {
      setFormError("请填写默认模型名称。");
      return;
    }
    if (!draft.capabilities.length) {
      setFormError("至少选择一种模型能力。");
      return;
    }
    if (
      draft.protocol === "audio.cpp" &&
      (draft.capabilities.length !== 1 ||
        !draft.capabilities.some((item) => item === "TTS" || item === "ASR"))
    ) {
      setFormError("audio.cpp 的一个 Provider 只能配置一个 TTS 或 ASR 模型。");
      return;
    }
    if (
      draft.protocol === "stable-diffusion.cpp" &&
      (draft.capabilities.length !== 1 ||
        draft.capabilities[0] !== "Image")
    ) {
      setFormError("stable-diffusion.cpp 只支持 Image 能力。");
      return;
    }
    if (
      draft.protocol === "ModelScope" &&
      (draft.capabilities.length !== 1 ||
        draft.capabilities[0] !== "Image")
    ) {
      setFormError("ModelScope 当前只用于异步图片生成，请仅选择 Image 能力。");
      return;
    }
    if (
      draft.protocol === "Fish Audio" &&
      (draft.capabilities.length !== 1 ||
        draft.capabilities[0] !== "TTS")
    ) {
      setFormError("Fish Audio 当前只支持 TTS，请仅选择 TTS 能力。");
      return;
    }
    if (
      draft.protocol === "GGUF" &&
      (draft.capabilities.length !== 1 ||
        !["LLM", "Embedding"].includes(draft.capabilities[0]))
    ) {
      setFormError("GGUF 本地模型只能配置 LLM 或 Embedding 其中一种能力。");
      return;
    }
    const providerId = draft.id ?? makeId("provider");
    const usesApiKey = [
      "OpenAI Compatible",
      "Anthropic",
      "Gemini",
      "ModelScope",
      "Fish Audio",
    ].includes(draft.protocol);
    if (isTauriDesktop && usesApiKey && draft.apiKey.trim()) {
      try {
        setSaving(true);
        await saveProviderSecret(providerId, draft.apiKey.trim());
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : `密钥保存失败：${String(error)}`,
        );
        setSaving(false);
        return;
      }
    }
    const runtime =
      draft.protocol === "audio.cpp"
        ? {
            modelPath: draft.runtimeModelPath.trim() || undefined,
            modelFamily: draft.runtimeModelFamily.trim() || undefined,
            idleUnloadSeconds: Math.max(0, Math.min(86_400, draft.runtimeIdleSeconds)),
          }
        : draft.protocol === "stable-diffusion.cpp"
          ? {
              modelDirectory: draft.runtimeModelPath.trim() || undefined,
              idleUnloadSeconds: Math.max(0, Math.min(86_400, draft.runtimeIdleSeconds)),
            }
          : undefined;
    const provider: ProviderProfile = {
      id: providerId,
      name: draft.name.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      contextSize: Math.max(512, Math.min(1_048_576, draft.contextSize || 8192)),
      inferenceBackend: draft.inferenceBackend,
      runtime,
      capabilities: draft.capabilities,
      enabled: draft.enabled,
      health: draft.id
        ? providers.find((item) => item.id === draft.id)?.health ?? "unchecked"
        : "unchecked",
      hasSecret:
        usesApiKey && (draft.hasSecret || Boolean(draft.apiKey.trim())),
      isDefault:
        providers.find((item) => item.id === draft.id)?.isDefault ?? false,
    };
    if (draft.id) {
      updateProvider(draft.id, provider);
      pushToast({ type: "success", title: "Provider 配置已更新" });
    } else {
      addProvider(provider);
      pushToast({
        type: "success",
        title: "Provider 已添加",
        message: draft.apiKey
          ? isTauriDesktop
            ? "Token 已写入系统凭据库，项目文件与日志仅保留 Provider 引用。"
            : "浏览器预览不会持久化 Token。"
          : undefined,
      });
    }
    setSaving(false);
    setModalOpen(false);
  };

  const validateConfiguration = async (provider: ProviderProfile) => {
    if (isTauriDesktop) {
      setTestingId(provider.id);
      try {
        const result = await testProviderConnection(provider);
        updateProvider(provider.id, { health: "healthy" });
        pushToast({
          type: "success",
          title: "模型连接成功",
          message: `${result.model} · ${result.backend} · ${result.latencyMs} ms · ${result.message}`,
        });
      } catch (error) {
        updateProvider(provider.id, { health: "error" });
        pushToast({
          type: "error",
          title: "模型连接失败",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setTestingId("");
      }
      return;
    }
    const validEndpoint =
      provider.protocol === "GGUF"
        ? isGgufModelPath(provider.baseUrl)
        : provider.baseUrl.startsWith("http");
    const checks = [
      validEndpoint,
      Boolean(provider.model.trim()),
      provider.capabilities.length > 0,
      provider.protocol === "Ollama" ||
        provider.protocol === "GGUF" ||
        provider.hasSecret ||
        provider.baseUrl,
    ];
    const ok = checks.every(Boolean);
    updateProvider(provider.id, { health: ok ? "healthy" : "error" });
    pushToast({
      type: ok ? "success" : "error",
      title: ok ? "配置结构校验通过" : "配置仍有缺失",
      message: ok
        ? "浏览器原型未发起模型网络请求；桌面版会执行真实连接检测。"
        : "检查 API 地址、模型名称和凭据状态。",
    });
  };

  const pickGgufModel = async () => {
    if (!isTauriDesktop) {
      setFormError("浏览器预览无法读取本地路径，请运行桌面版选择模型文件。");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "GGUF 模型", extensions: ["gguf"] }],
      });
      if (typeof selected !== "string") return;
      const filename = selected.split(/[\\/]/).pop() ?? selected;
      const modelName = filename.replace(/\.gguf$/i, "");
      setDraft((current) => ({
        ...current,
        baseUrl: selected,
        model: filename,
        name: current.name.trim() || modelName,
      }));
      setFormError("");
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : `模型文件选择失败：${String(error)}`,
      );
    }
  };

  const pickGgufDirectory = async () => {
    if (!isTauriDesktop) {
      setFormError("浏览器预览无法读取本地路径，请运行桌面版选择模型目录。");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory: true,
      });
      if (typeof selected !== "string") return;
      const folderName =
        selected.split(/[\\/]/).filter(Boolean).pop() ?? "local-model";
      setDraft((current) => ({
        ...current,
        baseUrl: selected,
        model: current.model.trim() || folderName,
        name: current.name.trim() || folderName,
      }));
      setFormError("");
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : `模型目录选择失败：${String(error)}`,
      );
    }
  };

  const pickRuntimeModelPath = async (directory: boolean) => {
    if (!isTauriDesktop) {
      setFormError("浏览器预览无法读取本地模型路径，请运行桌面版。");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory,
        filters:
          !directory &&
          (draft.protocol === "GGUF" || draft.protocol === "audio.cpp")
            ? [{ name: "GGUF 模型", extensions: ["gguf"] }]
            : undefined,
      });
      if (typeof selected !== "string") return;
      setDraft((current) => ({
        ...current,
        runtimeModelPath: selected,
      }));
      setFormError("");
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : `路径选择失败：${String(error)}`,
      );
    }
  };

  const removeProvider = async (provider: ProviderProfile) => {
    if (window.confirm(`删除 Provider「${provider.name}」？`)) {
      if (isTauriDesktop && provider.hasSecret) {
        try {
          await clearProviderSecret(provider.id);
        } catch {
          // Metadata can still be removed if the credential was already absent.
        }
      }
      deleteProvider(provider.id);
      pushToast({ type: "info", title: "Provider 已删除" });
    }
  };

  return (
    <div className="models-page mx-auto w-full max-w-[1580px] px-4 pb-10 pt-6 xl:px-[30px]">
      <PageHeading
        eyebrow="AI INFRASTRUCTURE"
        title="模型与能力配置"
        description="按能力接入模型服务。业务工作流选择能力，不直接依赖某一家供应商。"
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={openCreate}
          >
            添加 Provider
          </Button>
        }
      />

      <div className="model-security-banner">
        <span><ShieldCheck size={20} /></span>
        <div>
            <strong>密钥边界</strong>
          <p>
              {isTauriDesktop
                ? "桌面版会将 API Key 写入 Windows Credential Manager，项目 JSON、SQLite 与日志只保留引用。"
                : "浏览器预览不会持久化 API Key。使用 Agent Workflow 和真实模型连接时请运行 Tauri 桌面版。"}
          </p>
        </div>
        <Pill tone={isTauriDesktop ? "success" : "info"}>
          {isTauriDesktop ? "桌面凭据库" : "浏览器预览"}
        </Pill>
      </div>

      {isTauriDesktop && (
        <div className="model-security-banner mt-2.5">
          <span><Power size={20} /></span>
          <div>
            <strong>本地模型调度器</strong>
            <p>
              {schedulerStatus
                ? `单一 GPU 租约 · ${
                    schedulerStatus.freeVramMib !== null
                      ? `${schedulerStatus.freeVramMib} MiB 可用`
                      : "显存遥测不可用"
                  } · ${schedulerStatus.vramReserveMib} MiB 安全余量 · ${
                    schedulerStatus.activeLease
                      ? `${schedulerStatus.activeLease.workload.toUpperCase()} 正在运行`
                      : "当前空闲"
                  } · ${schedulerStatus.managedProcesses} 个 HTTP 托管进程`
                    + `${
                      schedulerStatus.runtimes.some(
                        (runtime) => runtime.gpuSmokeTested,
                      )
                        ? ` · ${schedulerStatus.runtimes.filter((runtime) => runtime.gpuSmokeTested).length} 个模型已通过真实 GPU 推理 smoke`
                        : ""
                    }`
                : "按需启动 llama.cpp、audio.cpp 与 stable-diffusion.cpp，并在空闲时自动卸载模型。"}
            </p>
          </div>
          <Pill tone={schedulerStatus?.activeLease ? "accent" : "success"}>
            {schedulerStatus?.activeLease ? "GPU LEASED" : "READY"}
          </Pill>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void unloadAllLocalModels()}
            disabled={unloadingModels}
          >
            {unloadingModels ? "卸载中" : "卸载全部"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void exportDiagnostics()}
            disabled={exportingDiagnostics}
          >
            <Download size={15} />
            {exportingDiagnostics ? "打包中" : "导出诊断"}
          </Button>
        </div>
      )}

      <div className="models-summary">
        <div>
          <span className="eyebrow">CONNECTED SERVICES</span>
          <strong>{providers.length.toString().padStart(2, "0")}</strong>
          <small>个 Provider</small>
        </div>
        <div>
          <span className="eyebrow">CAPABILITIES</span>
          <strong>{new Set(providers.flatMap((provider) => provider.capabilities)).size}</strong>
          <small>种能力已覆盖</small>
        </div>
        <div>
          <span className="eyebrow">TASK ROUTING</span>
          <strong>{Object.keys(taskRoutes).length}</strong>
          <small>项任务路由</small>
        </div>
      </div>

      <section className="provider-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">PROVIDERS</span>
            <h2>模型服务</h2>
          </div>
          <p>支持在线、自托管与本地推理服务。</p>
        </div>
        <div className="provider-grid">
          {providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <header>
                <span className="provider-card__logo">
                  {provider.protocol === "GGUF" ? (
                    <HardDrive size={20} />
                  ) : provider.protocol === "Ollama" ? (
                    <Server size={20} />
                  ) : (
                    <Sparkles size={20} />
                  )}
                </span>
                <div>
                  <div className="provider-card__title">
                    <h3>{provider.name}</h3>
                    {provider.isDefault && <Pill tone="accent">默认</Pill>}
                  </div>
                  <p>{provider.protocol}</p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    onChange={(event) =>
                      updateProvider(provider.id, {
                        enabled: event.target.checked,
                      })
                    }
                  />
                  <span />
                </label>
              </header>
              <div className="provider-card__endpoint">
                <span>
                  {provider.protocol === "GGUF" ? "MODEL PATH" : "ENDPOINT"}
                </span>
                <code>{provider.baseUrl}</code>
              </div>
              <div className="provider-card__model">
                <span>MODEL</span>
                <strong>{provider.model}</strong>
              </div>
              <div className="provider-card__capabilities">
                {provider.capabilities.map((capability) => (
                  <Pill key={capability} tone="neutral">{capability}</Pill>
                ))}
                {provider.protocol === "GGUF" && (
                  <Pill tone="accent">
                    {provider.inferenceBackend === "cpu"
                      ? "CPU"
                      : provider.inferenceBackend === "gpu"
                        ? "VULKAN GPU"
                        : "AUTO GPU"}
                  </Pill>
                )}
                {["audio.cpp", "stable-diffusion.cpp"].includes(
                  provider.protocol,
                ) && (
                  <Pill tone="accent">
                    {provider.runtime?.modelPath ||
                    provider.runtime?.modelDirectory
                      ? "AUTO START"
                      : "EXTERNAL"}
                  </Pill>
                )}
              </div>
              <footer>
                <div
                  className={`provider-health provider-health--${provider.health}`}
                >
                  {provider.health === "healthy" ? (
                    <CheckCircle2 size={14} />
                  ) : provider.health === "error" ? (
                    <CircleAlert size={14} />
                  ) : (
                    <Zap size={14} />
                  )}
                  {provider.health === "healthy"
                    ? "配置有效"
                    : provider.health === "error"
                      ? "需要修复"
                      : "未检测"}
                </div>
                <div className="provider-card__actions">
                  {provider.health === "error" &&
                    runtimeForProtocol(provider.protocol) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Download size={14} />}
                        onClick={() =>
                          void installRuntimeForProtocol(provider.protocol, true)
                        }
                      >
                        重装运行时
                      </Button>
                    )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={
                      <RefreshCw
                        size={14}
                        className={testingId === provider.id ? "spin" : ""}
                      />
                    }
                    onClick={() => validateConfiguration(provider)}
                    disabled={testingId === provider.id}
                  >
                    {testingId === provider.id ? "检测中" : "检测"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(provider)}>
                    编辑
                  </Button>
                  <IconButton
                    label="删除 Provider"
                    onClick={() => void removeProvider(provider)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </footer>
            </article>
          ))}
          <button type="button" className="provider-add-card" onClick={openCreate}>
            <span><Plus size={22} /></span>
            <strong>接入另一个模型服务</strong>
            <small>外部 API 链接 / 本地模型</small>
          </button>
        </div>
      </section>

      <section className="routing-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">TASK ROUTING</span>
            <h2>任务模型映射</h2>
          </div>
          <Pill tone="info">仅保存映射</Pill>
        </div>
        <div className="routing-list">
          {capabilities.map((capability) => {
            const eligible = providers.filter(
              (provider) =>
                provider.enabled && provider.capabilities.includes(capability),
            );
            return (
              <div className="routing-row" key={capability}>
                <span className="routing-row__icon">
                  {capability === "LLM" || capability === "Embedding" ? (
                    <KeyRound size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}
                </span>
                <div>
                  <strong>
                    {capability === "LLM"
                      ? "研究与脚本"
                      : capability === "Image"
                        ? "视觉素材"
                        : capability === "TTS"
                          ? "旁白合成"
                          : capability === "ASR"
                            ? "语音识别"
                            : "知识检索"}
                  </strong>
                  <small>{capability}</small>
                </div>
                {eligible.length ? (
                  <Select
                    value={taskRoutes[capability] ?? eligible[0].id}
                    onChange={(event) => {
                      setTaskRoute(capability, event.target.value);
                    }}
                  >
                    {eligible.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name} · {provider.model}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Button variant="ghost" size="sm" onClick={openCreate}>
                    添加能力 <ChevronRight size={14} />
                  </Button>
                )}
                <span className="routing-row__state">
                  {eligible.length ? <Check size={14} /> : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={draft.id ? "编辑 Provider" : "添加 Provider"}
        description="这里保存服务元数据。API Key 内容不会写入浏览器持久存储。"
        width={620}
      >
        <div className="modal__body form-stack">
          <div className="form-grid">
            <Field label="显示名称">
              <TextInput
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="例如：Studio OpenAI"
              />
            </Field>
            <Field label="接入方式">
              <Select
                value={draft.connectionType}
                onChange={(event) => {
                  const connectionType = event.target
                    .value as ConnectionType;
                  if (connectionType === "local") {
                    void installRuntimeForProtocol("GGUF");
                  } else {
                    setRuntimeInstall(null);
                  }
                  setDraft((current) => {
                    if (connectionType === "external") {
                      return {
                        ...current,
                        connectionType,
                        protocol: "OpenAI Compatible",
                        baseUrl: "https://api.openai.com/v1",
                        model: "gpt-5.1",
                        apiKey: "",
                        hasSecret: false,
                        capabilities: current.capabilities.length
                          ? current.capabilities
                          : ["LLM"],
                      };
                    }
                    return {
                      ...current,
                      connectionType,
                      protocol: "GGUF",
                      baseUrl: "",
                      model: "",
                      capabilities: ["LLM"],
                    };
                  });
                }}
              >
                <option value="external">外部 API 链接</option>
                <option value="local">本地模型</option>
              </Select>
            </Field>
          </div>
          {draft.connectionType === "external" && (
            <Field
              label="接口协议"
              hint="ModelScope 使用异步图片任务提交与轮询协议。"
            >
              <Select
                value={draft.protocol}
                onChange={(event) => {
                  const protocol = event.target
                    .value as ProviderProfile["protocol"];
                  const defaults = externalProtocolDefaults[protocol];
                  setDraft((current) => ({
                    ...current,
                    protocol,
                    baseUrl: defaults?.baseUrl ?? current.baseUrl,
                    model: defaults?.model ?? current.model,
                    capabilities:
                      defaults?.capabilities ?? current.capabilities,
                    apiKey: "",
                    hasSecret: false,
                  }));
                  setFormError("");
                }}
              >
                <option value="OpenAI Compatible">OpenAI Compatible</option>
                <option value="Anthropic">Anthropic</option>
                <option value="Gemini">Gemini</option>
                <option value="Ollama">Ollama</option>
                <option value="ModelScope">
                  ModelScope · 异步图片
                </option>
                <option value="Fish Audio">Fish Audio · TTS</option>
              </Select>
            </Field>
          )}
          {draft.connectionType === "local" && (
            <Field
              label="本地运行时"
              hint="按任务选择对应的原生推理进程。"
            >
              <Select
                value={
                  localProtocols.includes(draft.protocol)
                    ? draft.protocol
                    : "GGUF"
                }
                onChange={(event) => {
                  const protocol = event.target
                    .value as ProviderProfile["protocol"];
                  void installRuntimeForProtocol(protocol);
                  setDraft((current) => {
                    const defaults = localProtocolDefaults[protocol];
                    const capabilities: ProviderCapability[] =
                      protocol === "audio.cpp"
                        ? [
                            current.capabilities.find(
                              (item) => item === "TTS" || item === "ASR",
                            ) ?? "TTS",
                          ]
                        : protocol === "stable-diffusion.cpp"
                          ? ["Image"]
                          : ["LLM"];
                    return {
                      ...current,
                      connectionType: "local",
                      protocol,
                      baseUrl:
                        defaults?.baseUrl ??
                        (protocol === "GGUF" ? "" : current.baseUrl),
                      model: defaults?.model ?? "",
                      runtimeModelPath:
                        protocol === current.protocol
                          ? current.runtimeModelPath
                          : "",
                      runtimeModelFamily:
                        protocol === "audio.cpp"
                          ? current.runtimeModelFamily
                          : "",
                      runtimeIdleSeconds:
                        protocol === "audio.cpp"
                          ? current.protocol === "audio.cpp"
                            ? Math.max(0, current.runtimeIdleSeconds)
                            : 60
                          : protocol === "stable-diffusion.cpp"
                            ? current.protocol === "stable-diffusion.cpp"
                              ? Math.max(0, current.runtimeIdleSeconds)
                              : 120
                            : current.runtimeIdleSeconds,
                      capabilities,
                    };
                  });
                }}
              >
                <option value="GGUF">GGUF · llama.cpp</option>
                <option value="audio.cpp">audio.cpp · TTS / ASR</option>
                <option value="stable-diffusion.cpp">
                  stable-diffusion.cpp · 图片
                </option>
              </Select>
              {runtimeInstall && (
                <span
                  className={`text-[11px] leading-[1.5] ${
                    runtimeInstall.status === "error"
                      ? "text-[var(--danger)]"
                      : "text-[var(--faint)]"
                  }`}
                >
                  {runtimeInstall.message}
                </span>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download size={14} />}
                  disabled={runtimeInstall?.status === "downloading"}
                  onClick={() =>
                    void installRuntimeForProtocol(draft.protocol, true)
                  }
                >
                  重新下载运行时
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download size={14} />}
                  disabled={runtimeInstall?.status === "downloading"}
                  onClick={() =>
                    void installRuntimeForProtocol(draft.protocol, true, "vulkan")
                  }
                >
                  改用 Vulkan 重装
                </Button>
              </div>
              <span className="text-[11px] leading-[1.5] text-[var(--faint)]">
                手工放入 runtimes 目录的副本会被自动接管；CUDA 构建若缺少 cudart64_*.dll
                会在启动时以 0xc0000135 退出，此时用 Vulkan 版本体积更小、驱动兼容更好。
              </span>
            </Field>
          )}
          <div className="field flex flex-col gap-[7px]">
            <span className="text-[12px] font-medium text-[var(--subtext)]">
              {draft.protocol === "GGUF" ? "GGUF 模型文件或目录" : "API Base URL"}
            </span>
            <TextInput
              value={draft.baseUrl}
              onChange={(event) =>
                setDraft({ ...draft, baseUrl: event.target.value })
              }
              placeholder={
                draft.protocol === "GGUF"
                  ? "D:\\code\\models\\embeddinggemma-2\\embeddinggemma-2-Q8_0.gguf"
                  : undefined
              }
            />
            {draft.protocol === "GGUF" && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FolderOpen size={14} />}
                  onClick={() => void pickGgufModel()}
                >
                  选择 .gguf 文件
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<HardDrive size={14} />}
                  onClick={() => void pickGgufDirectory()}
                >
                  选择模型目录
                </Button>
              </div>
            )}
            {draft.protocol === "GGUF" && (
              <span className="flex items-center gap-1 text-[11px] leading-[1.5] text-[var(--faint)]">
                模型只在当前电脑本地加载和推理，不上传到外部服务。目录输入会挑出其中唯一的
                .gguf（自动排除 mmproj 投影器）；目录内有多份模型时请直接填目标文件路径。
              </span>
            )}
            {draft.protocol === "ModelScope" && (
              <span className="text-[11px] leading-[1.5] text-[var(--faint)]">
                填写服务根地址即可，例如 https://api-inference.modelscope.cn。
                应用会提交 /v1/images/generations，每 5 秒轮询任务，并从
                output_images 下载结果。
              </span>
            )}
            {draft.protocol === "Fish Audio" && (
              <span className="text-[11px] leading-[1.5] text-[var(--faint)]">
                填写服务根地址，例如 https://api.fish.audio。生成时调用
                /v1/tts，模型名通过 model 请求头发送；音色
                reference_id 在“音频字幕”页面按项目填写。
              </span>
            )}
          </div>
          {["audio.cpp", "stable-diffusion.cpp"].includes(draft.protocol) && (
            <div className="field flex flex-col gap-[7px]">
              <span className="text-[12px] font-medium text-[var(--subtext)]">
                {draft.protocol === "audio.cpp"
                  ? "本地模型文件或包目录"
                  : "stable-diffusion 模型目录"}
              </span>
              <TextInput
                value={draft.runtimeModelPath}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    runtimeModelPath: event.target.value,
                  })
                }
                placeholder={
                  draft.protocol === "audio.cpp"
                    ? "D:\\models\\Qwen3-TTS-1.7B"
                    : "D:\\models\\stable-diffusion"
                }
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FolderOpen size={14} />}
                  onClick={() => void pickRuntimeModelPath(true)}
                >
                  选择目录
                </Button>
                {draft.protocol === "audio.cpp" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<HardDrive size={14} />}
                    onClick={() => void pickRuntimeModelPath(false)}
                  >
                    选择 .gguf
                  </Button>
                )}
              </div>
              <span className="text-[11px] leading-[1.5] text-[var(--faint)]">
                {draft.protocol === "audio.cpp"
                  ? "填写后应用会自动生成 max_loaded_models=1 的服务配置；留空则连接你手动启动的服务。"
                  : "填写后会自动发现 diffusion_models、text_encoders 与 vae 组件并预载；留空则连接手动服务。"}
              </span>
            </div>
          )}
          {draft.protocol === "audio.cpp" && (
            <div className="form-grid">
              <Field
                label="audio.cpp 模型族"
                hint="Qwen3 模型可自动识别；其他模型建议填写官方 family。"
              >
                <TextInput
                  value={draft.runtimeModelFamily}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      runtimeModelFamily: event.target.value,
                    })
                  }
                  placeholder="例如 qwen3_tts"
                />
              </Field>
              <Field
                label="空闲卸载（秒）"
                hint="请求结束且租约释放后，达到此时间会卸载模型权重。"
              >
                <TextInput
                  type="number"
                  min={0}
                  max={86_400}
                  value={draft.runtimeIdleSeconds}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      runtimeIdleSeconds: Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
          )}
          {draft.protocol === "stable-diffusion.cpp" && (
            <Field
              label="空闲卸载（秒）"
              hint="图片批次结束后释放扩散模型；默认 120 秒。"
            >
              <TextInput
                type="number"
                min={0}
                max={86_400}
                value={draft.runtimeIdleSeconds}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    runtimeIdleSeconds: Number(event.target.value),
                  })
                }
              />
            </Field>
          )}
          <Field label="默认模型">
            <TextInput
              value={draft.model}
              onChange={(event) =>
                setDraft({ ...draft, model: event.target.value })
              }
              placeholder="模型名称或本地模型标签"
            />
          </Field>
          {draft.protocol === "GGUF" && (
            <Field
              label="上下文长度"
              hint={
                draft.capabilities.includes("Embedding")
                  ? "嵌入模型的训练上下文通常只有 512–2048；默认 2048。"
                  : "Token 数。更高的上下文占用更多内存；默认 8192。"
              }
            >
              <TextInput
                type="number"
                min={512}
                max={1_048_576}
                step={512}
                value={draft.contextSize}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    contextSize: Number(event.target.value),
                  })
                }
              />
            </Field>
          )}
          {["GGUF", "audio.cpp", "stable-diffusion.cpp"].includes(
            draft.protocol,
          ) && (
            <Field
              label="推理设备"
              hint="自动模式使用已安装运行时的 CUDA/Vulkan 加速；CPU 模式会降低显存占用。"
            >
              <Select
                value={draft.inferenceBackend}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    inferenceBackend: event.target
                      .value as GgufInferenceBackend,
                  })
                }
              >
                <option value="auto">自动（GPU 优先）</option>
                <option value="gpu">GPU（已安装加速）</option>
                <option value="cpu">CPU</option>
              </Select>
            </Field>
          )}
          {!["GGUF", "audio.cpp", "stable-diffusion.cpp"].includes(
            draft.protocol,
          ) && (
            <Field
              label="API Key"
              hint={
                isTauriDesktop
                  ? "桌面版写入系统凭据库，不进入项目文件、SQLite 或日志。"
                  : "浏览器预览仅用于本次页面会话。"
              }
            >
              <TextInput
                type="password"
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft({ ...draft, apiKey: event.target.value })
                }
                placeholder={
                  draft.hasSecret
                    ? "已绑定密钥，输入可替换"
                    : draft.protocol === "Fish Audio"
                      ? "输入 Fish Audio API Token"
                      : "本地服务可留空"
                }
                autoComplete="off"
              />
            </Field>
          )}
          <Field label="支持能力">
            <div className="capability-picker">
              {capabilities
                .filter((capability) => {
                  if (draft.protocol === "audio.cpp") {
                    return capability === "TTS" || capability === "ASR";
                  }
                  if (draft.protocol === "stable-diffusion.cpp") {
                    return capability === "Image";
                  }
                  if (draft.protocol === "ModelScope") {
                    return capability === "Image";
                  }
                  if (draft.protocol === "Fish Audio") {
                    return capability === "TTS";
                  }
                  if (draft.protocol === "GGUF") {
                    return capability === "LLM" || capability === "Embedding";
                  }
                  return true;
                })
                .map((capability) => {
                  const selected = draft.capabilities.includes(capability);
                  return (
                    <button
                      type="button"
                      key={capability}
                      className={selected ? "is-selected" : ""}
                      onClick={() => {
                        if (draft.protocol === "audio.cpp") {
                          setDraft({
                            ...draft,
                            capabilities: [capability],
                            model:
                              capability === "ASR"
                                ? "qwen3-asr"
                                : capability === "TTS"
                                  ? "qwen3-tts"
                                  : draft.model,
                          });
                          return;
                        }
                        if (draft.protocol === "stable-diffusion.cpp") {
                          setDraft({
                            ...draft,
                            capabilities: ["Image"],
                          });
                          return;
                        }
                        if (draft.protocol === "ModelScope") {
                          setDraft({
                            ...draft,
                            capabilities: ["Image"],
                          });
                          return;
                        }
                        if (draft.protocol === "Fish Audio") {
                          setDraft({
                            ...draft,
                            capabilities: ["TTS"],
                          });
                          return;
                        }
                        if (draft.protocol === "GGUF") {
                          const switching =
                            draft.capabilities[0] !== capability;
                          setDraft({
                            ...draft,
                            capabilities: [capability],
                            contextSize: switching
                              ? capability === "Embedding"
                                ? 2048
                                : 8192
                              : draft.contextSize,
                          });
                          return;
                        }
                        setDraft({
                          ...draft,
                          capabilities: selected
                            ? draft.capabilities.filter(
                                (item) => item !== capability,
                              )
                            : [...draft.capabilities, capability],
                        });
                      }}
                    >
                      {selected && <Check size={13} />}
                      {capability}
                    </button>
                  );
                })}
            </div>
          </Field>
          {formError && (
            <div className="inline-error">
              <CircleAlert size={15} />
              {formError}
            </div>
          )}
        </div>
        <footer className="modal__footer">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void saveProvider()} disabled={saving}>
            {saving ? "正在保存…" : "保存 Provider"}
          </Button>
        </footer>
      </Modal>
    </div>
  );
}
