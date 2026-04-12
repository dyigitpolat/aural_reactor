import clsx from "clsx";
import type { AnalyzeSummary } from "@/api/client";

interface SectionTabsProps {
  summary: AnalyzeSummary | null;
  selected: number | null;
  onSelect: (idx: number | null) => void;
}

export function SectionTabs({ summary, selected, onSelect }: SectionTabsProps) {
  const sections = summary?.sections ?? [];
  if (sections.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={clsx(
          "h-5 px-2 rounded-full text-[9px] font-medium transition-colors",
          selected === null
            ? "bg-accent text-white"
            : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800",
        )}
      >
        All
      </button>
      {sections.map((sec, i) => {
        const energyHue = Math.round(240 - sec.energy * 240);
        return (
          <button
            key={i}
            onClick={() => onSelect(selected === i ? null : i)}
            className={clsx(
              "h-5 px-2 rounded-full text-[9px] font-medium transition-colors",
              selected === i
                ? "text-white ring-1 ring-accent"
                : "text-zinc-400 hover:text-zinc-200 border border-zinc-800",
            )}
            style={{
              backgroundColor: selected === i
                ? `hsl(${energyHue}, 60%, 35%)`
                : `hsl(${energyHue}, 30%, 15%)`,
            }}
            title={`${sec.label} (${sec.start.toFixed(1)}s–${sec.end.toFixed(1)}s, energy ${(sec.energy * 100).toFixed(0)}%)`}
          >
            {sec.label}
          </button>
        );
      })}
    </div>
  );
}
