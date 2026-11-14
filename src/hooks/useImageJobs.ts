import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, ImageJob } from "../types";
import type { ImageGenerationRequestInput } from "../services/capabilities";
import { flushDesktopStorage, isTauriDesktop } from "../services/desktop";
import { useStudioStore } from "../store/studio";
import {
  cancelImageJob,
  clearImageJobs,
  enqueueImageJobs,
  listImageJobs,
  listenImageJobs,
  retryImageJob,
} from "../services/imageQueue";

interface ImageJobOptions {
  /** 项目里已有的素材，用于避免历史任务被重复合并。 */
  hasAsset: (assetId: string) => boolean;
  onAssets: (assets: Asset[]) => void;
}

const mergedJobs = new Set<string>();

export function useImageJobs(
  projectId: string | undefined,
  options: ImageJobOptions,
) {
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const hasAssetRef = useRef(options.hasAsset);
  const onAssetsRef = useRef(options.onAssets);

  useEffect(() => {
    hasAssetRef.current = options.hasAsset;
    onAssetsRef.current = options.onAssets;
  });

  const mergeCompleted = useCallback((job: ImageJob) => {
    if (job.status !== "completed" || !job.assets.length) return;
    if (mergedJobs.has(job.id)) return;
    mergedJobs.add(job.id);
    const missing = job.assets.filter(
      (asset) => asset?.id && !hasAssetRef.current(asset.id),
    );
    if (missing.length) onAssetsRef.current(missing);
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId || !isTauriDesktop) return;
    try {
      const next = await listImageJobs(projectId);
      setJobs(next);
      next.forEach(mergeCompleted);
    } catch (error) {
      console.error("Unable to load image job queue", error);
    }
  }, [projectId, mergeCompleted]);

  useEffect(() => {
    // 等待 zustand 完成持久化再合并历史任务，避免用初始示例项目覆盖真实素材判断。
    const persistApi = useStudioStore.persist;
    if (persistApi.hasHydrated()) {
      const timer = window.setTimeout(() => void refresh(), 0);
      return () => window.clearTimeout(timer);
    }
    return persistApi.onFinishHydration(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (!projectId || !isTauriDesktop) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenImageJobs((job) => {
      if (!active || job.projectId !== projectId) return;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      mergeCompleted(job);
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch((error) => console.error("Unable to subscribe image jobs", error));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [projectId, mergeCompleted]);

  const enqueue = useCallback(
    async (requests: ImageGenerationRequestInput[]) => {
      // 先把项目与参考图落盘，队列 worker 只读磁盘素材。
      await flushDesktopStorage();
      const created = await enqueueImageJobs(requests);
      setJobs((current) => [
        ...created,
        ...current.filter((item) => !created.some((job) => job.id === item.id)),
      ]);
      return created;
    },
    [],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      await cancelImageJob(jobId);
      await refresh();
    },
    [refresh],
  );

  const retry = useCallback(
    async (jobId: string) => {
      await retryImageJob(jobId);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    if (!projectId) return;
    await clearImageJobs(projectId);
    await refresh();
  }, [projectId, refresh]);

  const activeCount = jobs.filter(
    (job) => job.status === "pending" || job.status === "running",
  ).length;

  return { jobs, activeCount, refresh, enqueue, cancel, retry, clear };
}
