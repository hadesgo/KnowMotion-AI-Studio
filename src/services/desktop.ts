import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";
import type { VideoProject } from "../types";

export const isTauriDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const studioStorage: StateStorage = {
  async getItem(name) {
    if (isTauriDesktop) {
      try {
        const state = await invoke<string | null>("load_studio_state", {
          namespace: name,
        });
        if (state) return state;
      } catch (error) {
        console.error("Unable to load desktop state; falling back to WebView storage.", error);
      }
    }
    return window.localStorage.getItem(name);
  },
  async setItem(name, value) {
    window.localStorage.setItem(name, value);
    if (isTauriDesktop) {
      await invoke("save_studio_state", {
        namespace: name,
        stateJson: value,
      });
    }
  },
  async removeItem(name) {
    window.localStorage.removeItem(name);
    if (isTauriDesktop) {
      await invoke("remove_studio_state", { namespace: name });
    }
  },
};

export async function exportDesktopProject(
  project: VideoProject,
): Promise<string | null> {
  if (!isTauriDesktop) return null;
  return invoke<string>("export_project_json", {
    projectJson: JSON.stringify({ ...project, isDemo: false }, null, 2),
  });
}

export async function getDesktopStoragePath(): Promise<string | null> {
  if (!isTauriDesktop) return null;
  try {
    return await invoke<string>("desktop_storage_path");
  } catch {
    return null;
  }
}
