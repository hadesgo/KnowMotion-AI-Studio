import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  Asset,
  CharacterProfile,
  CreateProjectInput,
  LocationProfile,
  ProviderProfile,
  ProviderCapability,
  StyleLock,
  SubtitleCue,
  TimelineClip,
  ToastMessage,
  VideoProject,
} from "../types";
import {
  createProject,
  createScene,
  createTimeline,
  defaultStyleLock,
  makeSkyBlueProject,
  makeSampleProject,
} from "../data/demo";
import { makeId, nowIso } from "../utils";
import { studioStorage } from "../services/desktop";

interface StudioState {
  projects: VideoProject[];
  providers: ProviderProfile[];
  taskRoutes: Partial<Record<ProviderCapability, string>>;
  toasts: ToastMessage[];
  assistantOpen: boolean;
  createProject: (input: CreateProjectInput) => string;
  addProject: (project: VideoProject) => void;
  updateProject: (
    id: string,
    patch: Partial<VideoProject> | ((project: VideoProject) => VideoProject),
  ) => void;
  deleteProject: (id: string) => void;
  duplicateProject: (id: string) => string;
  addScene: (projectId: string) => string;
  reorderScenes: (projectId: string, from: number, to: number) => void;
  addAsset: (projectId: string, asset: Asset) => void;
  upsertCharacter: (projectId: string, character: CharacterProfile) => void;
  removeCharacter: (projectId: string, characterId: string) => void;
  upsertLocation: (projectId: string, location: LocationProfile) => void;
  removeLocation: (projectId: string, locationId: string) => void;
  updateStyleLock: (projectId: string, patch: Partial<StyleLock>) => void;
  attachReference: (projectId: string, asset: Asset) => void;
  updateReferenceAsset: (
    projectId: string,
    assetId: string,
    patch: Partial<Asset>,
  ) => void;
  removeReferenceAsset: (projectId: string, assetId: string) => void;
  setSceneAnchors: (
    projectId: string,
    sceneId: string,
    patch: { characterIds?: string[]; locationId?: string },
  ) => void;
  addTimelineClip: (projectId: string, clip: TimelineClip) => void;
  updateTimelineClip: (
    projectId: string,
    clipId: string,
    patch: Partial<TimelineClip>,
  ) => void;
  removeTimelineClip: (projectId: string, clipId: string) => void;
  replaceSubtitles: (projectId: string, subtitles: SubtitleCue[]) => void;
  addProvider: (provider: ProviderProfile) => void;
  updateProvider: (id: string, patch: Partial<ProviderProfile>) => void;
  deleteProvider: (id: string) => void;
  setTaskRoute: (capability: ProviderCapability, providerId: string) => void;
  setAssistantOpen: (value: boolean) => void;
  pushToast: (toast: Omit<ToastMessage, "id">) => void;
  dismissToast: (id: string) => void;
}

const sample = makeSampleProject();
const skyMvp = makeSkyBlueProject();

/**
 * 历史项目（v2 及磁盘上的旧 project.json）没有设定集字段。
 * 统一在此回填，避免每个页面重复判空。
 */
export function withConsistencyDefaults(project: VideoProject): VideoProject {
  return {
    ...project,
    characters: project.characters ?? [],
    locations: project.locations ?? [],
    styleLock:
      project.styleLock ?? defaultStyleLock(project.settings?.style ?? ""),
    scenes: (project.scenes ?? []).map((scene) => ({
      ...scene,
      characterIds: scene.characterIds ?? [],
    })),
  };
}

