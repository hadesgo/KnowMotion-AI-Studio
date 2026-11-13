import {
  AlertCircle,
  Check,
  ChevronDown,
  Info,
  X,
} from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useStudioStore } from "../store/studio";
import "./ui.css";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "soft";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
}) {
  const base =
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-transparent font-medium transition-colors duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45";
  const sizeClass = {
    sm: "h-9 px-3 text-[12px]",
    md: "h-[42px] px-4 text-[13px]",
    lg: "h-12 px-5 text-[14px]",
  }[size];
  const variantClass = {
    primary:
      "bg-[var(--accent)] text-[#0a100b] shadow-[0_6px_24px_rgba(200,255,101,.1)] hover:bg-[#d6ff86]",
    secondary:
      "border-[var(--border)] bg-[var(--raised)] text-[var(--subtext)] hover:border-[#344255] hover:bg-[var(--raised-2)] hover:text-[var(--text)]",
    soft:
      "border-[rgba(200,255,101,.17)] bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[rgba(200,255,101,.16)]",
    ghost:
      "bg-transparent text-[var(--muted)] hover:bg-white/[.045] hover:text-[var(--text)]",
    danger:
      "border-[rgba(255,107,125,.16)] bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[rgba(255,107,125,.18)]",
  }[variant];
  return (
    <button
      className={`button ${base} ${sizeClass} ${variantClass} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  const active = className.includes("is-active");
  return (
    <button
      className={`icon-button inline-grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[10px] border p-0 text-[var(--muted)] transition-colors duration-150 ${
        active
          ? "border-[var(--border)] bg-[var(--raised)] text-[var(--text)]"
          : "border-transparent bg-transparent hover:border-[var(--border)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
      } ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field flex flex-col gap-[7px] ${className}`}>
      <span className="text-[12px] font-medium text-[var(--subtext)]">
        {label}
      </span>
      {children}
      {error ? (
        <span className="flex items-center gap-1 text-[11px] leading-[1.5] text-[var(--danger)]">
          <AlertCircle size={13} />
          {error}
        </span>
      ) : hint ? (
        <span className="flex items-center gap-1 text-[11px] leading-[1.5] text-[var(--faint)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function TextInput({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`input h-11 w-full rounded-[9px] border border-[var(--border)] bg-[#0d131b] px-3 text-[13px] text-[var(--text)] transition-colors placeholder:text-[#4d5968] hover:border-[#344255] focus:border-[rgba(200,255,101,.45)] focus:bg-[#0f1720] focus:outline-none ${className}`}
      {...props}
    />
  );
}

export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`textarea min-h-[96px] w-full resize-y rounded-[9px] border border-[var(--border)] bg-[#0d131b] px-3 py-2.5 text-[13px] leading-[1.65] text-[var(--text)] transition-colors placeholder:text-[#4d5968] hover:border-[#344255] focus:border-[rgba(200,255,101,.45)] focus:bg-[#0f1720] focus:outline-none ${className}`}
      {...props}
    />
  );
}

export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap relative block">
      <select
        className={`select h-11 w-full appearance-none rounded-[9px] border border-[var(--border)] bg-[#0d131b] py-0 pl-3 pr-9 text-[13px] text-[var(--text)] transition-colors hover:border-[#344255] focus:border-[rgba(200,255,101,.45)] focus:bg-[#0f1720] focus:outline-none ${className}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]"
        size={15}
      />
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      className="segmented inline-flex gap-1 rounded-[10px] border border-[var(--border)] bg-[#0b1118] p-1"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 px-3 text-[12px] ${
            value === option.value
              ? "bg-[var(--raised-2)] text-[var(--text)] shadow-[0_2px_8px_rgba(0,0,0,.22)]"
              : "bg-transparent text-[var(--muted)] hover:text-[var(--subtext)]"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "info" | "danger" | "accent";
  dot?: boolean;
}) {
  const tones = {
    neutral:
      "border-[var(--border)] bg-white/[.025] text-[var(--muted)]",
    success:
      "border-[rgba(131,231,176,.2)] bg-[rgba(131,231,176,.08)] text-[var(--success)]",
    warning:
      "border-[rgba(255,188,102,.2)] bg-[var(--amber-soft)] text-[var(--amber)]",
    info:
      "border-[rgba(121,169,255,.2)] bg-[var(--blue-soft)] text-[var(--blue)]",
    danger:
      "border-[rgba(255,107,125,.2)] bg-[var(--danger-soft)] text-[var(--danger)]",
    accent:
      "border-[rgba(200,255,101,.22)] bg-[var(--accent-soft)] text-[var(--accent)]",
  };
  return (
    <span
      className={`pill inline-flex min-h-[24px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[10px] font-semibold tracking-[.2px] ${tones[tone]}`}
    >
      {dot && <span className="h-[5px] w-[5px] rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Progress({
  value,
  tone = "accent",
  compact = false,
}: {
  value: number;
  tone?: "accent" | "blue" | "violet";
  compact?: boolean;
}) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`progress ${compact ? "progress--compact" : ""} progress--${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safeValue)}
    >
      <span style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Toasts() {
  const toasts = useStudioStore((state) => state.toasts);
  const dismiss = useStudioStore((state) => state.dismissToast);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          <span className="toast__icon">
            {toast.type === "success" ? (
              <Check size={16} />
            ) : toast.type === "error" ? (
              <AlertCircle size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <div>
            <strong>{toast.title}</strong>
            {toast.message && <p>{toast.message}</p>}
          </div>
          <IconButton label="关闭提示" onClick={() => dismiss(toast.id)}>
            <X size={15} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || eyebrow || action) && (
        <header className="panel__header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h3>{title}</h3>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
