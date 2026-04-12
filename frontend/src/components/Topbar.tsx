import { Sparkles, Play, Pause, Wand2, Upload, Download, FileVideo, FolderOpen } from "lucide-react";
import clsx from "clsx";
import { usePlayback } from "@/store/playback";
import { useProgress, type TaskKey } from "@/store/progress";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

interface TopbarProps {
  projectId: string | null;
  projectName: string;
  audioReady: boolean;
  canArrange: boolean;
  canRender: boolean;
  lastExportUrl: string | null;
  beatsPerCut: number;
  beatsPerBar: number | null;
  onUploadAudio: (file: File) => void;
  onUploadClip: (file: File) => void;
  onBeatsPerCutChange: (v: number) => void;
  onBeatsPerBarChange: (v: number | null) => void;
  onShowProjects: () => void;
}

export function Topbar({
  projectId,
  projectName,
  audioReady,
  canArrange,
  canRender,
  lastExportUrl,
  beatsPerCut,
  beatsPerBar,
  onUploadAudio,
  onUploadClip,
  onBeatsPerCutChange,
  onBeatsPerBarChange,
  onShowProjects,
}: TopbarProps) {
  const playing = usePlayback((s) => s.playing);
  const togglePlay = usePlayback((s) => s.togglePlay);
  const currentTime = usePlayback((s) => s.currentTime);
  const duration = usePlayback((s) => s.duration);
  const queryClient = useQueryClient();

  const startTask = useProgress((s) => s.start);
  const failTask = useProgress((s) => s.fail);

  const analyzeMut = useMutation({
    mutationFn: (force: boolean = false) => {
      startTask("analyze", force ? "re-analyzing..." : "starting...");
      return api.analyze(projectId!, force);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (e) => failTask("analyze", String(e)),
  });
  const arrangeMut = useMutation({
    mutationFn: () => api.arrange(projectId!, beatsPerCut),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });
  const exportMut = useMutation({
    mutationFn: () => {
      startTask("render_export", "starting...");
      return api.renderExport(projectId!);
    },
    onError: (e) => failTask("render_export", String(e)),
  });

  return (
    <header className="surface border-b border-zinc-800/80 px-4 py-3 flex items-center gap-2 shrink-0">
      <button
        onClick={onShowProjects}
        className="h-8 w-8 rounded-md bg-zinc-800 hover:bg-zinc-700 grid place-items-center transition-colors"
        title="All projects"
      >
        <FolderOpen className="h-4 w-4 text-zinc-400" />
      </button>
      <Sparkles className="h-5 w-5 text-accent" />
      <div className="text-sm font-medium tracking-tight">{projectName}</div>

      <div className="ml-3 flex items-center gap-1.5">
        <UploadButton label="Audio" accept="audio/*" onFile={onUploadAudio} />
        <UploadButton label="Clip" accept="video/*" onFile={onUploadClip} />
      </div>

      <div className="flex items-center gap-1">
        <select
          value={beatsPerBar != null ? String(beatsPerBar) : "auto"}
          onChange={(e) => {
            const v = e.target.value;
            onBeatsPerBarChange(v === "auto" ? null : parseInt(v, 10));
          }}
          className="bg-zinc-900 border border-zinc-800 rounded px-1 h-7 text-[10px] font-mono w-14"
          title="Time signature (beats per bar). Set before analyzing."
        >
          <option value="auto">auto</option>
          {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
            <option key={n} value={String(n)}>{n}/{n <= 4 ? 4 : 8}</option>
          ))}
        </select>
        <ProgressButton
          task="analyze"
          disabled={!audioReady || analyzeMut.isPending}
          pending={analyzeMut.isPending}
          onClick={() => analyzeMut.mutate(canArrange)}
          className="bg-accent/80 hover:bg-accent"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {canArrange ? "Re-analyze" : "Analyze"}
        </ProgressButton>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-zinc-500">every</span>
        <select
          value={beatsPerCut}
          onChange={(e) => onBeatsPerCutChange(parseInt(e.target.value, 10))}
          className="bg-zinc-900 border border-zinc-800 rounded px-1 h-7 text-[11px] font-mono w-12"
        >
          {[1, 2, 4, 8, 16].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span className="text-[10px] text-zinc-500">beats</span>
        <button
          disabled={!canArrange || arrangeMut.isPending}
          onClick={() => arrangeMut.mutate()}
          className={btn("bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40")}
        >
          {arrangeMut.isPending ? "Arranging..." : "Arrange"}
        </button>
      </div>

      <div className="w-px h-6 bg-zinc-800 mx-1" />

      <ProgressButton
        task="render_export"
        disabled={!canRender || exportMut.isPending}
        pending={exportMut.isPending}
        onClick={() => exportMut.mutate()}
        className="bg-accent-hot/80 hover:bg-accent-hot"
      >
        <FileVideo className="h-3.5 w-3.5" />
        Export
      </ProgressButton>

      {lastExportUrl && !exportMut.isPending && (
        <a
          href={lastExportUrl}
          download
          className={btn("bg-zinc-800 hover:bg-zinc-700")}
          title="Download last export"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}

      <div className="ml-auto flex items-center gap-3">
        <div className="text-xs font-mono text-zinc-400 tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
        <button
          onClick={() => togglePlay()}
          className={clsx(
            "flex items-center justify-center h-8 w-8 rounded-md",
            "bg-zinc-800 hover:bg-zinc-700 transition-colors",
          )}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}

function ProgressButton({
  task,
  disabled,
  pending,
  onClick,
  className,
  children,
}: {
  task: TaskKey;
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const state = useProgress((s) => s.tasks[task]);
  const showProgress = state.active || (pending && state.frac < 1);
  const frac = Math.max(0, Math.min(1, state.frac));
  const pct = Math.round(frac * 100);

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "relative overflow-hidden inline-flex items-center gap-1.5 px-3 h-8 rounded-md",
        "text-xs font-medium text-white transition-colors select-none",
        "disabled:opacity-40",
        className,
      )}
    >
      {showProgress && (
        <span
          className="absolute inset-y-0 left-0 bg-white/15 transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      )}
      <span className="relative flex items-center gap-1.5">
        {children}
        {showProgress && (
          <span className="font-mono tabular-nums opacity-80">{pct}%</span>
        )}
      </span>
    </button>
  );
}

function UploadButton({
  label,
  accept,
  onFile,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => void;
}) {
  return (
    <label className={btn("bg-zinc-800 hover:bg-zinc-700 cursor-pointer")}>
      <Upload className="h-3.5 w-3.5" />
      {label}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function btn(extra: string): string {
  return clsx(
    "inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium text-white",
    "transition-colors select-none",
    extra,
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