const defaultProviders: ProviderProfile[] = [
  {
    id: makeId("provider"),
    name: "Local Ollama",
    protocol: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:8b",
    contextSize: 8192,
    inferenceBackend: "auto",
    capabilities: ["LLM"],
    enabled: true,
    health: "unchecked",
    hasSecret: false,
    isDefault: true,
  },
];

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      projects: [skyMvp, sample],
      providers: defaultProviders,
      taskRoutes: {
        LLM: defaultProviders[0].id,
      },
      toasts: [],
      assistantOpen: false,
      createProject: (input) => {
        const project = createProject(input);
        set((state) => ({
          projects: [project, ...state.projects],
        }));
        return project.id;
      },
      addProject: (project) => {
        set((state) => ({
          projects: [
            project,
            ...state.projects.filter((item) => item.id !== project.id),
          ],
        }));
      },
      updateProject: (id, patch) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== id) return project;
            const next =
              typeof patch === "function" ? patch(project) : { ...project, ...patch };
            return { ...next, updatedAt: nowIso() };
          }),
        }));
      },
      deleteProject: (id) => {
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== id),
        }));
      },
      duplicateProject: (id) => {
        const original = get().projects.find((project) => project.id === id);
        if (!original) return "";
        const copy: VideoProject = {
          ...structuredClone(original),
          id: makeId("project"),
          title: `${original.title} 副本`,
          isDemo: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        set((state) => ({ projects: [copy, ...state.projects] }));
        return copy.id;
      },
      addScene: (projectId) => {
        const scene = createScene(
          "新的知识场景",
          "从这里开始写下这一场景要讲的旁白。",
          5,
          get().projects.find((project) => project.id === projectId)?.scenes
            .length ?? 0,
        );
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  scenes: [...project.scenes, scene],
                  timeline: [
                    ...project.timeline,
                    {
                      id: makeId("clip"),
                      track: "video" as const,
                      sceneId: scene.id,
                      label: scene.title,
                      start: project.scenes.reduce(
                        (sum, item) => sum + item.duration,
                        0,
                      ),
                      duration: scene.duration,
                      color: scene.accent,
                    },
                  ],
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
        return scene.id;
      },
      reorderScenes: (projectId, from, to) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const scenes = [...project.scenes];
            const [moved] = scenes.splice(from, 1);
            scenes.splice(to, 0, moved);
            const order = new Map(scenes.map((scene, index) => [scene.id, index]));
            const timeline = [...project.timeline]
              .filter((clip) => clip.track !== "video")
              .concat(
                scenes.map((scene, index) => ({
                  id: makeId("clip"),
                  track: "video" as const,
                  sceneId: scene.id,
                  label: `${String(index + 1).padStart(2, "0")} ${scene.title}`,
                  start: scenes
                    .slice(0, index)
                    .reduce((sum, item) => sum + item.duration, 0),
                  duration: scene.duration,
                  color: scene.accent,
                })),
              );
            void order;
            return { ...project, scenes, timeline, updatedAt: nowIso() };
          }),
        }));
      },
      addAsset: (projectId, asset) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  assets: [asset, ...project.assets],
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      upsertCharacter: (projectId, character) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const exists = project.characters.some(
              (item) => item.id === character.id,
            );
            return {
              ...project,
              characters: exists
                ? project.characters.map((item) =>
                    item.id === character.id
                      ? { ...character, updatedAt: nowIso() }
                      : item,
                  )
                : [...project.characters, character],
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      removeCharacter: (projectId, characterId) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            return {
              ...project,
              characters: project.characters.filter(
                (item) => item.id !== characterId,
              ),
              assets: project.assets.filter(
                (asset) =>
                  !(
                    asset.reference?.role === "character" &&
                    asset.reference.entityId === characterId
                  ),
              ),
              scenes: project.scenes.map((scene) => ({
                ...scene,
                characterIds: (scene.characterIds ?? []).filter(
                  (id) => id !== characterId,
                ),
              })),
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      upsertLocation: (projectId, location) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const exists = project.locations.some(
              (item) => item.id === location.id,
            );
            return {
              ...project,
              locations: exists
                ? project.locations.map((item) =>
                    item.id === location.id
                      ? { ...location, updatedAt: nowIso() }
                      : item,
                  )
                : [...project.locations, location],
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      removeLocation: (projectId, locationId) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            return {
              ...project,
              locations: project.locations.filter(
                (item) => item.id !== locationId,
              ),
              assets: project.assets.filter(
                (asset) =>
                  !(
                    asset.reference?.role === "location" &&
                    asset.reference.entityId === locationId
                  ),
              ),
              scenes: project.scenes.map((scene) =>
                scene.locationId === locationId
                  ? { ...scene, locationId: undefined }
                  : scene,
              ),
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      updateStyleLock: (projectId, patch) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  styleLock: { ...project.styleLock, ...patch },
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      attachReference: (projectId, asset) => {
        const meta = asset.reference;
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const link = (ids: string[]) =>
              ids.includes(asset.id) ? ids : [...ids, asset.id];
            const characters = project.characters.map((character) =>
              meta?.role === "character" && character.id === meta.entityId
                ? {
                    ...character,
                    referenceAssetIds: link(character.referenceAssetIds),
                    updatedAt: nowIso(),
                  }
                : character,
            );
            const locations = project.locations.map((location) =>
              meta?.role === "location" && location.id === meta.entityId
                ? {
                    ...location,
                    referenceAssetIds: link(location.referenceAssetIds),
                    updatedAt: nowIso(),
                  }
                : location,
            );
            const styleLock =
              meta?.role === "style"
                ? {
                    ...project.styleLock,
                    referenceAssetIds: link(project.styleLock.referenceAssetIds),
                  }
                : project.styleLock;
            return {
              ...project,
              assets: [asset, ...project.assets],
              characters,
              locations,
              styleLock,
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      updateReferenceAsset: (projectId, assetId, patch) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  assets: project.assets.map((asset) =>
                    asset.id === assetId
                      ? {
                          ...asset,
                          ...patch,
                          reference: patch.reference
                            ? { ...asset.reference, ...patch.reference }
                            : asset.reference,
                        }
                      : asset,
                  ),
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      removeReferenceAsset: (projectId, assetId) => {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const detach = (ids: string[]) =>
              ids.filter((id) => id !== assetId);
            return {
              ...project,
              assets: project.assets.filter((asset) => asset.id !== assetId),
              characters: project.characters.map((character) => ({
                ...character,
                referenceAssetIds: detach(character.referenceAssetIds),
              })),
              locations: project.locations.map((location) => ({
                ...location,
                referenceAssetIds: detach(location.referenceAssetIds),
              })),
              styleLock: {
                ...project.styleLock,
                referenceAssetIds: detach(project.styleLock.referenceAssetIds),
              },
              updatedAt: nowIso(),
            };
          }),
        }));
      },
      setSceneAnchors: (projectId, sceneId, patch) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  scenes: project.scenes.map((scene) =>
                    scene.id === sceneId ? { ...scene, ...patch } : scene,
                  ),
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      addTimelineClip: (projectId, clip) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  timeline: [...project.timeline, clip],
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      updateTimelineClip: (projectId, clipId, patch) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  timeline: project.timeline.map((clip) =>
                    clip.id === clipId ? { ...clip, ...patch } : clip,
                  ),
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      removeTimelineClip: (projectId, clipId) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  timeline: project.timeline.filter((clip) => clip.id !== clipId),
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      replaceSubtitles: (projectId, subtitles) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? { ...project, subtitles, updatedAt: nowIso() }
              : project,
          ),
        }));
      },
      addProvider: (provider) => {
        set((state) => ({ providers: [...state.providers, provider] }));
      },
      updateProvider: (id, patch) => {
        set((state) => ({
          providers: state.providers.map((provider) =>
            provider.id === id ? { ...provider, ...patch } : provider,
          ),
        }));
      },
      deleteProvider: (id) => {
        set((state) => ({
          providers: state.providers.filter((provider) => provider.id !== id),
          taskRoutes: Object.fromEntries(
            Object.entries(state.taskRoutes).filter(([, value]) => value !== id),
          ),
        }));
      },
      setTaskRoute: (capability, providerId) => {
        set((state) => ({
          taskRoutes: { ...state.taskRoutes, [capability]: providerId },
        }));
      },
      setAssistantOpen: (value) => set({ assistantOpen: value }),
      pushToast: (toast) => {
        const id = makeId("toast");
        set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
        window.setTimeout(() => {
          set((state) => ({
            toasts: state.toasts.filter((item) => item.id !== id),
          }));
        }, toast.type === "error" ? 6000 : 3200);
      },
      dismissToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter((toast) => toast.id !== id),
        })),
    }),
    {
      name: "knowmotion-studio-v1",
      version: 3,
      storage: createJSONStorage(() => studioStorage),
      merge: (persistedState, currentState) => {
        const state = (persistedState ?? {}) as Partial<StudioState>;
        return {
          ...currentState,
          ...state,
          projects: (state.projects ?? currentState.projects).map(
            withConsistencyDefaults,
          ),
          providers: state.providers ?? currentState.providers,
          taskRoutes: state.taskRoutes ?? currentState.taskRoutes,
        };
      },
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<StudioState>;
        const projects =
          version < 2 &&
          !state.projects?.some((project) => project.id === skyMvp.id)
            ? [skyMvp, ...(state.projects ?? [])]
            : (state.projects ?? []);
        if (version < 3) {
          return { ...state, projects: projects.map(withConsistencyDefaults) };
        }
        return state;
      },
      partialize: (state) => ({
        projects: state.projects,
        providers: state.providers,
        taskRoutes: state.taskRoutes,
      }),
    },
  ),
);

export function cloneTimeline(project: VideoProject): TimelineClip[] {
  return createTimeline(project.scenes);
}
