import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Lock, Unlock, Trash2, Replace, Scissors } from "lucide-react";
import type { Clip, Cut } from "@/api/client";
import type { useEdlMutations } from "@/hooks/useEdlMutations";
import { clipColor } from "@/lib/clipColor";

interface ClipCardProps {
  cut: Cut;
  index: number;
  clip: Clip | undefined;
  selected: boolean;
  width: number;
  pxPerSecond: number;
  minTStart: number;
  maxTEnd: number;
  maybeSnap: (t: number, shift: boolean) => number;
  mutations: ReturnType<typeof useEdlMutations>;
  getThumb: (clipId: string, t: number) => string | undefined;
  thumbsLoaded: number;
  onSelect: () => void;
  onDropClip: (clipId: string) => void;
  onReplaceClick: () => void;
}

const HANDLE_WIDTH = 8;

const HOLD_MS = 180;
const MOVE_THRESHOLD_PX = 6;
const SOURCE_STRIP_H = 14;

export function ClipCard({
  cut,
  index,
  clip,
  selected,
  width,
  pxPerSecond,
  minTStart,
  maxTEnd,
  maybeSnap,
  mutations,
  getThumb,
  thumbsLoaded,
  onSelect,
  onDropClip,
  onReplaceClick,
}: ClipCardProps) {
  const duration = cut.t_end - cut.t_start;
  const displayName = clip?.filename ?? "(missing)";
  const clipDuration = clip?.duration ?? 0;
  const isAnchor = clip?.anchor ?? false;

  // Filmstrip: thumbnail URLs snapped to 1-second grid so the browser
  // Filmstrip: square thumbnails (1:1 aspect ratio) tiled across the card.
  // thumbSize matches the filmstrip area height. frameCount fills the width.
  const THUMB_SIZE = 52;
  const frameCount = Math.max(1, Math.ceil(width / THUMB_SIZE));
  const filmstrip = useMemo(() => {
    if (!clip) return [];
    const inPt = cut.in_point;
    const dur = cut.t_end - cut.t_start;
    const frames: { sec: number; url: string | undefined }[] = [];
    for (let i = 0; i < frameCount; i++) {
      let t = inPt + ((i + 0.5) / frameCount) * dur;
      if (clip.duration > 0.1) t = t % clip.duration;
      const sec = Math.max(0, Math.floor(t));
      frames.push({ sec, url: getThumb(clip.id, sec) });
    }
    return frames;
  }, [clip?.id, clip?.duration, Math.floor(cut.in_point), Math.ceil(cut.in_point + duration), frameCount, getThumb, thumbsLoaded]);

  // Detect if the cut extends past the source clip (will loop in preview).
  // Compute the pixel positions of each loop boundary.
  const loopMarkers = useMemo(() => {
    if (!clip || clip.duration <= 0 || isAnchor) return [];
    const sourceEnd = clip.duration - cut.in_point;
    if (sourceEnd >= duration) return [];
    const markers: number[] = [];
    let t = sourceEnd;
    while (t < duration) {
      markers.push((t / duration) * width);
      t += clip.duration;
    }
    return markers;
  }, [clip, cut.in_point, duration, width, isAnchor]);

  const cardRef = useRef<HTMLDivElement>(null);
  const [splitHoverX, setSplitHoverX] = useState<number | null>(null);
  // Wall pressure: 0 = not pushing, >0 = pushing past boundary. Used for visual cue.
  const [wallPressure, setWallPressure] = useState<{ left: number; right: number }>({ left: 0, right: 0 });

  const handleSplit = () => {
    if (!cardRef.current || duration < 0.2 || splitHoverX === null) return;
    const frac = Math.max(0.05, Math.min(0.95, splitHoverX / width));
    const splitTime = cut.t_start + frac * duration;
    mutations.beginDragSession();
    mutations.draftEdit((edl) => {
      if (index < 0 || index >= edl.length) return edl;
      const target = edl[index];
      const without = edl.filter((_, i) => i !== index);
      const left = { ...target, t_end: splitTime };
      const right = { ...target, t_start: splitTime, in_point: target.in_point + (splitTime - target.t_start) };
      return [...without, left, right].sort((a, b) => a.t_start - b.t_start);
    });
    mutations.commitDragSession();
    setSplitHoverX(null);
  };

  // ─── Body drag: MOVE the segment on the song timeline ─────────────────
  // Short tap = select. Hold/move = slide t_start + t_end by the same
  // delta (keeps duration fixed). Snaps to beats.
  const onBodyPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-trim-handle],[data-card-action],[data-source-scrub]")) {
      return;
    }
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startTStart = cut.t_start;
    const cutDuration = cut.t_end - cut.t_start;
    const leftFloor = minTStart;
    let rightCeiling = maxTEnd - cutDuration;
    if (isAnchor && clipDuration > 0) {
      // Anchor start is where clip frame 0 maps to on the timeline.
      // in_point = t_start - anchorStart, so anchorStart = t_start - in_point.
      const anchorStart = cut.t_start - cut.in_point;
      rightCeiling = Math.min(rightCeiling, anchorStart + clipDuration - cutDuration);
    }

    let promoted = false;
    let dragStarted = false;
    const holdTimer = window.setTimeout(() => {
      promoted = true;
      el.style.cursor = "grabbing";
    }, HOLD_MS);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!promoted && Math.abs(dx) > MOVE_THRESHOLD_PX) {
        promoted = true;
        el.style.cursor = "grabbing";
      }
      if (!promoted) return;
      if (!dragStarted) {
        mutations.beginDragSession();
        dragStarted = true;
      }
      let unclamped = startTStart + dx / Math.max(1, pxPerSecond);
      unclamped = maybeSnap(unclamped, ev.shiftKey);
      const newTStart = Math.max(leftFloor, Math.min(rightCeiling, unclamped));
      const delta = newTStart - startTStart;

      // Wall pressure: combines proximity (faint glow as you approach)
      // and push (bright glow when clamped against the boundary).
      const proximityThreshold = 30 / Math.max(1, pxPerSecond);
      const leftDist = newTStart - leftFloor;
      const rightDist = rightCeiling - newTStart;
      const leftProximity = leftDist < proximityThreshold ? 1 - leftDist / proximityThreshold : 0;
      const rightProximity = rightDist < proximityThreshold ? 1 - rightDist / proximityThreshold : 0;
      const leftPush = Math.max(0, leftFloor - unclamped);
      const rightPush = Math.max(0, unclamped - rightCeiling);
      setWallPressure({
        left: Math.max(leftProximity * 0.4, leftPush * 3),
        right: Math.max(rightProximity * 0.4, rightPush * 3),
      });

      mutations.draftEdit((edl) =>
        edl.map((c, i) =>
          i === index ? { ...c, t_start: newTStart, t_end: c.t_end + delta } : c,
        ),
      );
    };

    const onUp = () => {
      window.clearTimeout(holdTimer);
      el.style.cursor = "";
      setWallPressure({ left: 0, right: 0 });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dragStarted) {
        mutations.commitDragSession();
      } else if (!promoted) {
        onSelect();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ─── Source scrub strip: slide in_point (bottom strip only) ───────────
  // Shows a floating popup above the card while dragging.
  const [scrubPopup, setScrubPopup] = useState<{ inPoint: number; rect: DOMRect } | null>(null);

  const onSourceScrubDown = (e: React.PointerEvent) => {
    if (isAnchor) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const cardRect = cardRef.current?.getBoundingClientRect();
    const startX = e.clientX;
    const startInPoint = cut.in_point;
    const cutDuration = cut.t_end - cut.t_start;
    const maxInPoint = clipDuration > 0 ? Math.max(0, clipDuration - cutDuration) : 0;
    const secondsPerPx = cutDuration / Math.max(1, width);

    if (cardRect) setScrubPopup({ inPoint: startInPoint, rect: cardRect });
    mutations.beginDragSession();

    const onMove = (ev: PointerEvent) => {
      const nextInPoint = Math.max(0, Math.min(maxInPoint, startInPoint + (ev.clientX - startX) * secondsPerPx));
      mutations.draftEdit((edl) =>
        edl.map((c, i) => (i === index ? { ...c, in_point: nextInPoint } : c)),
      );
      if (cardRect) setScrubPopup({ inPoint: nextInPoint, rect: cardRect });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      mutations.commitDragSession();
      setScrubPopup(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ─── Left handle: trim from the front ──────────────────────────────────
  // Moves t_start and in_point TOGETHER in one atomic draft edit so the cut
  // ends at the same song time and the source clip's window shifts later.
  // The drag session collapses hundreds of pointermove events into ONE PUT
  // on release and keeps t_start / in_point consistent (no race).
  const onLeftPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const initialTStart = cut.t_start;
    const initialInPoint = cut.in_point;
    const tEnd = cut.t_end;
    const minDuration = (HANDLE_WIDTH * 2) / Math.max(1, pxPerSecond);
    const clipLeftCeiling = Math.max(minTStart, 0);
    const clipRightCeiling = tEnd - minDuration;

    mutations.beginDragSession();

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      const dxSec = dxPx / Math.max(1, pxPerSecond);
      let newTStart = initialTStart + dxSec;
      newTStart = maybeSnap(newTStart, ev.shiftKey);
      newTStart = Math.max(clipLeftCeiling, Math.min(clipRightCeiling, newTStart));

      const delta = newTStart - initialTStart;
      let newInPoint = Math.max(0, initialInPoint + delta);

      // Clamp in_point so the source window stays inside the clip.
      if (clipDuration > 0) {
        const maxInPoint = Math.max(0, clipDuration - (tEnd - newTStart));
        if (newInPoint > maxInPoint) newInPoint = maxInPoint;
      }

      mutations.draftEdit((edl) =>
        edl.map((c, i) => (i === index ? { ...c, t_start: newTStart, in_point: newInPoint } : c)),
      );
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      mutations.commitDragSession();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ─── Right handle: trim from the back ─────────────────────────────────
  // Moves t_end only. in_point stays. Source clip's "out point" moves.
  const onRightPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const initialTEnd = cut.t_end;
    const tStart = cut.t_start;
    const minDuration = (HANDLE_WIDTH * 2) / Math.max(1, pxPerSecond);
    const rightCeiling = Math.max(tStart + minDuration, maxTEnd);

    mutations.beginDragSession();

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      const dxSec = dxPx / Math.max(1, pxPerSecond);
      let newTEnd = initialTEnd + dxSec;
      newTEnd = maybeSnap(newTEnd, ev.shiftKey);
      newTEnd = Math.max(tStart + minDuration, Math.min(rightCeiling, newTEnd));

      // Don't let the cut extend past the source clip's remaining material.
      if (clipDuration > 0) {
        const maxFromSource = tStart + (clipDuration - cut.in_point);
        if (newTEnd > maxFromSource) newTEnd = maxFromSource;
      }

      mutations.draftEdit((edl) =>
        edl.map((c, i) => (i === index ? { ...c, t_end: newTEnd } : c)),
      );
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      mutations.commitDragSession();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={cardRef}
      onPointerDown={onBodyPointerDown}
      onMouseMove={(e) => {
        if (width > 40) {
          const rect = cardRef.current?.getBoundingClientRect();
          if (rect) setSplitHoverX(e.clientX - rect.left);
        }
      }}
      onMouseLeave={() => setSplitHoverX(null)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-mvm-clip")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const clipId = e.dataTransfer.getData("application/x-mvm-clip");
        if (clipId) {
          e.preventDefault();
          onDropClip(clipId);
        }
      }}
      className={clsx(
        "group relative shrink-0 h-full flex flex-col rounded-sm",
        "bg-zinc-900 border overflow-hidden",
        "transition-[border-color] duration-100",
        selected ? "cursor-grab" : "cursor-pointer",
        selected
          ? "border-accent ring-1 ring-accent z-10"
          : "border-zinc-800 hover:border-zinc-700",
      )}
      style={{ width, borderTopWidth: 4, borderTopColor: clipColor(cut.clip_id) }}
      title={`${displayName} · ${cut.t_start.toFixed(2)}–${cut.t_end.toFixed(2)}s (${duration.toFixed(2)}s)`}
    >
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
        {filmstrip.length > 0 && (
          <div className="absolute inset-0 flex overflow-hidden">
            {filmstrip.map((frame, i) =>
              frame.url ? (
                <img
                  key={i}
                  src={frame.url}
                  alt=""
                  draggable={false}
                  className="object-cover block shrink-0"
                  style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                />
              ) : (
                <div key={i} className="shrink-0 bg-zinc-800" style={{ width: THUMB_SIZE, height: THUMB_SIZE }} />
              ),
            )}
          </div>
        )}
        {/* Loop boundary markers */}
        {loopMarkers.map((px, li) => (
          <div
            key={`loop-${li}`}
            className="absolute top-0 bottom-0 w-px z-10"
            style={{
              left: px,
              background: "repeating-linear-gradient(to bottom, #fbbf24 0px, #fbbf24 3px, transparent 3px, transparent 6px)",
            }}
            title={`Loop ${li + 1}`}
          />
        ))}
        {loopMarkers.length > 0 && (
          <div className="absolute top-0.5 left-1 bg-amber-500/80 rounded px-0.5 z-10">
            <span className="text-[7px] font-bold text-black">LOOP</span>
          </div>
        )}
        {cut.locked && width > 20 && (
          <div className="absolute top-0.5 right-0.5 bg-zinc-950/80 rounded p-0.5 z-10">
            <Lock className="h-2.5 w-2.5 text-amber-400" />
          </div>
        )}
        {/* Split hover line + scissors */}
        {splitHoverX !== null && splitHoverX > 10 && splitHoverX < width - 10 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-accent/60 z-20 pointer-events-none"
            style={{ left: splitHoverX }}
          >
            <button
              className="absolute -top-1 -left-2 w-4 h-4 rounded-full bg-accent grid place-items-center pointer-events-auto cursor-pointer hover:bg-accent/80 shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleSplit();
              }}
              title="Split here"
            >
              <Scissors className="h-2.5 w-2.5 text-white" />
            </button>
          </div>
        )}
        {/* Anchor wall pressure lines */}
        {wallPressure.left > 0.01 && (
          <div
            className="absolute top-0 bottom-0 left-0 w-1 z-30 pointer-events-none"
            style={{
              background: `rgba(250, 204, 21, ${Math.min(1, wallPressure.left)})`,
              boxShadow: `0 0 ${Math.min(20, wallPressure.left * 20)}px ${Math.min(8, wallPressure.left * 8)}px rgba(250, 204, 21, ${Math.min(0.9, wallPressure.left * 0.9)})`,
            }}
          />
        )}
        {wallPressure.right > 0.01 && (
          <div
            className="absolute top-0 bottom-0 right-0 w-1 z-30 pointer-events-none"
            style={{
              background: `rgba(250, 204, 21, ${Math.min(1, wallPressure.right)})`,
              boxShadow: `0 0 ${Math.min(20, wallPressure.right * 20)}px ${Math.min(8, wallPressure.right * 8)}px rgba(250, 204, 21, ${Math.min(0.9, wallPressure.right * 0.9)})`,
            }}
          />
        )}
      </div>

      {width > 80 && (
        <div className="px-1.5 py-0.5 text-[9px] leading-tight font-mono bg-zinc-950/70 shrink-0">
          <div className="truncate text-zinc-200">{displayName}</div>
          <div className="flex items-center justify-between text-[8px] text-zinc-500">
            <span>{duration.toFixed(2)}s</span>
            {isAnchor && <span className="text-cyan-400">A</span>}
            {clip && width > 110 && !isAnchor && <span>in {cut.in_point.toFixed(1)}s</span>}
          </div>
        </div>
      )}

      {/* Source scrub strip — bottom strip for adjusting in_point. Hidden for anchor clips. */}
      {!isAnchor && (
        <div
          data-source-scrub
          onPointerDown={onSourceScrubDown}
          className={clsx(
            "shrink-0 flex items-center justify-center cursor-ew-resize",
            "bg-zinc-950/90 border-t border-zinc-800/50",
            "hover:bg-zinc-800/50 transition-colors",
          )}
          style={{ height: SOURCE_STRIP_H }}
          title="Drag to scrub source clip start position"
        >
          {width > 40 && (
            <div className="flex gap-0.5">
              <span className="block w-0.5 h-1.5 rounded-full bg-zinc-600" />
              <span className="block w-0.5 h-1.5 rounded-full bg-zinc-600" />
              <span className="block w-0.5 h-1.5 rounded-full bg-zinc-600" />
            </div>
          )}
        </div>
      )}

      {/* In-place trim handles */}
      <button
        data-trim-handle
        onPointerDown={onLeftPointerDown}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          "absolute top-0 bottom-0 left-0 cursor-ew-resize group/handle",
          "flex items-center justify-start pl-0.5",
          "transition-colors",
          selected
            ? "bg-accent/60 hover:bg-accent"
            : "bg-transparent hover:bg-accent/30",
        )}
        style={{ width: HANDLE_WIDTH }}
        title="Drag to trim from the start (Shift = no snap)"
      >
        <span
          className={clsx(
            "block w-0.5 h-3 rounded-full bg-white/70",
            selected ? "opacity-100" : "opacity-0 group-hover/handle:opacity-60",
          )}
        />
      </button>
      <button
        data-trim-handle
        onPointerDown={onRightPointerDown}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          "absolute top-0 bottom-0 right-0 cursor-ew-resize group/handle",
          "flex items-center justify-end pr-0.5",
          "transition-colors",
          selected
            ? "bg-accent/60 hover:bg-accent"
            : "bg-transparent hover:bg-accent/30",
        )}
        style={{ width: HANDLE_WIDTH }}
        title="Drag to trim from the end (Shift = no snap)"
      >
        <span
          className={clsx(
            "block w-0.5 h-3 rounded-full bg-white/70",
            selected ? "opacity-100" : "opacity-0 group-hover/handle:opacity-60",
          )}
        />
      </button>

      {/* Selected card action overlay */}
      {selected && width > 48 && (
        <div data-card-action className="absolute top-0.5 left-3 flex gap-0.5 z-10">
          <IconBtn
            icon={<Replace className="h-2.5 w-2.5" />}
            onClick={onReplaceClick}
            title="Replace clip"
          />
          <IconBtn
            icon={cut.locked ? <Unlock className="h-2.5 w-2.5" /> : <Lock className="h-2.5 w-2.5" />}
            onClick={() => mutations.toggleLockAt(index)}
            title={cut.locked ? "Unlock" : "Lock (survives re-Arrange)"}
          />
          <IconBtn
            icon={<Trash2 className="h-2.5 w-2.5" />}
            onClick={() => mutations.deleteCutAt(index)}
            title="Delete cut"
            variant="danger"
          />
        </div>
      )}

      {/* Floating source-scrub popup */}
      {scrubPopup && clipDuration > 0 && createPortal(
        <SourceScrubPopup
          clipDuration={clipDuration}
          inPoint={scrubPopup.inPoint}
          cutDuration={duration}
          rect={scrubPopup.rect}
        />,
        document.body,
      )}
    </div>
  );
}

