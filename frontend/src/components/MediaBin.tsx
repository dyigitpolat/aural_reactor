import { Film, Trash2, GripVertical } from "lucide-react";
import clsx from "clsx";
import type { Clip } from "@/api/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Project } from "@/api/client";
import { clipColor } from "@/lib/clipColor";

interface MediaBinProps {
  projectId: string | null;
  clips: Clip[];
}

export function MediaBin({ projectId, clips }: MediaBinProps) {
  const queryClient = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: (clipId: string) => api.deleteClip(projectId!, clipId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const toggleMut = useMutation({
    mutationFn: (args: { clipId: string; next: boolean }) =>
      api.patchClip(projectId!, args.clipId, { auto_arrange: args.next }),
    onMutate: async ({ clipId, next }) => {
      if (!projectId) return;
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });
      const prev = queryClient.getQueryData<Project>(["project", projectId]);
      if (prev) {
        queryClient.setQueryData<Project>(["project", projectId], {
          ...prev,
          clips: prev.clips.map((c) =>
            c.id === clipId ? { ...c, auto_arrange: next } : c,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _args, ctx) => {
      if (projectId && ctx?.prev) {
        queryClient.setQueryData(["project", projectId], ctx.prev);
      }
    },
    onSuccess: (project) => {
      if (projectId) queryClient.setQueryData(["project", projectId], project);
    },
  });

  return (
    <aside className="surface h-full flex flex-col min-w-0">
      <div className="px-3 py-2 border-b border-zinc-800/80 flex items-center gap-2">
        <Film className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-xs font-medium text-zinc-300">Clips ({clips.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 no-scrollbar">
        {clips.length === 0 && (
          <div className="text-xs text-zinc-500 text-center py-6">No clips yet.</div>
        )}
        {clips.map((clip) => {
          const enabled = clip.auto_arrange;
          return (
            <div
              key={clip.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/x-mvm-clip", clip.id);
              }}
              className={clsx(
                "group flex items-center gap-1.5 px-1.5 py-1.5 rounded transition-colors",
                "bg-zinc-900/60 hover:bg-zinc-900",
                "cursor-grab active:cursor-grabbing",
              )}
              style={{ borderLeft: `4px solid ${clipColor(clip.id)}` }}
              title="Drag onto the clip strip to place manually"
            >
              <GripVertical className="h-3 w-3 text-zinc-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{clip.filename}</div>
                <div className="text-[10px] text-zinc-500 tabular-nums">
                  {clip.duration.toFixed(1)}s · {clip.width}×{clip.height}
                  <span className="ml-1">
                    energy{" "}
                    <span
                      className="inline-block w-8 h-1 align-middle rounded-full overflow-hidden bg-zinc-800"
                      title={clip.motion_energy.toFixed(3)}
                    >
                      <span
                        className="block h-full bg-accent"
                        style={{ width: `${Math.round(clip.motion_energy * 100)}%` }}
                      />
                    </span>
                  </span>
                </div>
              </div>

              <button
                onClick={() =>
                  toggleMut.mutate({ clipId: clip.id, next: !enabled })
                }
                title={
                  enabled
                    ? "Included in auto-arrange (click to exclude)"
                    : "Held for manual placement (click to include)"
                }
                className={clsx(
                  "shrink-0 h-5 px-1.5 rounded text-[9px] font-medium transition-colors",
                  enabled
                    ? "bg-accent/20 text-accent border border-accent/50"
                    : "bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300",
                )}
              >
                {enabled ? "auto" : "manual"}
              </button>

              <button
                onClick={() => {
                  if (!projectId) return;
                  const body: { anchor: boolean; auto_arrange?: boolean } = { anchor: !clip.anchor };
                  if (!clip.anchor) body.auto_arrange = true;
                  api.patchClip(projectId, clip.id, body).then(() =>
                    queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
                  );
                }}
                title={
                  clip.anchor
                    ? "Anchor: footage synced to song position (click to unanchor)"
                    : "Not anchored (click to anchor — footage syncs to song time)"
                }
                className={clsx(
                  "shrink-0 h-5 w-5 grid place-items-center rounded text-[9px] font-medium transition-colors",
                  clip.anchor
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50"
                    : "bg-zinc-800 text-zinc-600 border border-zinc-700 hover:text-zinc-400",
                )}
              >
                A
              </button>

              <button
                onClick={() => deleteMut.mutate(clip.id)}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 transition-opacity shrink-0"
                title="Delete clip"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
