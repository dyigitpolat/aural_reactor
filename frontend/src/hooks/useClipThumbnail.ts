import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/** Returns a stable URL for a clip thumbnail at (projectId, clipId, in_point).
 *  Because the backend caches the JPEG on disk by (clip_id, t, w), the URL
 *  itself is stable and the browser/CDN layer handles caching — we only use
 *  TanStack Query here so concurrent hook calls share a single fetch.
 */
export function useClipThumbnail(
  projectId: string | null,
  clipId: string,
  inPoint: number,
  width = 160,
) {
  const url = projectId ? api.thumbnailUrl(projectId, clipId, inPoint, width) : "";
  return useQuery({
    queryKey: ["thumb", projectId, clipId, Math.round(inPoint * 10), width],
    queryFn: async () => {
      // Fetch head only to warm the backend cache; we still use the raw URL
      // in an <img> for rendering so the browser handles cache/headers.
      const res = await fetch(url);
      if (!res.ok) throw new Error("thumb fetch failed");
      return url;
    },
    enabled: !!projectId && !!clipId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  });
}
