import { useState } from "react";
import { ChevronDown, ChevronRight, Sliders } from "lucide-react";
import type { EffectChainEntry } from "@/api/client";
import { HorizontalSlider } from "@/components/ui/HorizontalSlider";

interface EffectSpec {
  name: string;
  uniforms: { param: string; default: number; min: number; max: number }[];
}

interface EffectTunerProps {
  chain: EffectChainEntry[];
  effectSpecs: EffectSpec[];
  onChangeParam: (effectName: string, param: string, value: number) => void;
}

export function EffectTuner({ chain, effectSpecs, onChangeParam }: EffectTunerProps) {
  const [open, setOpen] = useState(false);
  const enabled = chain.filter((e) => e.enabled);

  if (enabled.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-wider"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Sliders className="h-3 w-3" />
        Effect base levels
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 pl-1">
          {enabled.map((entry) => {
            const spec = effectSpecs.find((s) => s.name === entry.name);
            if (!spec) return null;
            return (
              <div key={entry.name} className="flex flex-col gap-0.5">
                <span className="text-[9px] text-zinc-500 font-mono">{entry.name}</span>
                {spec.uniforms.map((u) => (
                  <HorizontalSlider
                    key={u.param}
                    label={u.param}
                    value={entry.base_params[u.param] ?? u.default}
                    min={u.min}
                    max={u.max}
                    step={(u.max - u.min) / 100}
                    onChange={(v) => onChangeParam(entry.name, u.param, v)}
                    format={(v) => v.toFixed(2)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
