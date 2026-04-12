import { useState } from "react";
import clsx from "clsx";
import { X, Info } from "lucide-react";
import type { DiagnosticSnapshot, FrameReason } from "@/preview/PreviewEngine";

interface PreviewStatusOverlayProps {
  diagnostics: DiagnosticSnapshot | null;
  hasAudio: boolean;
  clipCount: number;
  audioAnalyzed: boolean;
}

type RowStatus = "ok" | "waiting" | "error" | "idle";

interface Row {
  label: string;
  value: string;
  status: RowStatus;
}

const STATUS_DOT: Record<RowStatus, string> = {
  ok: "bg-emerald-400",
  waiting: "bg-amber-400 animate-pulse",
  error: "bg-red-500",
  idle: "bg-zinc-600",
};

const REASON_LABEL: Record<FrameReason, string> = {
  ok: "rendering",
  "init-pending": "engine initializing",
  "init-failed": "engine init failed",
  "canvas-zero": "canvas is 0×0 (layout bug)",
  "no-cut": "no EDL cut at this time",
  "no-slot": "clip missing for active cut",
  "slot-not-ready": "video metadata still loading",
  "slot-readystate-low": "video buffer not ready",
  "slot-seeking": "video seeking",
  "upload-error": "texImage2D failed",
};

function rowsFrom(
  d: DiagnosticSnapshot | null,
  hasAudio: boolean,
  clipCount: number,
  audioAnalyzed: boolean,
): Row[] {
  const rows: Row[] = [];

  // Engine row.
  if (!d) {
    rows.push({ label: "engine", value: "mounting", status: "waiting" });
  } else if (d.initState.kind === "pending") {
    rows.push({ label: "engine", value: "initializing", status: "waiting" });
  } else if (d.initState.kind === "failed") {
    rows.push({ label: "engine", value: d.initState.error, status: "error" });
  } else {
    rows.push({ label: "engine", value: "ready", status: "ok" });
  }

  // Canvas row.
  if (d) {
    if (d.canvasSize.w < 2 || d.canvasSize.h < 2) {
      rows.push({ label: "canvas", value: "0×0 (layout bug)", status: "error" });
    } else {
      rows.push({
        label: "canvas",
        value: `${d.canvasSize.w}×${d.canvasSize.h}`,
        status: "ok",
      });
    }
  }

  // Audio row.
  rows.push({
    label: "audio",
    value: hasAudio ? (audioAnalyzed ? "analyzed" : "not analyzed") : "no file",
    status: hasAudio ? (audioAnalyzed ? "ok" : "waiting") : "idle",
  });

  // Clips row.
  if (d) {
    const total = d.videoSlots.length;
    const withErrors = d.videoSlots.filter((s) => s.lastError).length;
    const primed = d.videoSlots.filter((s) => s.primed).length;
    const metadata = d.videoSlots.filter((s) => s.metadata).length;
    if (clipCount === 0) {
      rows.push({ label: "clips", value: "no files", status: "idle" });
    } else if (withErrors > 0) {
      const firstErr =
        d.videoSlots.find((s) => s.lastError)?.lastError ?? "error";
      rows.push({
        label: "clips",
        value: `${withErrors}/${total} error · ${firstErr}`,
        status: "error",
      });
    } else if (primed === total && total > 0) {
      rows.push({ label: "clips", value: `${primed}/${total} primed`, status: "ok" });
    } else if (metadata > 0) {
      rows.push({
        label: "clips",
        value: `${primed}/${total} primed · ${metadata}/${total} loaded`,
        status: "waiting",
      });
    } else {
      rows.push({ label: "clips", value: `${total}/${total} loading`, status: "waiting" });
    }
  } else if (clipCount > 0) {
    rows.push({ label: "clips", value: `${clipCount} pending`, status: "waiting" });
  } else {
    rows.push({ label: "clips", value: "no files", status: "idle" });
  }

  // EDL row.
  if (d) {
    if (d.edlCutCount === 0) {
      rows.push({ label: "edl", value: "click Arrange", status: "idle" });
    } else {
      rows.push({ label: "edl", value: `${d.edlCutCount} cuts`, status: "ok" });
    }
  }

  // Active cut / frame stats row.
  if (d && d.initState.kind === "ready") {
    const isOk = d.lastSkipReason === "ok";
    const tc = d.activeCutTimecode;
    const tcStr = tc ? `${tc[0].toFixed(2)}s · clip ${tc[1].toFixed(2)}s` : "—";
    rows.push({
      label: "render",
      value: isOk
        ? `${tcStr} · ${d.framesRendered} frames`
        : `${REASON_LABEL[d.lastSkipReason] ?? d.lastSkipReason}` +
          (d.lastUploadError ? ` (${d.lastUploadError})` : ""),
      status: isOk ? "ok" : d.lastSkipReason === "no-cut" ? "idle" : "waiting",
    });
  }

  return rows;
}

export function PreviewStatusOverlay({
  diagnostics,
  hasAudio,
  clipCount,
  audioAnalyzed,
}: PreviewStatusOverlayProps) {
  const [collapsed, setCollapsed] = useState(false);

  const rows = rowsFrom(diagnostics, hasAudio, clipCount, audioAnalyzed);
  const allOk = rows.every((r) => r.status === "ok" || r.status === "idle");

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className={clsx(
          "absolute top-2 left-2 z-10 flex items-center gap-1 h-6 px-2",
          "rounded bg-zinc-950/70 border border-zinc-800/80 backdrop-blur-sm",
          "text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors",
        )}
        title="Show preview diagnostics"
      >
        <span className={clsx("h-1.5 w-1.5 rounded-full", allOk ? "bg-emerald-400" : "bg-amber-400")} />
        <Info className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div
      className={clsx(
        "absolute top-2 left-2 z-10 min-w-[240px] max-w-[360px]",
        "rounded-md bg-zinc-950/80 border border-zinc-800/80 backdrop-blur-sm",
        "shadow-xl px-2 py-1.5 font-mono text-[10px]",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] uppercase tracking-widest text-zinc-500">
          preview status
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
          title="Collapse"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span
              className={clsx("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT[row.status])}
            />
            <span className="w-12 shrink-0 text-zinc-500">{row.label}</span>
            <span
              className={clsx(
                "flex-1 min-w-0 truncate",
                row.status === "error" ? "text-red-400" : "text-zinc-200",
              )}
              title={row.value}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
