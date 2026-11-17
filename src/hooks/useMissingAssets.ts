import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoProject } from "../types";
import { scanDesktopProjectMissingAssets } from "../services/desktop";

export function useMissingAssets(project: VideoProject | undefined) {
  const [missingIds, setMissingIds] = useState<Set<string>>(() => new Set());
  const [scanning, setScanning] = useState(false);
  const scanSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++scanSequence.current;
    if (!project) {
      setMissingIds(new Set());
      setScanning(false);
      return;
    }
    setScanning(true);
    try {
      const missing = await scanDesktopProjectMissingAssets(project);
      if (sequence === scanSequence.current) {
        setMissingIds(new Set(missing.map((item) => item.assetId)));
      }
    } catch {
      // A scanner failure must not hide otherwise usable in-memory assets.
      if (sequence === scanSequence.current) setMissingIds(new Set());
    } finally {
      if (sequence === scanSequence.current) setScanning(false);
    }
  }, [project]);

  useEffect(() => {
    const scheduled = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(scheduled);
  }, [refresh]);

  return {
    missingIds,
    scanning,
    refresh,
    markPresent(assetId: string) {
      setMissingIds((current) => {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
    },
    markMissing(assetId: string) {
      setMissingIds((current) => new Set(current).add(assetId));
    },
  };
}
