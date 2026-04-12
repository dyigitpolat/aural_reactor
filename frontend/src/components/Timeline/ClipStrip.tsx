import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Clip, Cut } from "@/api/client";
import { useEdlMutations } from "@/hooks/useEdlMutations";
import { useThumbnailCache } from "@/hooks/useThumbnailCache";
import { snapToBeat } from "@/lib/snap";
import { clipColor } from "@/lib/clipColor";
import { ClipCard } from "./ClipCard";

interface ClipStripProps {
  projectId: string | null;
  clips: Clip[];
  edl: Cut[];
  duration: number;
  beats: number[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  pxPerSecond: number;
  totalWidth: number;
  snapOn: boolean;
}

export function ClipStrip({
  projectId,
  clips,
  edl,
  duration,
  beats,
  selectedIndex,
  onSelect,
  pxPerSecond,
  totalWidth,
  snapOn,
}: ClipStripProps) {
  const mutations = useEdlMutations(projectId);
  const { getThumb, loaded: thumbsLoaded } = useThumbnailCache(projectId, clips);

  const clipById = useMemo(() => {
    const m = new Map<string, Clip>();
    for (const c of clips) m.set(c.id, c);
    return m;
  }, [clips]);

  // Build the slot layout. Each cut is its own card — no merging.
  // The index stored is the position in the SORTED edl array, which
  // matches the snapshot edl used by draftEdit during drags.
  const slots = useMemo(() => {
    type Slot =
      | { kind: "cut"; index: number; cut: Cut }
      | { kind: "gap"; tStart: number; tEnd: number };
    const out: Slot[] = [];
    const sorted = [...edl].sort((a, b) => a.t_start - b.t_start);
    let cursor = 0;
    for (let i = 0; i < sorted.length; i++) {
      const cut = sorted[i];
      if (cut.t_start - cursor > 0.001) {
        out.push({ kind: "gap", tStart: cursor, tEnd: cut.t_start });
      }
      out.push({ kind: "cut", index: i, cut });
      cursor = cut.t_end;
    }
    if (duration > 0 && duration - cursor > 0.001) {
      out.push({ kind: "gap", tStart: cursor, tEnd: duration });
    }
    return out;
  }, [edl, duration]);

  const maybeSnap = (t: number, shift: boolean): number => {
    if (!snapOn || shift) return t;
    return snapToBeat(t, beats, 0.12);
  };

  // Gap drop: insert a new cut filling the gap with the dropped clip.
  const handleGapDrop = (gapStart: number, gapEnd: number, clipId: string) => {
    const clip = clipById.get(clipId);
    if (!clip) return;
    mutations.insertCut({
      t_start: gapStart,
      t_end: gapEnd,
      clip_id: clipId,
      in_point: 0,
      speed: 1,
      locked: false,
    });
  };

  // Compute the previous/next cut t_end/t_start for trim-clamping.
  const sortedEdl = useMemo(() => [...edl].sort((a, b) => a.t_start - b.t_start), [edl]);

  // Anchor markers: start handle (draggable) + end handle (display only).
  // Start = first segment's t_start. End = start + clip duration.
  const anchorMarkers = useMemo(() => {
    const markers: { clipId: string; tStart: number; tEnd: number; lastSegEnd: number; color: string; firstIdx: number }[] = [];
    const byClip = new Map<string, { first: number; lastEnd: number; idx: number }>();
    const sorted = [...edl].sort((a, b) => a.t_start - b.t_start);
    for (let i = 0; i < sorted.length; i++) {
      const cut = sorted[i];
      const clip = clipById.get(cut.clip_id);
      if (!clip?.anchor) continue;
      const existing = byClip.get(cut.clip_id);
      if (!existing) {
        byClip.set(cut.clip_id, { first: cut.t_start, lastEnd: cut.t_end, idx: i });
      } else {
        existing.lastEnd = Math.max(existing.lastEnd, cut.t_end);
      }
    }
    for (const [clipId, info] of byClip) {
      const clip = clipById.get(clipId);
      if (!clip) continue;
      markers.push({
        clipId,
        tStart: info.first,
        tEnd: info.first + clip.duration,
        lastSegEnd: info.lastEnd,
        color: clipColor(clipId),
        firstIdx: info.idx,
      });
    }
    return markers;
  }, [edl, clipById]);

  const [anchorWall, setAnchorWall] = useState(0);

  const handleAnchorStartDrag = (marker: typeof anchorMarkers[0], e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const clip = clipById.get(marker.clipId);
    const clipDur = clip?.duration ?? Infinity;

    mutations.beginDragSession();

    const onMove = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - startX) / Math.max(1, pxPerSecond);
      let unclamped = marker.tStart + dxSec;
      unclamped = maybeSnap(unclamped, ev.shiftKey);

      // Wall: can't go below 0, and can't go so early that the clip
      // can't cover the last segment (lastSegEnd - clipDur).
      const minStart = Math.max(0, marker.lastSegEnd - clipDur);
      const newStart = Math.max(minStart, unclamped);

      // Wall pressure when pushing left past the limit.
      const push = Math.max(0, minStart - unclamped);
      const proxThreshold = 30 / Math.max(1, pxPerSecond);
      const prox = (newStart - minStart) < proxThreshold ? 1 - (newStart - minStart) / proxThreshold : 0;
      setAnchorWall(Math.max(prox * 0.4, push * 3));

      // Move only the first segment. Recalculate in_point for ALL
      // segments of this anchor clip relative to the new anchor start.
      const delta = newStart - marker.tStart;
      mutations.draftEdit((edl) => {
        const sorted = [...edl].sort((a, b) => a.t_start - b.t_start);
        return sorted.map((c, i) => {
          if (c.clip_id !== marker.clipId) return c;
          if (i === marker.firstIdx) {
            return { ...c, t_start: newStart, t_end: c.t_end + delta, in_point: 0 };
          }
          // Other segments: in_point = their t_start - new anchor start
          return { ...c, in_point: Math.max(0, c.t_start - newStart) };
        });
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      mutations.commitDragSession();
      setAnchorWall(0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="relative shrink-0" style={{ width: totalWidth }}>
      {/* Anchor start markers */}
      {anchorMarkers.map((m) => (
        <div key={`anchor-markers-${m.clipId}`}>
          {/* Start handle — draggable */}
          <div
            className="absolute z-20 cursor-ew-resize group/anchor"
            style={{
              left: m.tStart * pxPerSecond - 6,
              top: -2,
              bottom: -2,
              width: 12,
            }}
            onPointerDown={(e) => handleAnchorStartDrag(m, e)}
            title="Anchor start — drag to reposition the first segment"
          >
            <div
              className="absolute left-1/2 top-0 bottom-0 w-0.5 -translate-x-1/2"
              style={{ background: m.color }}
            />
            <div
              className="absolute left-1/2 -translate-x-1/2 -top-1 w-3 h-3 rounded-full border-2 opacity-70 group-hover/anchor:opacity-100 transition-opacity"
              style={{ background: m.color, borderColor: m.color }}
            />
            {/* Wall glow on left side when pushing past limit */}
            {anchorWall > 0.01 && (
              <div
                className="absolute top-0 bottom-0 -left-1 w-1 pointer-events-none"
                style={{
                  background: `rgba(250, 204, 21, ${Math.min(1, anchorWall)})`,
                  boxShadow: `0 0 ${Math.min(20, anchorWall * 20)}px ${Math.min(8, anchorWall * 8)}px rgba(250, 204, 21, ${Math.min(0.9, anchorWall * 0.9)})`,
                }}
              />
            )}
          </div>
          {/* End handle — display only */}
          <div
            className="absolute z-10 pointer-events-none"
            style={{
              left: m.tEnd * pxPerSecond - 1,
              top: -2,
              bottom: -2,
              width: 2,
            }}
            title={`Anchor end (${m.tEnd.toFixed(1)}s) — clip footage limit`}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-0.5 opacity-50"
              style={{ background: m.color, borderRight: `1px dashed ${m.color}` }}
            />
            <div
              className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-2 h-2 rounded-sm opacity-50"
              style={{ background: m.color }}
            />
          </div>
        </div>
      ))}

      <div
        className="flex items-stretch gap-0 surface rounded-sm"
        style={{ width: totalWidth, height: 86 }}
      >
        {slots.map((slot, i) => {
          if (slot.kind === "gap") {
            const gapWidth = (slot.tEnd - slot.tStart) * pxPerSecond;
            if (gapWidth < 2) return null;
            return (
              <GapSlot
                key={`gap-${i}-${slot.tStart.toFixed(3)}`}
                width={gapWidth}
                duration={slot.tEnd - slot.tStart}
                onDropClip={(clipId) => handleGapDrop(slot.tStart, slot.tEnd, clipId)}
              />
            );
          }

          const cutWidth = (slot.cut.t_end - slot.cut.t_start) * pxPerSecond;
          const idx = slot.index;
          const prevCut = idx > 0 ? sortedEdl[idx - 1] : null;
          const nextCut = idx + 1 < sortedEdl.length ? sortedEdl[idx + 1] : null;
          const minLeftBound = prevCut ? prevCut.t_end : 0;
          const maxRightBound = nextCut ? nextCut.t_start : duration;

          return (
            <ClipCard
              key={`cut-${idx}-${slot.cut.t_start.toFixed(3)}`}
              cut={slot.cut}
              index={idx}
              clip={clipById.get(slot.cut.clip_id)}
              selected={selectedIndex === idx}
              width={cutWidth}
              pxPerSecond={pxPerSecond}
              minTStart={minLeftBound}
              maxTEnd={maxRightBound}
              maybeSnap={maybeSnap}
              mutations={mutations}
              getThumb={getThumb}
              thumbsLoaded={thumbsLoaded}
              onSelect={() => onSelect(selectedIndex === idx ? null : idx)}
              onDropClip={(clipId) => mutations.replaceClipAt(idx, clipId)}
              onReplaceClick={() => {
                void launchReplacePicker(projectId, idx, mutations);
              }}
            />
          );
        })}
      </div>

    </div>
  );
}

// ─── Gap drop zone ────────────────────────────────────────────────────────

function GapSlot({
  width,
  duration,
  onDropClip,
}: {
  width: number;
  duration: number;
  onDropClip: (clipId: string) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={clsx(
        "shrink-0 h-full rounded-sm border border-dashed transition-colors grid place-items-center overflow-hidden",
        hover
          ? "border-accent bg-accent/10"
          : "border-zinc-800 bg-zinc-950/40",
      )}
      style={{ width }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-mvm-clip")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        setHover(false);
        const clipId = e.dataTransfer.getData("application/x-mvm-clip");
        if (clipId) {
          e.preventDefault();
          onDropClip(clipId);
        }
      }}
      title={`Empty · ${duration.toFixed(2)}s · drop a clip here`}
    >
      {width > 28 && (
        <span className="text-[9px] text-zinc-600 font-mono">
          {duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
}

// ─── Replace-by-upload flow ───────────────────────────────────────────────

async function launchReplacePicker(
  projectId: string | null,
  cutIndex: number,
  mutations: ReturnType<typeof useEdlMutations>,
): Promise<void> {
  if (!projectId) return;
  const file = await pickFile("video/*");
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/media/${projectId}/clips`, { method: "POST", body: fd });
  if (!res.ok) {
    alert(`upload failed: ${await res.text()}`);
    return;
  }
  const data = await res.json();
  const newClipId = data?.clip?.id;
  if (!newClipId) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  mutations.replaceClipAt(cutIndex, newClipId);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0] ?? null;
      resolve(f);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
