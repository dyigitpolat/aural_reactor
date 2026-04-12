import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Monitor, Check } from "lucide-react";
import { api, type ResolutionPreset } from "@/api/client";

interface ResolutionPickerProps {
  projectId: string | null;
  width: number;
  height: number;
  fps: number;
}

export function ResolutionPicker({ projectId, width, height, fps }: ResolutionPickerProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [customW, setCustomW] = useState<number>(width);
  const [customH, setCustomH] = useState<number>(height);
  const [customFps, setCustomFps] = useState<number>(fps);

  const presetsQuery = useQuery({
    queryKey: ["resolution-presets"],
    queryFn: api.getResolutionPresets,
  });

  const setMut = useMutation({
    mutationFn: (body: { width: number; height: number; fps?: number }) =>
      api.setResolution(projectId!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setOpen(false);
    },
  });

  const presets = presetsQuery.data?.presets ?? [];

  const aspect = height > 0 ? width / height : 0;
  const aspectLabel =
    aspect > 1.2 ? "Landscape" : aspect < 0.85 ? "Portrait" : "Square";

  const matchesPreset = (p: ResolutionPreset) => p.width === width && p.height === height;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!projectId}
        className={clsx(
          "inline-flex items-center gap-2 h-7 px-2.5 rounded text-[11px]",
          "bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 transition-colors",
          "disabled:opacity-40",
        )}
      >
        <Monitor className="h-3.5 w-3.5 text-zinc-400" />
        <span className="font-mono tabular-nums text-zinc-200">
          {width}×{height}
        </span>
        <span className="text-zinc-500">·</span>
        <span className="text-zinc-400">{aspectLabel}</span>
        <span className="text-zinc-500">·</span>
        <span className="font-mono tabular-nums text-zinc-400">{fps}fps</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 w-72 surface rounded-lg shadow-xl p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-2 py-1">
              Presets
            </div>
            <div className="flex flex-col max-h-64 overflow-y-auto">
              {presets.map((p) => (
                <button
                  key={p.label}
                  onClick={() =>
                    setMut.mutate({ width: p.width, height: p.height })
                  }
                  className="flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-zinc-800 text-xs"
                >
                  <span className="flex-1 text-zinc-200">{p.label}</span>
                  {matchesPreset(p) && <Check className="h-3.5 w-3.5 text-accent" />}
                </button>
              ))}
            </div>

            <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-2 pt-2 pb-1 border-t border-zinc-800 mt-1">
              Custom
            </div>
            <div className="flex items-center gap-1 px-2 py-1">
              <NumField label="W" value={customW} onChange={setCustomW} />
              <span className="text-zinc-600">×</span>
              <NumField label="H" value={customH} onChange={setCustomH} />
              <span className="text-zinc-600 ml-1">@</span>
              <NumField label="fps" value={customFps} onChange={setCustomFps} />
              <button
                onClick={() =>
                  setMut.mutate({
                    width: customW,
                    height: customH,
                    fps: customFps,
                  })
                }
                className="ml-auto h-6 px-2 rounded bg-accent/80 hover:bg-accent text-white text-[11px]"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[9px] text-zinc-500 uppercase">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 h-6 text-[11px] tabular-nums"
      />
    </label>
  );
}
