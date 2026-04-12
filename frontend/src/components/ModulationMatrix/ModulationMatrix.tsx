import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlayback } from "@/store/playback";
import { Plus, Zap, Eraser, Wand2 } from "lucide-react";
import { api, type AnalyzeSummary, type EffectChainEntry, type Patch, type Project } from "@/api/client";
import type { BakedModulation } from "@/preview/modulation";
import { PatchCard } from "./PatchCard";
import { SectionTabs } from "./SectionTabs";
import { EffectChainCards } from "./EffectChainCards";
import { StyleCards } from "./StyleCards";

interface EffectSpecLite {
  name: string;
  uniforms: { param: string; default: number; min: number; max: number }[];
}

interface ModulationMatrixProps {
  projectId: string | null;
  patches: Patch[];
  effectChain: EffectChainEntry[];
  summary: AnalyzeSummary | null;
  baked: BakedModulation | null;
  preset: string | null;
}

export function ModulationMatrix({
  projectId,
  patches,
  effectChain,
  summary,
  baked,
  preset,
}: ModulationMatrixProps) {
  const queryClient = useQueryClient();

  const sourcesQuery = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => api.getSources(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  const targetsQuery = useQuery({
    queryKey: ["targets", projectId],
    queryFn: () => api.getTargets(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  const effectsQuery = useQuery({
    queryKey: ["effects-meta"],
    queryFn: api.getEffects,
    staleTime: Infinity,
  });

  const effectSpecs: EffectSpecLite[] = useMemo(
    () =>
      (effectsQuery.data?.effects ?? []).map((e) => ({
        name: e.name,
        uniforms: e.uniforms.map((u) => ({
          param: u.param,
          default: u.default,
          min: u.min,
          max: u.max,
        })),
      })),
    [effectsQuery.data],
  );

  // ─── Mutations ─────────────────────────────────────────────────────────

  const setPatchesMut = useMutation({
    mutationFn: (next: Patch[]) => api.setPatches(projectId!, next),
    onMutate: async (next) => {
      if (!projectId) return;
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });
      const prev = queryClient.getQueryData<Project>(["project", projectId]);
      if (prev) {
        queryClient.setQueryData<Project>(["project", projectId], { ...prev, patches: next });
      }
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (projectId && ctx?.prev) queryClient.setQueryData(["project", projectId], ctx.prev);
    },
    onSuccess: (resp) => {
      if (!projectId) return;
      const prev = queryClient.getQueryData<Project>(["project", projectId]);
      if (prev) {
        queryClient.setQueryData<Project>(["project", projectId], { ...prev, patches: resp.patches });
      }
      queryClient.invalidateQueries({ queryKey: ["bake", projectId] });
    },
  });

  // setChainMut: optimistic update on the project cache; only bake needs
  // a fresh pull since the chain affects how patches evaluate.
  const setChainMut = useMutation({
    mutationFn: (chain: EffectChainEntry[]) => api.setEffectChain(projectId!, chain),
    onMutate: async (chain) => {
      if (!projectId) return;
      const prev = queryClient.getQueryData<Project>(["project", projectId]);
      if (prev) {
        queryClient.setQueryData<Project>(["project", projectId], { ...prev, effect_chain: chain });
      }
    },
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ["bake", projectId] });
    },
  });

  const resetMut = useMutation({
    mutationFn: () => api.regenerateAutoMod(projectId!),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const presetMut = useMutation({
    mutationFn: (name: string) => api.applyPreset(projectId!, name),
    onSuccess: () => {
      if (!projectId) return;
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  // ─── Sources / targets ─────────────────────────────────────────────────

  const allSources = useMemo(() => {
    if (!sourcesQuery.data) return [];
    return [...sourcesQuery.data.continuous, ...sourcesQuery.data.triggers];
  }, [sourcesQuery.data]);

  const targets = targetsQuery.data?.targets ?? [];

  // ─── Section filtering ─────────────────────────────────────────────────

  const [selectedSection, setSelectedSection] = useState<number | null>(null);
  const manualOverride = useRef(false);
  const playing = usePlayback((s) => s.playing);
  const currentTime = usePlayback((s) => s.currentTime);

  useEffect(() => {
    if (!playing || manualOverride.current) return;
    const sections = summary?.sections ?? [];
    for (let i = 0; i < sections.length; i++) {
      if (currentTime >= sections[i].start && currentTime < sections[i].end) {
        if (selectedSection !== i) setSelectedSection(i);
        return;
      }
    }
  }, [playing, currentTime, summary]);

  const handleSectionSelect = (idx: number | null) => {
    setSelectedSection(idx);
    manualOverride.current = true;
  };

  useEffect(() => {
    if (playing) manualOverride.current = false;
  }, [playing]);

  const sectionLabels = useMemo(
    () => (summary?.sections ?? []).map((s) => s.label),
    [summary],
  );

  const filteredPatches = useMemo(() => {
    if (selectedSection === null) {
      return patches.filter((p) => p.section_mask === null);
    }
    return patches.filter(
      (p) => p.section_mask !== null && p.section_mask.includes(selectedSection),
    );
  }, [patches, selectedSection]);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const [draft, setDraft] = useState<{ source: string; target: string } | null>(null);

  const replacePatchAt = (index: number, update: Partial<Omit<Patch, "id">>) => {
    const globalIdx = patches.indexOf(filteredPatches[index]);
    if (globalIdx < 0) return;
    const next = patches.map((p, i) => (i === globalIdx ? { ...p, ...update } : p));
    setPatchesMut.mutate(next);
  };

  const deletePatchAt = (index: number) => {
    const globalIdx = patches.indexOf(filteredPatches[index]);
    if (globalIdx < 0) return;
    setPatchesMut.mutate(patches.filter((_, i) => i !== globalIdx));
  };

  const addPatch = () => {
    if (!draft) return;
    const target = targets.find((t) => t.target === draft.target);
    if (!target) return;
    const created: Patch = {
      id: "",
      source: draft.source,
      target: draft.target,
      enabled: true,
      smooth_ms: 30,
      gate_threshold: 0,
      curve: "linear",
      scale_min: target.min,
      scale_max: target.max,
      latch_ms: 0,
      section_mask: selectedSection !== null ? [selectedSection] : null,
    };
    setPatchesMut.mutate([...patches, created]);
    setDraft(null);
  };

  const clearAll = () => {
    if (patches.length === 0) return;
    if (!window.confirm(`Remove all ${patches.length} patches?`)) return;
    setPatchesMut.mutate([]);
  };

  return (
    <div className="surface rounded-lg p-2.5 overflow-hidden flex flex-col min-h-0 gap-2">
      {/* Header row: presets + section tabs + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Zap className="h-3.5 w-3.5 text-accent shrink-0" />
        <StyleCards activePreset={preset} onApply={(name) => presetMut.mutate(name)} />
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => resetMut.mutate()}
            disabled={!projectId || resetMut.isPending}
            className="h-6 px-1.5 rounded bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-[10px] flex items-center gap-1 text-zinc-300"
            title="Re-run auto-modulation"
          >
            <Wand2 className="h-2.5 w-2.5" />
          </button>
          <button
            onClick={clearAll}
            disabled={patches.length === 0}
            className="h-6 px-1.5 rounded bg-zinc-900 border border-zinc-800 hover:bg-red-950/40 text-[10px] flex items-center gap-1 text-zinc-400 disabled:opacity-40"
            title="Remove every patch"
          >
            <Eraser className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>

      <SectionTabs summary={summary} selected={selectedSection} onSelect={handleSectionSelect} />

      {/* Two-column layout: effects | modulations */}
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-2">
        {/* Left column: Effect chain */}
        <div className="flex flex-col gap-1.5 overflow-y-auto no-scrollbar min-h-0">
          <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-medium">Effects</span>
          <EffectChainCards
            chain={effectChain}
            effectSpecs={effectSpecs}
            onUpdate={(next) => setChainMut.mutate(next)}
          />
        </div>

        {/* Right column: Modulation patches */}
        <div className="flex flex-col gap-1.5 overflow-y-auto no-scrollbar min-h-0">
          <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-medium">
            Patches ({filteredPatches.length})
          </span>

          {/* Add patch row */}
          <div className="flex items-center gap-1">
            <select
              className="bg-zinc-900 border border-zinc-800 text-[10px] rounded px-1 h-6 flex-1 min-w-0"
              value={draft?.source ?? ""}
              onChange={(e) =>
                setDraft({ source: e.target.value, target: draft?.target ?? targets[0]?.target ?? "" })
              }
            >
              <option value="">source…</option>
              {allSources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className="text-[9px] text-zinc-600">→</span>
            <select
              className="bg-zinc-900 border border-zinc-800 text-[10px] rounded px-1 h-6 flex-1 min-w-0"
              value={draft?.target ?? ""}
              onChange={(e) =>
                setDraft({ source: draft?.source ?? allSources[0] ?? "", target: e.target.value })
              }
            >
              <option value="">target…</option>
              {targets.map((t) => (
                <option key={t.target} value={t.target}>{t.target}</option>
              ))}
            </select>
            <button
              disabled={!draft?.source || !draft?.target}
              onClick={addPatch}
              className="h-6 w-6 grid place-items-center rounded bg-accent/80 hover:bg-accent disabled:opacity-40 shrink-0"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {filteredPatches.map((p, i) => (
            <PatchCard
              key={p.id || `draft-${i}`}
              patch={p}
              onChange={(partial) => replacePatchAt(i, partial)}
              onDelete={() => deletePatchAt(i)}
              baked={baked}
              sectionLabels={sectionLabels}
              sources={allSources}
              targetNames={targets.map((t) => t.target)}
            />
          ))}
          {filteredPatches.length === 0 && (
            <div className="text-center text-zinc-500 text-[10px] py-4">
              {selectedSection !== null
                ? `No patches for this section.`
                : `No global patches. Click auto or add one.`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
