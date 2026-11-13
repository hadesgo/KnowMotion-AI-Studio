import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";
import type { VideoProject } from "../types";

export const isTauriDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface PendingStorageWrite {
  value: string;
  timer: number;
  resolvers: Array<() => void>;
  rejectors: Array<(reason: unknown) => void>;
}

const pendingStorageWrites = new Map<string, PendingStorageWrite>();

function persistPendingStorage(name: string) {
  const pending = pendingStorageWrites.get(name);
  if (!pending) return;
  pendingStorageWrites.delete(name);
  void invoke("save_studio_state", {
    namespace: name,
    stateJson: pending.value,
  }).then(
    () => pending.resolvers.forEach((resolve) => resolve()),
    (error) => pending.rejectors.forEach((reject) => reject(error)),
  );
}

export async function flushDesktopStorage(): Promise<void> {
  if (!isTauriDesktop) return;
  const names = [...pendingStorageWrites.keys()];
  await Promise.all(
    names.map(async (name) => {
      const pending = pendingStorageWrites.get(name);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingStorageWrites.delete(name);
      try {
        await invoke("save_studio_state", {
          namespace: name,
          stateJson: pending.value,
        });
        pending.resolvers.forEach((resolve) => resolve());
      } catch (error) {
        pending.rejectors.forEach((reject) => reject(error));
        throw error;
      }
    }),
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const name of pendingStorageWrites.keys()) {
      window.clearTimeout(pendingStorageWrites.get(name)?.timer);
      persistPendingStorage(name);
    }
  });
}

export const studioStorage: StateStorage = {
  async getItem(name) {
    const pending = pendingStorageWrites.get(name);
    if (pending) return pending.value;
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
    if (!isTauriDesktop) return;
    return new Promise<void>((resolve, reject) => {
      const pending = pendingStorageWrites.get(name);
      if (pending) {
        window.clearTimeout(pending.timer);
        pending.value = value;
        pending.resolvers.push(resolve);
        pending.rejectors.push(reject);
        pending.timer = window.setTimeout(() => persistPendingStorage(name), 450);
        return;
      }
      const timer = window.setTimeout(() => persistPendingStorage(name), 450);
      pendingStorageWrites.set(name, {
        value,
        timer,
        resolvers: [resolve],
        rejectors: [reject],
      });
    });
  },
  async removeItem(name) {
    window.localStorage.removeItem(name);
    const pending = pendingStorageWrites.get(name);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingStorageWrites.delete(name);
      pending.resolvers.forEach((resolve) => resolve());
    }
    if (isTauriDesktop) {
      await invoke("remove_studio_state", { namespace: name });
    }
  },
};

export async function exportDesktopProject(
  project: VideoProject,
): Promise<string | null> {
  if (!isTauriDesktop) return null;
  return invoke<string>("export_project_package", {
    projectId: project.id,
  });
}

export interface MissingAsset {
  assetId: string;
  source: string;
}

export async function scanDesktopProjectMissingAssets(
  project: VideoProject,
): Promise<MissingAsset[]> {
  if (!isTauriDesktop) return [];
  return invoke<MissingAsset[]>("scan_project_missing_assets", {
    projectJson: JSON.stringify({ ...project, isDemo: false }),
  });
}

export async function importDesktopProjectPackage(
  packagePath: string,
): Promise<VideoProject | null> {
  if (!isTauriDesktop) return null;
  return invoke<VideoProject>("import_project_package", { packagePath });
}

export async function getDesktopStoragePath(): Promise<string | null> {
  if (!isTauriDesktop) return null;
  try {
    return await invoke<string>("desktop_storage_path");
  } catch {
    return null;
  }
}
