import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useSignal } from "@/hooks/useSignal";

interface SignalLaneProps {
  projectId: string | null;
  name: string;
  /** Optional inline label (gutter-based labels pass ""). */
  label?: string;
  color: string;
  height?: number;
}

/**
 * Renders a continuous Float32 signal as a canvas area chart. Fills its
 * parent container width — caller sets the wrapper's width so the lane
 * stays pixel-aligned with the waveform and clip strip above it.
 */
export function SignalLane({
  projectId,
  name,
  label,
  color,
  height = 22,
}: SignalLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalQuery = useSignal(projectId, name);
  const data = signalQuery.data;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const MAX_CANVAS_PX = 16384;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) return;

      // Clamp canvas pixel dimensions to avoid exceeding browser limits.
      // At extreme zoom, clientWidth can be 10000+ px; with dpr=2 that's
      // 20000+ canvas pixels which corrupts the rendering.
      const scale = Math.min(dpr, MAX_CANVAS_PX / w, MAX_CANVAS_PX / h);
      canvas.width = Math.max(1, Math.floor(w * scale));
      canvas.height = Math.max(1, Math.floor(h * scale));

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.clearRect(0, 0, w, h);

      ctx.fillStyle = "rgba(255, 255, 255, 0.02)";
      ctx.fillRect(0, 0, w, h);

      if (!data || data.length === 0) return;

      const stride = data.length / w;

      // Sample value at pixel x. When zoomed out (stride >= 1) use
      // max-pooling; when zoomed in (stride < 1) use linear
      // interpolation so the curve stays smooth at all zoom levels.
      const sampleAt = (x: number): number => {
        if (stride >= 1) {
          const lo = Math.floor(x * stride);
          const hi = Math.min(data.length, Math.floor((x + 1) * stride));
          let mx = 0;
          for (let i = lo; i < hi; i++) { if (data[i] > mx) mx = data[i]; }
          return mx;
        }
        const pos = x * stride;
        const i0 = Math.min(data.length - 1, Math.floor(pos));
        const i1 = Math.min(data.length - 1, i0 + 1);
        const frac = pos - i0;
        return data[i0] * (1 - frac) + data[i1] * frac;
      };

      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        ctx.lineTo(x, h - sampleAt(x) * h * 0.95);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = color + "55";
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = h - sampleAt(x) * h * 0.95;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [data, color]);

  if (label) {
    // Legacy layout with inline label + canvas. Only used if a caller still
    // passes a non-empty label. The Timeline rendering uses the gutter mode.
    return (
      <div className="flex items-center gap-2 group">
        <div className="w-20 shrink-0 text-[10px] text-zinc-500 tabular-nums truncate font-mono">
          {label}
        </div>
        <div
          className={clsx(
            "flex-1 min-w-0 relative rounded bg-zinc-900/40 border border-zinc-900",
            !data && "animate-pulse",
          )}
          style={{ height }}
        >
          <canvas ref={canvasRef} className="w-full h-full block" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "w-full h-full relative bg-zinc-900/40 border-b border-zinc-900/50",
        !data && "animate-pulse",
      )}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}
