export interface Clip {
  id: string;
  filename: string;
  path: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  motion_energy: number;
  auto_arrange: boolean;
  anchor: boolean;
}

export interface AudioTrack {
  filename: string;
  path: string;
  url: string;
  duration: number;
  sr: number;
  analyzed: boolean;
}

export interface Cut {
  t_start: number;
  t_end: number;
  clip_id: string;
  in_point: number;
  speed: number;
  locked: boolean;
}

export interface Patch {
  id: string;
  source: string;
  target: string;
  enabled: boolean;
  smooth_ms: number;
  gate_threshold: number;
  curve: "linear" | "exp" | "log" | "s";
  scale_min: number;
  scale_max: number;
  latch_ms: number;
  section_mask: number[] | null;
}

export interface EffectChainEntry {
  name: string;
  enabled: boolean;
  base_params: Record<string, number>;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  audio: AudioTrack | null;
  clips: Clip[];
  edl: Cut[];
  patches: Patch[];
  effect_chain: EffectChainEntry[];
  preset: string | null;
  fps: number;
  width: number;
  height: number;
  beats_per_cut: number;
  beats_per_bar: number | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listProjects: () => req<Project[]>("/api/projects"),
  createProject: (name: string) =>
    req<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getProject: (id: string) => req<Project>(`/api/projects/${id}`),
  deleteProject: (id: string) =>
    req<{ deleted: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  renameProject: (id: string, name: string) =>
    req<Project>(`/api/projects/${id}/rename`, { method: "PATCH", body: JSON.stringify({ name }) }),

  uploadAudio: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/media/${projectId}/audio`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  uploadClip: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/media/${projectId}/clips`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  deleteClip: (projectId: string, clipId: string) =>
    req<{ deleted: number }>(`/api/media/${projectId}/clips/${clipId}`, { method: "DELETE" }),

  analyze: (projectId: string, force = false) =>
    req<{ ok: boolean; summary: AnalyzeSummary }>(`/api/analyze/${projectId}?force=${force}`, {
      method: "POST",
    }),
  getSummary: (projectId: string) =>
    req<AnalyzeSummary>(`/api/analyze/${projectId}/summary`),
  getSignal: async (projectId: string, name: string): Promise<Float32Array> => {
    const res = await fetch(`/api/analyze/${projectId}/signal/${name}`);
    if (!res.ok) throw new Error(await res.text());
    const buf = await res.arrayBuffer();
    return new Float32Array(buf);
  },

  arrange: (projectId: string, beatsPerCut?: number) =>
    req<{ ok: boolean; cut_count: number; edl: Cut[] }>(`/api/arrange/${projectId}`, {
      method: "POST",
      body: JSON.stringify(beatsPerCut ? { beats_per_cut: beatsPerCut } : {}),
    }),

  getEffects: () => req<{ order: string[]; effects: EffectSpec[] }>("/api/effects"),

  getSources: (projectId: string) =>
    req<{ continuous: string[]; triggers: string[]; has_analysis: boolean }>(
      `/api/routing/${projectId}/sources`,
    ),
  getTargets: (projectId: string) =>
    req<{ targets: TargetSpec[] }>(`/api/routing/${projectId}/targets`),
  getPatches: (projectId: string) =>
    req<{ patches: Patch[]; effect_chain: EffectChainEntry[] }>(
      `/api/routing/${projectId}/patches`,
    ),
  createPatch: (projectId: string, body: Omit<Patch, "id">) =>
    req<Patch>(`/api/routing/${projectId}/patches`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updatePatch: (projectId: string, patchId: string, body: Omit<Patch, "id">) =>
    req<Patch>(`/api/routing/${projectId}/patches/${patchId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deletePatch: (projectId: string, patchId: string) =>
    req<{ deleted: number }>(`/api/routing/${projectId}/patches/${patchId}`, {
      method: "DELETE",
    }),
  setEffectChain: (projectId: string, chain: EffectChainEntry[]) =>
    req<{ ok: boolean; count: number }>(`/api/routing/${projectId}/effect-chain`, {
      method: "PUT",
      body: JSON.stringify({ chain }),
    }),
  bakeModulation: async (projectId: string): Promise<ArrayBuffer> => {
    const res = await fetch(`/api/routing/${projectId}/bake`);
    if (!res.ok) throw new Error(await res.text());
    return res.arrayBuffer();
  },

  listPresets: () => req<{ presets: { name: string; description: string }[] }>(
    `/api/routing/presets`,
  ),
  applyPreset: (projectId: string, name: string) =>
    req<{ ok: boolean; preset: string }>(`/api/routing/${projectId}/presets/${name}`, {
      method: "POST",
    }),

  getResolutionPresets: () =>
    req<{ presets: ResolutionPreset[] }>(`/api/projects/presets/resolutions`),
  setMeter: (projectId: string, beatsPerBar: number | null) =>
    req<Project>(`/api/projects/${projectId}/meter`, {
      method: "PUT",
      body: JSON.stringify({ beats_per_bar: beatsPerBar }),
    }),
  setResolution: (projectId: string, body: { width: number; height: number; fps?: number }) =>
    req<Project>(`/api/projects/${projectId}/resolution`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  renderExport: (projectId: string) =>
    req<{ ok: boolean; url: string }>(`/api/render/${projectId}/export`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  updateEdl: (projectId: string, edl: Cut[]) =>
    req<Project>(`/api/projects/${projectId}/edl`, {
      method: "PUT",
      body: JSON.stringify({ edl }),
    }),

  patchClip: (projectId: string, clipId: string, body: { auto_arrange?: boolean; anchor?: boolean }) =>
    req<Project>(`/api/projects/${projectId}/clips/${clipId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  thumbnailUrl: (projectId: string, clipId: string, t: number, w = 160) =>
    `/api/media/${projectId}/thumb?clip=${encodeURIComponent(clipId)}&t=${Math.floor(t)}&w=${w}`,

  setPatches: (projectId: string, patches: Patch[]) =>
    req<{ ok: boolean; count: number; patches: Patch[] }>(
      `/api/routing/${projectId}/patches`,
      {
        method: "PUT",
        body: JSON.stringify({ patches }),
      },
    ),

  regenerateAutoMod: (projectId: string) =>
    req<{ ok: boolean }>(`/api/routing/${projectId}/auto-regenerate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  randomizePatches: (projectId: string) =>
    req<{ ok: boolean; patches: Patch[]; effect_chain: EffectChainEntry[] }>(
      `/api/routing/${projectId}/randomize`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
  group: "landscape" | "portrait" | "square";
}

export interface TargetSpec {
  target: string;
  effect: string;
  param: string;
  min: number;
  max: number;
  default: number;
}

export interface AnalyzeSummary {
  duration: number;
  sr: number;
  rate_hz: number;
  tempo_bpm: number;
  has_stems: boolean;
  continuous_keys: string[];
  event_keys: string[];
  beat_count: number;
  downbeat_count: number;
  section_count: number;
  beat_times: number[];
  downbeat_times: number[];
  events: Record<string, number[]>;
  sections: { start: number; end: number; label: string; energy: number }[];
}

export interface EffectSpec {
  name: string;
  order: number;
  description: string;
  needs_prev_frame: boolean;
  uniforms: {
    name: string;
    param: string;
    default: number;
    min: number;
    max: number;
    description: string;
  }[];
}
