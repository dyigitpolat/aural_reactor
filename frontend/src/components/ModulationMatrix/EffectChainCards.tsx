import { useState } from "react";
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import type { EffectChainEntry } from "@/api/client";
import { RotaryKnob } from "@/components/ui/RotaryKnob";

interface EffectSpecLite {
  name: string;
  uniforms: { param: string; default: number; min: number; max: number }[];
}

interface EffectChainCardsProps {
  chain: EffectChainEntry[];
  effectSpecs: EffectSpecLite[];
  onUpdate: (next: EffectChainEntry[]) => void;
}

export function EffectChainCards({ chain, effectSpecs, onUpdate }: EffectChainCardsProps) {
  const [addOpen, setAddOpen] = useState(false);
  const inChain = new Set(chain.map((e) => e.name));
  const available = effectSpecs.filter((s) => !inChain.has(s.name));

  const toggle = (name: string) => {
    onUpdate(chain.map((e) => (e.name === name ? { ...e, enabled: !e.enabled } : e)));
  };
  const remove = (name: string) => {
    onUpdate(chain.filter((e) => e.name !== name));
  };
  const changeParam = (name: string, param: string, value: number) => {
    onUpdate(
      chain.map((e) =>
        e.name === name ? { ...e, base_params: { ...e.base_params, [param]: value } } : e,
      ),
    );
  };
  const addEffect = (name: string) => {
    const spec = effectSpecs.find((s) => s.name === name);
    if (!spec) return;
    const bp: Record<string, number> = {};
    for (const u of spec.uniforms) bp[u.param] = u.default;
    onUpdate([...chain, { name, enabled: true, base_params: bp }]);
    setAddOpen(false);
  };

  return (
    <div className="flex flex-col gap-1">
      {chain.map((entry) => {
        const spec = effectSpecs.find((s) => s.name === entry.name);
        if (!spec) return null;
        return (
          <div
            key={entry.name}
            className={clsx(
              "surface rounded-md px-2 py-1.5 flex flex-col gap-1 transition-opacity",
              !entry.enabled && "opacity-40",
            )}
          >
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={entry.enabled}
                onChange={() => toggle(entry.name)}
                className="accent-accent cursor-pointer shrink-0"
              />
              <span className="text-[10px] font-mono text-zinc-300 flex-1">{entry.name}</span>
              <button
                onClick={() => remove(entry.name)}
                className="text-zinc-600 hover:text-red-400 shrink-0"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {entry.enabled && (
              <div className="flex items-start gap-0.5 flex-wrap">
                {spec.uniforms.map((u) => (
                  <RotaryKnob
                    key={u.param}
                    value={entry.base_params[u.param] ?? u.default}
                    min={u.min}
                    max={u.max}
                    step={(u.max - u.min) / 100}
                    onChange={(v) => changeParam(entry.name, u.param, v)}
                    label={u.param}
                    size={28}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {available.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setAddOpen((v) => !v)}
            className="h-5 px-2 rounded bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-[9px] flex items-center gap-1 text-zinc-400 w-full justify-center"
          >
            <Plus className="h-2.5 w-2.5" />
            Add
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
              <div className="absolute left-0 bottom-full mb-1 z-50 w-full surface rounded-md shadow-xl p-1 max-h-32 overflow-y-auto">
                {available.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => addEffect(s.name)}
                    className="block w-full text-left px-2 py-1 text-[10px] font-mono text-zinc-300 rounded hover:bg-zinc-800"
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
