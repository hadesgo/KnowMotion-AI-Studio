import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  HardDrive,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { useState } from "react";
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
import { isTauriDesktop } from "../services/desktop";
import {
  clearProviderSecret,
  saveProviderSecret,
  testProviderConnection,
} from "../services/agentWorkflow";
import "./Models.css";

const capabilities: ProviderCapability[] = [
  "LLM",
  "Image",
  "TTS",
  "ASR",
  "Embedding",
];

const protocols: ProviderProfile["protocol"][] = [
  "OpenAI Compatible",
  "Anthropic",
  "Gemini",
  "GGUF",
  "Ollama",
  "ComfyUI",
];

interface ProviderDraft {
  id?: string;
  name: string;
  protocol: ProviderProfile["protocol"];
  baseUrl: string;
  model: string;
  contextSize: number;
  inferenceBackend: GgufInferenceBackend;
  capabilities: ProviderCapability[];
  apiKey: string;
  enabled: boolean;
  hasSecret: boolean;
}

const emptyDraft: ProviderDraft = {
  name: "",
  protocol: "OpenAI Compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.1",
  contextSize: 8192,
  inferenceBackend: "auto",
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

  const openCreate = () => {
    setDraft({ ...emptyDraft, id: undefined });
    setFormError("");
    setModalOpen(true);
  };

  const openEdit = (provider: ProviderProfile) => {
    setDraft({
      ...provider,
      contextSize: provider.contextSize ?? 8192,
      inferenceBackend: provider.inferenceBackend ?? "auto",
      apiKey: "",
    });
    setFormError("");
    setModalOpen(true);
  };

  const saveProvider = async () => {
    if (!draft.name.trim()) {
      setFormError("给这个 Provider 一个可识别的名称。");
      return;
    }
    const isGguf = draft.protocol === "GGUF";
    if (isGguf) {
      if (!draft.baseUrl.trim().toLowerCase().endsWith(".gguf")) {
        setFormError("请选择或填写完整的 .gguf 模型文件路径。");
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
    const providerId = draft.id ?? makeId("provider");
    const usesApiKey = ["OpenAI Compatible", "Anthropic", "Gemini"].includes(
      draft.protocol,
    );
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
    const provider: ProviderProfile = {
      id: providerId,
      name: draft.name.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      contextSize: Math.max(512, Math.min(1_048_576, draft.contextSize || 8192)),
      inferenceBackend: draft.inferenceBackend,
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
          ? "原型仅记录“已输入密钥”，不会持久化密钥内容。"
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
        ? provider.baseUrl.trim().toLowerCase().endsWith(".gguf")
        : provider.baseUrl.startsWith("http");
    const checks = [
      validEndpoint,
      Boolean(provider.model.trim()),
      provider.capabilities.length > 0,
      provider.protocol === "Ollama" ||
        provider.protocol === "GGUF" ||
        provider.protocol === "ComfyUI" ||
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
                  {provider.protocol === "GGUF" ? "MODEL FILE" : "ENDPOINT"}
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
                        ? "DX12 GPU"
                        : "AUTO GPU"}
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
            <small>OpenAI 兼容、Anthropic、Gemini、GGUF、Ollama、ComfyUI</small>
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
            <Field label="协议">
              <Select
                value={draft.protocol}
                onChange={(event) =>
                  setDraft((current) => {
                    const protocol = event.target
                      .value as ProviderDraft["protocol"];
                    return {
                      ...current,
                      protocol,
                      baseUrl:
                        protocol === "GGUF" &&
                        !current.baseUrl.toLowerCase().endsWith(".gguf")
                          ? ""
                          : current.baseUrl,
                    };
                  })
                }
              >
                {protocols.map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="field flex flex-col gap-[7px]">
            <span className="text-[12px] font-medium text-[var(--subtext)]">
              {draft.protocol === "GGUF" ? "GGUF 模型文件" : "API Base URL"}
            </span>
            <TextInput
              value={draft.baseUrl}
              onChange={(event) =>
                setDraft({ ...draft, baseUrl: event.target.value })
              }
              placeholder={
                draft.protocol === "GGUF"
                  ? "D:\\models\\qwen2.5-0.5b-instruct-q4_k_m.gguf"
                  : undefined
              }
            />
            {draft.protocol === "GGUF" && (
              <Button
                variant="secondary"
                size="sm"
                icon={<FolderOpen size={14} />}
                onClick={() => void pickGgufModel()}
              >
                选择 .gguf 文件
              </Button>
            )}
            {draft.protocol === "GGUF" && (
              <span className="flex items-center gap-1 text-[11px] leading-[1.5] text-[var(--faint)]">
                模型只在当前电脑本地加载和推理，不上传到外部服务。
              </span>
            )}
          </div>
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
              hint="Token 数。更高的上下文占用更多内存；默认 8192。"
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
          {draft.protocol === "GGUF" && (
            <Field
              label="推理设备"
              hint="自动模式优先使用 DirectX 12 GPU；未检测到 GPU 时回退 CPU。"
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
                <option value="gpu">GPU（DirectX 12）</option>
                <option value="cpu">CPU</option>
              </Select>
            </Field>
          )}
          {draft.protocol !== "GGUF" && (
            <Field
              label="API Key"
              hint="仅用于本次页面会话；关闭页面后不会保留。"
            >
              <TextInput
                type="password"
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft({ ...draft, apiKey: event.target.value })
                }
                placeholder={
                  draft.hasSecret ? "已绑定密钥，输入可替换" : "本地服务可留空"
                }
                autoComplete="off"
              />
            </Field>
          )}
          <Field label="支持能力">
            <div className="capability-picker">
              {capabilities.map((capability) => {
                const selected = draft.capabilities.includes(capability);
                return (
                  <button
                    type="button"
                    key={capability}
                    className={selected ? "is-selected" : ""}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        capabilities: selected
                          ? draft.capabilities.filter((item) => item !== capability)
                          : [...draft.capabilities, capability],
                      })
                    }
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
