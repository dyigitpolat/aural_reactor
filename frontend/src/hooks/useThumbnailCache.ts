import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Clip } from "@/api/client";

/**
 * Preloads thumbnails for all clips at 1-second intervals and caches them
 * as blob URLs. Returns a lookup function `getThumb(clipId, t) → blobUrl`.
 *
 * Thumbnails are fetched ONCE per clip on mount (or when clips change).
 * ClipCard uses `getThumb` instead of `<img src={api.thumbnailUrl(...)}>`,
 * eliminating per-card API requests entirely.
 */
export function useThumbnailCache(
  projectId: string | null,
  clips: Clip[],
) {
  const [cache, setCache] = useState<Map<string, string>>(new Map());
  const loadingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!projectId || clips.length === 0) return;
    let cancelled = false;

    const loadClip = async (clip: Clip) => {
      const seconds = Math.max(1, Math.floor(clip.duration));
      const batch: Promise<void>[] = [];

      for (let t = 0; t < seconds; t++) {
        const key = `${clip.id}:${t}`;
        if (loadingRef.current.has(key)) continue;
        loadingRef.current.add(key);

        const url = api.thumbnailUrl(projectId, clip.id, t, 120);
        batch.push(
          fetch(url)
            .then((res) => (res.ok ? res.blob() : null))
            .then((blob) => {
              if (cancelled || !blob) return;
              const blobUrl = URL.createObjectURL(blob);
              setCache((prev) => {
                const next = new Map(prev);
                next.set(key, blobUrl);
                return next;
              });
            })
            .catch(() => {}),
        );

        if (batch.length >= 8) {
          await Promise.all(batch.splice(0));
        }
      }
      await Promise.all(batch);
    };

    for (const clip of clips) {
      loadClip(clip);
    }

    return () => {
      cancelled = true;
    };
  }, [projectId, clips.map((c) => c.id).join(",")]);

  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const getThumb = useCallback((clipId: string, t: number): string | undefined => {
    const c = cacheRef.current;
    const sec = Math.max(0, Math.floor(t));
    const exact = c.get(`${clipId}:${sec}`);
    if (exact) return exact;
    for (let d = 1; d <= 5; d++) {
      const lo = c.get(`${clipId}:${Math.max(0, sec - d)}`);
      if (lo) return lo;
      const hi = c.get(`${clipId}:${sec + d}`);
      if (hi) return hi;
    }
    for (const [k, v] of c) {
      if (k.startsWith(`${clipId}:`)) return v;
    }
    return undefined;
  }, []);

  return { getThumb, loaded: cache.size };
}
