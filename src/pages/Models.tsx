import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
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
  ProviderCapability,
  ProviderProfile,
} from "../types";
import { makeId } from "../utils";

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
  "Ollama",
  "ComfyUI",
];

interface ProviderDraft {
  id?: string;
  name: string;
  protocol: ProviderProfile["protocol"];
  baseUrl: string;
  model: string;
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

  const openCreate = () => {
    setDraft({ ...emptyDraft, id: undefined });
    setFormError("");
    setModalOpen(true);
  };

  const openEdit = (provider: ProviderProfile) => {
    setDraft({
      ...provider,
      apiKey: "",
    });
    setFormError("");
    setModalOpen(true);
  };

  const saveProvider = () => {
    if (!draft.name.trim()) {
      setFormError("给这个 Provider 一个可识别的名称。");
      return;
    }
    try {
      new URL(draft.baseUrl);
    } catch {
      setFormError("API 地址必须是完整的 http(s) URL。");
      return;
    }
    if (!draft.model.trim()) {
      setFormError("请填写默认模型名称。");
      return;
    }
    if (!draft.capabilities.length) {
      setFormError("至少选择一种模型能力。");
      return;
    }
    const provider: ProviderProfile = {
      id: draft.id ?? makeId("provider"),
      name: draft.name.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      capabilities: draft.capabilities,
      enabled: draft.enabled,
      health: draft.id
        ? providers.find((item) => item.id === draft.id)?.health ?? "unchecked"
        : "unchecked",
      hasSecret: draft.hasSecret || Boolean(draft.apiKey),
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
    setModalOpen(false);
  };

  const validateConfiguration = (provider: ProviderProfile) => {
    const checks = [
      Boolean(provider.baseUrl.startsWith("http")),
      Boolean(provider.model.trim()),
      provider.capabilities.length > 0,
      provider.protocol === "Ollama" ||
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

  const removeProvider = (provider: ProviderProfile) => {
    if (window.confirm(`删除 Provider「${provider.name}」？`)) {
      deleteProvider(provider.id);
      pushToast({ type: "info", title: "Provider 已删除" });
    }
  };

  return (
    <div className="models-page">
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
            当前浏览器原型不会持久化 API Key。桌面版本将把密钥写入 Windows
            Credential Manager，项目 JSON、SQLite 与日志只保留引用。
          </p>
        </div>
        <Pill tone="info">原型模式</Pill>
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
                  {provider.protocol === "Ollama" ? <Server size={20} /> : <Sparkles size={20} />}
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
                <span>ENDPOINT</span>
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
                    icon={<RefreshCw size={14} />}
                    onClick={() => validateConfiguration(provider)}
                  >
                    校验
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(provider)}>
                    编辑
                  </Button>
                  <IconButton
                    label="删除 Provider"
                    onClick={() => removeProvider(provider)}
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
            <small>OpenAI 兼容、Anthropic、Gemini、Ollama、ComfyUI</small>
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
                  setDraft({
                    ...draft,
                    protocol: event.target.value as ProviderDraft["protocol"],
                  })
                }
              >
                {protocols.map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="API Base URL">
            <TextInput
              value={draft.baseUrl}
              onChange={(event) =>
                setDraft({ ...draft, baseUrl: event.target.value })
              }
            />
          </Field>
          <Field label="默认模型">
            <TextInput
              value={draft.model}
              onChange={(event) =>
                setDraft({ ...draft, model: event.target.value })
              }
              placeholder="模型名称或本地模型标签"
            />
          </Field>
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
              placeholder={draft.hasSecret ? "已绑定密钥，输入可替换" : "本地服务可留空"}
              autoComplete="off"
            />
          </Field>
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
          <Button variant="primary" onClick={saveProvider}>
            保存 Provider
          </Button>
        </footer>
      </Modal>
    </div>
  );
}
