import { useRef, useState } from "react";

interface RotaryKnobProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
  size?: number;
}

const ARC_START = 135;
const ARC_END = 405;
const ARC_RANGE = ARC_END - ARC_START;

function valueToAngle(v: number, min: number, max: number): number {
  const frac = max > min ? (v - min) / (max - min) : 0;
  return ARC_START + frac * ARC_RANGE;
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startDeg));
  const y1 = cy + r * Math.sin(toRad(startDeg));
  const x2 = cx + r * Math.cos(toRad(endDeg));
  const y2 = cy + r * Math.sin(toRad(endDeg));
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/**
 * SVG rotary knob. Drag up/down to change value.
 *
 * Commit-on-release: during a drag, only local state updates (the arc
 * moves visually). The actual `onChange` callback fires ONCE on pointerup
 * so we get one network request per gesture, not one per pixel.
 */
export function RotaryKnob({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  format = (v) => (Number.isFinite(v) ? (v < 10 ? v.toFixed(2) : Math.round(v).toString()) : "0"),
  size = 36,
}: RotaryKnobProps) {
  const knobRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const displayed = draft ?? value;

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const angle = valueToAngle(displayed, min, max);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startVal = value;
    const range = max - min;
    const el = e.currentTarget as SVGSVGElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      const sensitivity = ev.shiftKey ? 0.1 : 1.0;
      const delta = (dy / 120) * range * sensitivity;
      const raw = startVal + delta;
      const snapped = Math.round(raw / step) * step;
      const clamped = Math.max(min, Math.min(max, snapped));
      setDraft(clamped);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDraft((d) => {
        if (d !== null && d !== value) onChange(d);
        return null;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex flex-col items-center gap-0.5 select-none" style={{ width: size + 8 }}>
      <svg
        ref={knobRef}
        width={size}
        height={size}
        className="cursor-ns-resize"
        onPointerDown={onPointerDown}
      >
        <path
          d={describeArc(cx, cy, r, ARC_START, ARC_END)}
          fill="none"
          stroke="#27272a"
          strokeWidth={3}
          strokeLinecap="round"
        />
        {angle > ARC_START + 0.5 && (
          <path
            d={describeArc(cx, cy, r, ARC_START, Math.min(angle, ARC_END))}
            fill="none"
            stroke="#7c5cff"
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        {(() => {
          const rad = ((angle - 90) * Math.PI) / 180;
          const dotR = r - 1;
          return (
            <circle
              cx={cx + dotR * Math.cos(rad)}
              cy={cy + dotR * Math.sin(rad)}
              r={2}
              fill="white"
            />
          );
        })()}
      </svg>
      <span className="text-[8px] text-zinc-500 leading-none truncate w-full text-center">
        {label}
      </span>
      <span className="text-[9px] text-zinc-300 leading-none font-mono tabular-nums">
        {format(displayed)}
      </span>
    </div>
  );
}
