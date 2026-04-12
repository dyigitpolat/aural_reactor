import { useRef, useState } from "react";

interface HorizontalSliderProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
}

/**
 * Range slider that commits only on pointer-up (release), not per pixel.
 * React's onChange on <input type="range"> fires on every value change
 * during a drag, which would spray PUT storms. Instead we track a local
 * draft during drag and call onChange once on release.
 */
export function HorizontalSlider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  format = (v) => (Number.isFinite(v) ? v.toFixed(2) : "0"),
}: HorizontalSliderProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef(false);
  const displayed = draft ?? value;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[10px] text-zinc-500 font-mono w-16 shrink-0 truncate">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={displayed}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          setDraft(v);
          dragging.current = true;
        }}
        onPointerUp={() => {
          if (dragging.current && draft !== null) {
            onChange(draft);
            dragging.current = false;
            setDraft(null);
          }
        }}
        onBlur={() => {
          if (draft !== null) {
            onChange(draft);
            setDraft(null);
            dragging.current = false;
          }
        }}
        className="flex-1 min-w-0 accent-accent h-1 cursor-pointer"
      />
      <span className="text-[10px] text-zinc-300 font-mono tabular-nums w-10 text-right shrink-0">
        {format(displayed)}
      </span>
    </div>
  );
}
