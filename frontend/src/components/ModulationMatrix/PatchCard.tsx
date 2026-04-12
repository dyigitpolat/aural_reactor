import { useMemo } from "react";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import type { Patch } from "@/api/client";
import type { BakedModulation } from "@/preview/modulation";
import { RotaryKnob } from "@/components/ui/RotaryKnob";

const CURVES: Patch["curve"][] = ["linear", "exp", "log", "s"];

const TRIGGER_SOURCES = new Set([
  "beat", "downbeat", "bar_start", "kick_hit", "snare_hit",
  "hi_hat_hit", "vocal_onset", "drop_detected", "section_change",
]);

interface PatchCardProps {
  patch: Patch;
  onChange: (partial: Partial<Omit<Patch, "id">>) => void;
  onDelete: () => void;
  baked: BakedModulation | null;
  sectionLabels: string[];
  sources: string[];
  targetNames: string[];
}

export function PatchCard({
  patch,
  onChange,
  onDelete,
  baked,
  sectionLabels,
  sources,
  targetNames,
}: PatchCardProps) {
  const isTrigger = TRIGGER_SOURCES.has(patch.source);
  const srcColor = isTrigger ? "text-orange-400" : "text-violet-400";
  const sectionLabel = patch.section_mask
    ? patch.section_mask.map((i) => sectionLabels[i] ?? String(i)).join(", ")
    : "all";

  // Mini sparkline: downsample the baked target to ~100 points
  const sparkline = useMemo(() => {
    if (!baked) return null;
    const arr = baked.targets.get(patch.target);
    if (!arr || arr.length === 0) return null;
    const bins = 100;
    const step = Math.max(1, Math.floor(arr.length / bins));
    const pts: number[] = [];
    for (let i = 0; i < arr.length; i += step) {
      let max = 0;
      for (let j = i; j < Math.min(i + step, arr.length); j++) {
        if (arr[j] > max) max = arr[j];
      }
      pts.push(max);
    }
    return pts;
  }, [baked, patch.target]);

  return (
    <div
      className={clsx(
        "surface rounded-md px-2.5 py-2 flex flex-col gap-1.5 transition-opacity",
        !patch.enabled && "opacity-40",
      )}
    >
      {/* Top: enable, source → target, section, delete */}
      <div className="flex items-center gap-1.5 min-w-0">
        <input
          type="checkbox"
          checked={patch.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="accent-accent cursor-pointer shrink-0"
        />
        <select
          value={patch.source}
          onChange={(e) => onChange({ source: e.target.value })}
          className={clsx("bg-zinc-900 border border-zinc-800 rounded px-1 h-5 text-[9px] font-mono max-w-[80px]", srcColor)}
        >
          {!sources.includes(patch.source) && <option value={patch.source}>{patch.source}</option>}
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-[10px] text-zinc-600 shrink-0">→</span>
        <select
          value={patch.target}
          onChange={(e) => onChange({ target: e.target.value })}
          className="bg-zinc-900 border border-zinc-800 rounded px-1 h-5 text-[9px] font-mono text-zinc-300 flex-1 min-w-0"
        >
          {!targetNames.includes(patch.target) && <option value={patch.target}>{patch.target}</option>}
          {targetNames.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="text-[9px] text-zinc-600 font-mono shrink-0">
          §{sectionLabel}
        </span>
        <button
          onClick={onDelete}
          className="text-zinc-600 hover:text-red-400 shrink-0"
          title="Delete patch"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Knobs row */}
      <div className="flex items-start gap-1 justify-between">
        <RotaryKnob
          value={patch.scale_min}
          onChange={(v) => onChange({ scale_min: v })}
          min={0}
          max={1}
          step={0.01}
          label="min"
        />
        <RotaryKnob
          value={patch.scale_max}
          onChange={(v) => onChange({ scale_max: v })}
          min={0}
          max={1}
          step={0.01}
          label="max"
        />
        <RotaryKnob
          value={patch.smooth_ms}
          onChange={(v) => onChange({ smooth_ms: v })}
          min={0}
          max={500}
          step={5}
          label="smooth"
          format={(v) => `${Math.round(v)}`}
        />
        <RotaryKnob
          value={patch.latch_ms}
          onChange={(v) => onChange({ latch_ms: v })}
          min={0}
          max={1000}
          step={10}
          label="latch"
          format={(v) => `${Math.round(v)}`}
        />
        <div className="flex flex-col items-center gap-0.5" style={{ width: 44 }}>
          <select
            value={patch.curve}
            onChange={(e) => onChange({ curve: e.target.value as Patch["curve"] })}
            className="bg-zinc-900 border border-zinc-800 rounded px-1 h-5 text-[9px] w-full"
          >
            {CURVES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="text-[8px] text-zinc-500">curve</span>
        </div>
        <RotaryKnob
          value={patch.gate_threshold}
          onChange={(v) => onChange({ gate_threshold: v })}
          min={0}
          max={1}
          step={0.01}
          label="gate"
        />
      </div>

      {/* Sparkline */}
      {sparkline && (
        <div className="h-3 w-full rounded overflow-hidden bg-zinc-900/50">
          <svg viewBox={`0 0 ${sparkline.length} 1`} preserveAspectRatio="none" className="w-full h-full">
            <polyline
              points={sparkline.map((v, i) => `${i},${1 - v}`).join(" ")}
              fill="none"
              stroke={isTrigger ? "#fb923c" : "#8b5cf6"}
              strokeWidth={sparkline.length / 60}
            />
          </svg>
        </div>
      )}
    </div>
  );
}
