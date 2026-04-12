import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Cut, type Project } from "@/api/client";

/**
 * EDL mutation layer with optimistic updates and drag-session batching.
 *
 * Non-drag helpers (replaceClipAt, deleteCutAt, insertCut, toggleLockAt, ...):
 *   → immediate PUT, optimistic cache update, rollback on error.
 *
 * Drag helpers (beginDragSession / draftEdit / commitDragSession):
 *   → during a drag, edits only touch the local React Query cache.
 *     One single PUT fires on commit (pointerup).
 *
 * This keeps a 2-second trim-handle drag at ~1 network request instead of
 * the previous ~120+ PUTs (one per pointermove) which was saturating the
 * backend and racing with itself.
 */
export function useEdlMutations(projectId: string | null) {
  const queryClient = useQueryClient();
  const dragSnapshot = useRef<Project | null>(null);
  const inDragSession = useRef(false);

  const put = useMutation({
    mutationFn: async (edl: Cut[]) => {
      if (!projectId) throw new Error("no project");
      return api.updateEdl(projectId, edl);
    },
    onMutate: async (edl) => {
      if (!projectId) return { prev: null };
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });
      const prev = queryClient.getQueryData<Project>(["project", projectId]);
      if (prev) {
        queryClient.setQueryData<Project>(["project", projectId], {
          ...prev,
          edl,
        });
      }
      return { prev };
    },
    onError: (_err, _edl, ctx) => {
      if (projectId && ctx?.prev) {
        queryClient.setQueryData(["project", projectId], ctx.prev);
      }
    },
    onSuccess: (project) => {
      if (!projectId) return;
      queryClient.setQueryData(["project", projectId], project);
      // Bake is derived from (signals × patches), not from the EDL — see the
      // earlier storm fix. Never invalidate ["bake"] from an EDL mutation.
    },
  });

  /** Apply a pure-function edit to the current EDL and fire one PUT. */
  const edit = (fn: (edl: Cut[]) => Cut[]): void => {
    const project = queryClient.getQueryData<Project>(["project", projectId ?? ""]);
    if (!project) return;
    const next = fn(project.edl ?? []);
    put.mutate(next);
  };

  return {
    /** Replace the whole EDL. */
    setEdl: (edl: Cut[]) => put.mutate(edl),

    /** Replace the clip_id of one cut at `index`. */
    replaceClipAt: (index: number, clipId: string) =>
      edit((edl) => edl.map((c, i) => (i === index ? { ...c, clip_id: clipId } : c))),

    /** Trim one cut's boundaries on the song timeline. */
    trimCutAt: (index: number, tStart: number, tEnd: number) =>
      edit((edl) =>
        edl.map((c, i) =>
          i === index ? { ...c, t_start: tStart, t_end: tEnd } : c,
        ),
      ),

    /** Update the in-point of one cut (which part of the source clip plays). */
    setInPointAt: (index: number, inPoint: number) =>
      edit((edl) =>
        edl.map((c, i) => (i === index ? { ...c, in_point: inPoint } : c)),
      ),

    /** Remove one cut — leaves a gap (no neighbor extension). */
    deleteCutAt: (index: number) =>
      edit((edl) => edl.filter((_, i) => i !== index)),

    /** Insert a cut (e.g. filling a gap from a drag-drop). */
    insertCut: (cut: Cut) =>
      edit((edl) => [...edl, cut].sort((a, b) => a.t_start - b.t_start)),

    /** Toggle the locked flag on one cut. */
    toggleLockAt: (index: number) =>
      edit((edl) =>
        edl.map((c, i) => (i === index ? { ...c, locked: !c.locked } : c)),
      ),

    // ─── Drag session — for trim handles + ClipSourcePicker ──────────────

    /** Snapshot the current EDL (sorted) so a cancel can restore it.
     *  Sorting ensures the index from ClipStrip's sorted slots matches. */
    beginDragSession: () => {
      if (!projectId) return;
      const proj = queryClient.getQueryData<Project>(["project", projectId]);
      if (proj) {
        dragSnapshot.current = {
          ...proj,
          edl: [...(proj.edl ?? [])].sort((a, b) => a.t_start - b.t_start),
        };
      }
      inDragSession.current = true;
    },

    /**
     * Apply an edit during a drag. When inside a drag session, `fn`
     * receives the SNAPSHOT edl (frozen at beginDragSession), not the
     * current cache. Each pointermove computes the absolute target state
     * from the frozen snapshot, so the fn's matchers always see the
     * original t_start values — no incremental drift, no match failures.
     */
    draftEdit: (fn: (edl: Cut[]) => Cut[]) => {
      if (!projectId) return;
      const base = inDragSession.current && dragSnapshot.current
        ? dragSnapshot.current
        : queryClient.getQueryData<Project>(["project", projectId]);
      if (!base) return;
      const next = fn(base.edl ?? []);
      queryClient.setQueryData<Project>(["project", projectId], {
        ...base,
        edl: next,
      });
    },

    /** Fire exactly ONE PUT with the current cached EDL. */
    commitDragSession: () => {
      if (!projectId) return;
      const project = queryClient.getQueryData<Project>(["project", projectId]);
      if (project && inDragSession.current) {
        put.mutate(project.edl ?? []);
      }
      dragSnapshot.current = null;
      inDragSession.current = false;
    },

    /** Abort a drag without sending to the backend. */
    cancelDragSession: () => {
      if (projectId && dragSnapshot.current) {
        queryClient.setQueryData(["project", projectId], dragSnapshot.current);
      }
      dragSnapshot.current = null;
      inDragSession.current = false;
    },

    isPending: put.isPending,
  };
}
