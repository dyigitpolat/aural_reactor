import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProgress } from "@/store/progress";

interface ProjectMessage {
  type: string;
  [k: string]: unknown;
}

export function useProjectSocket(
  projectId: string | null,
  onMessage?: (msg: ProjectMessage) => void,
): void {
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  // Stable action references — selecting individual setters avoids re-renders.
  const update = useProgress((s) => s.update);
  const finish = useProgress((s) => s.finish);
  const fail = useProgress((s) => s.fail);

  useEffect(() => {
    if (!projectId) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/project/${projectId}`);
    wsRef.current = ws;

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ProjectMessage;

        switch (msg.type) {
          case "analyze_progress": {
            const frac = typeof msg.frac === "number" ? msg.frac : 0;
            const stage = typeof msg.stage === "string" ? msg.stage : "";
            update("analyze", frac, stage);
            break;
          }
          case "analyze_done": {
            finish("analyze");
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            queryClient.invalidateQueries({ queryKey: ["summary", projectId] });
            queryClient.invalidateQueries({ queryKey: ["sources", projectId] });
            queryClient.invalidateQueries({ queryKey: ["targets", projectId] });
            queryClient.invalidateQueries({ queryKey: ["bake", projectId] });
            break;
          }
          case "analyze_error": {
            fail("analyze", String(msg.error ?? "analysis failed"));
            break;
          }
          case "render_progress": {
            const frac = typeof msg.frac === "number" ? msg.frac : 0;
            const stage = typeof msg.stage === "string" ? msg.stage : "";
            update("render_export", frac, stage);
            break;
          }
          case "render_done": {
            finish("render_export");
            break;
          }
          case "render_error": {
            fail("render_export", String(msg.error ?? "render failed"));
            break;
          }
          // Arrange rewrites the EDL AND auto-regenerates patches, so both
          // the project cache and the bake cache need to be refreshed.
          case "arrange_done":
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            queryClient.invalidateQueries({ queryKey: ["bake", projectId] });
            break;
          // Patch / effect-chain / preset changes originate from a local
          // mutation that already wrote fresh data into the project cache
          // via setQueryData in its onSuccess. Invalidating ["project"] here
          // would just trigger a redundant GET refetch. Only the derived
          // bake (signals × patches) needs a fresh pull.
          case "patches_changed":
          case "effect_chain_changed":
          case "preset_applied":
            queryClient.invalidateQueries({ queryKey: ["bake", projectId] });
            break;
          // EDL-only mutation — the local client that fired the PUT already
          // has fresh project data via onSuccess setQueryData. Invalidating
          // ["project"] here would just trigger a redundant GET refetch.
          // We're a single-user local tool so we don't need to pick up edits
          // from other clients. No-op.
          case "edl_changed":
            break;
        }
        onMessage?.(msg);
      } catch {
        // ignore
      }
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [projectId, queryClient, onMessage, update, finish, fail]);
}
