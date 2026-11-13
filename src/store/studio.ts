import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  Asset,
  CreateProjectInput,
  ProviderProfile,
  ProviderCapability,
  SubtitleCue,
  TimelineClip,
  ToastMessage,
  VideoProject,
} from "../types";
import {
  createProject,
  createScene,
  createTimeline,
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
  updateProject: (
    id: string,
    patch: Partial<VideoProject> | ((project: VideoProject) => VideoProject),
  ) => void;
  deleteProject: (id: string) => void;
  duplicateProject: (id: string) => string;
  addScene: (projectId: string) => string;
  reorderScenes: (projectId: string, from: number, to: number) => void;
  addAsset: (projectId: string, asset: Asset) => void;
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
      version: 2,
      storage: createJSONStorage(() => studioStorage),
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<StudioState>;
        if (
          version < 2 &&
          !state.projects?.some((project) => project.id === skyMvp.id)
        ) {
          return {
            ...state,
            projects: [skyMvp, ...(state.projects ?? [])],
          };
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
