import { invoke } from "@tauri-apps/api/core";
import { isTauriDesktop } from "./desktop";

const MAX_CLIENT_LOG_CHARS = 64 * 1024;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string) {
  return value.length > MAX_CLIENT_LOG_CHARS
    ? `${value.slice(0, MAX_CLIENT_LOG_CHARS)}…[truncated]`
    : value;
}

export async function writeLog(
  level: LogLevel,
  target: string,
  message: string,
  fields?: Record<string, unknown>,
) {
  if (!isTauriDesktop) return;
  try {
    await invoke("write_webview_log", {
      level,
      target: target.slice(0, 160),
      message: truncate(message),
      fieldsJson: fields
        ? truncate(
            JSON.stringify(fields, (_key, value) =>
              value instanceof Error
                ? { name: value.name, message: value.message, stack: value.stack }
                : value,
            ),
          )
        : null,
    });
  } catch {
    // Logging must never break the UI or recurse into console handlers.
  }
}

export function logError(target: string, message: string, error?: unknown) {
  void writeLog("error", target, message, {
    error: error === undefined ? undefined : describe(error),
  });
}

export function installWebviewLogging() {
  if (!isTauriDesktop || typeof window === "undefined") return;

  window.addEventListener("error", (event) => {
    void writeLog("error", "webview", event.message || "Unhandled window error", {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error ? describe(event.error) : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    void writeLog("error", "webview", "Unhandled promise rejection", {
      error: describe(event.reason),
    });
  });

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    void writeLog("error", "console", args.map(describe).join(" ").slice(0, MAX_CLIENT_LOG_CHARS));
  };
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    void writeLog("warn", "console", args.map(describe).join(" ").slice(0, MAX_CLIENT_LOG_CHARS));
  };
}
