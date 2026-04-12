import clsx from "clsx";
import { Film, Tv, Zap, Skull, Music, Pencil } from "lucide-react";

interface StyleCardsProps {
  activePreset: string | null;
  onApply: (name: string) => void;
}

const STYLES: { name: string | null; label: string; icon: typeof Film; desc: string }[] = [
  { name: null, label: "Custom", icon: Pencil, desc: "Your own settings" },
  { name: "cinematic", label: "Cinematic", icon: Film, desc: "Subtle zoom, warm vignette" },
  { name: "lofi_vhs", label: "LoFi VHS", icon: Tv, desc: "Grain, glitch, warm leak" },
  { name: "festival_edm", label: "EDM", icon: Zap, desc: "Big drops, strobe pump" },
  { name: "amv", label: "AMV", icon: Music, desc: "Beat cuts, feedback trails" },
  { name: "horror", label: "Horror", icon: Skull, desc: "Kaleidoscope, heavy vignette" },
];

export function StyleCards({ activePreset, onApply }: StyleCardsProps) {
  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
      {STYLES.map(({ name, label, icon: Icon, desc }) => {
        const isActive = activePreset === name;
        const isCustom = name === null;
        return (
          <button
            key={name ?? "custom"}
            onClick={() => {
              if (!isCustom && name) onApply(name);
            }}
            className={clsx(
              "shrink-0 flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-md text-center transition-all",
              "border",
              isActive
                ? "bg-accent/20 border-accent text-accent ring-1 ring-accent/30"
                : isCustom
                  ? "bg-zinc-900/80 border-zinc-700 text-zinc-500"
                  : "bg-zinc-900/80 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700",
              isCustom && !isActive && "opacity-60",
            )}
            title={desc}
          >
            <Icon className="h-4 w-4" />
            <span className="text-[9px] font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