function SourceScrubPopup({
  clipDuration,
  inPoint,
  cutDuration,
  rect,
}: {
  clipDuration: number;
  inPoint: number;
  cutDuration: number;
  rect: DOMRect;
}) {
  const leftFrac = inPoint / clipDuration;
  const spanFrac = Math.min(1 - leftFrac, cutDuration / clipDuration);
  const popupW = Math.max(160, Math.min(320, rect.width * 1.5));

  return (
    <div
      className="fixed z-[100] pointer-events-none"
      style={{
        left: rect.left + rect.width / 2 - popupW / 2,
        top: rect.top - 48,
        width: popupW,
      }}
    >
      <div className="bg-zinc-900/95 border border-zinc-700 rounded-lg px-3 py-2 shadow-xl backdrop-blur-sm">
        <div className="relative h-3 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="absolute top-0 bottom-0 bg-accent/60 rounded-full"
            style={{ left: `${leftFrac * 100}%`, width: `${spanFrac * 100}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white"
            style={{ left: `${leftFrac * 100}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white/60"
            style={{ left: `${(leftFrac + spanFrac) * 100}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[9px] font-mono tabular-nums">
          <span className="text-accent">{inPoint.toFixed(2)}s</span>
          <span className="text-zinc-500">{clipDuration.toFixed(1)}s total</span>
          <span className="text-zinc-400">{(inPoint + cutDuration).toFixed(2)}s</span>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  icon,
  onClick,
  title,
  variant,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  variant?: "danger";
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={clsx(
        "h-4 w-4 grid place-items-center rounded bg-zinc-950/80 text-zinc-200",
        variant === "danger" ? "hover:bg-red-600" : "hover:bg-zinc-800",
      )}
    >
      {icon}
    </button>
  );
}
