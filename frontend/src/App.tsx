import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AnalyzeSummary, type Project } from "@/api/client";
import { Topbar } from "@/components/Topbar";
import { MediaBin } from "@/components/MediaBin";
import { PreviewCanvas } from "@/components/Preview/PreviewCanvas";
import { ModulationMatrix } from "@/components/ModulationMatrix/ModulationMatrix";
import { Timeline } from "@/components/Timeline/Timeline";
import { ResolutionPicker } from "@/components/ResolutionPicker";
import { ProjectsPage } from "@/components/ProjectsPage";
import { decodeBake } from "@/preview/modulation";
import { useProjectSocket } from "@/hooks/useProjectSocket";
import { usePlayback } from "@/store/playback";

const LAST_PROJECT_KEY = "mvm:last-project";

export default function App() {
  const queryClient = useQueryClient();
  const [showProjects, setShowProjects] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    localStorage.getItem(LAST_PROJECT_KEY),
  );

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });

  const projectId = (() => {
    if (selectedProjectId && projectsQuery.data?.some((p) => p.id === selectedProjectId))
      return selectedProjectId;
    return projectsQuery.data?.[0]?.id ?? null;
  })();

  useEffect(() => {
    if (projectId) {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
      setSelectedProjectId(projectId);
    }
  }, [projectId]);

  const handleSelectProject = useCallback((id: string) => {
    localStorage.setItem(LAST_PROJECT_KEY, id);
    setSelectedProjectId(id);
    setShowProjects(false);
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  }, [queryClient]);

  const [lastExportUrl, setLastExportUrl] = useState<string | null>(null);
  const handleSocketMessage = useCallback((msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === "render_done" && typeof msg.url === "string") {
      setLastExportUrl(msg.url);
    }
  }, []);
  useProjectSocket(projectId, handleSocketMessage);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
    // Single-user local tool — WS events drive all external updates and
    // mutations carry fresh server data via setQueryData. Background
    // staleness refetches only create noise (and caused a GET storm).
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  const project: Project | undefined = projectQuery.data;

  const uploadAudioMut = useMutation({
    mutationFn: (file: File) => api.uploadAudio(projectId!, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const uploadClipMut = useMutation({
    mutationFn: (file: File) => api.uploadClip(projectId!, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const audioAnalyzed = !!project?.audio?.analyzed;

  const summaryQuery = useQuery({
    queryKey: ["summary", projectId],
    queryFn: () => api.getSummary(projectId!),
    enabled: !!projectId && audioAnalyzed,
  });
  const summary: AnalyzeSummary | null = summaryQuery.data ?? null;

  const bakeQuery = useQuery({
    queryKey: ["bake", projectId],
    queryFn: async () => decodeBake(await api.bakeModulation(projectId!)),
    enabled: !!projectId && audioAnalyzed,
    // Bake is a heavy binary blob — only refetch when we explicitly
    // invalidate (on patches_changed / effect_chain_changed / arrange_done).
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const clips = useMemo(() => project?.clips ?? [], [project?.clips]);
  const edl = useMemo(() => project?.edl ?? [], [project?.edl]);
  const effectChain = useMemo(() => project?.effect_chain ?? [], [project?.effect_chain]);
  const patches = useMemo(() => project?.patches ?? [], [project?.patches]);
  const outputWidth = project?.width && project.width > 0 ? project.width : 1920;
  const outputHeight = project?.height && project.height > 0 ? project.height : 1080;
  const [beatsPerCut, setBeatsPerCut] = useState(4);

  useEffect(() => {
    if (project?.beats_per_cut) setBeatsPerCut(project.beats_per_cut);
  }, [project?.beats_per_cut]);

  const handleBeatsPerBarChange = useCallback((v: number | null) => {
    if (!projectId) return;
    api.setMeter(projectId, v).then((proj) => {
      queryClient.setQueryData(["project", projectId], proj);
    });
  }, [projectId, queryClient]);

  // Space = play/pause (via store so it drives the real audio element).
  const togglePlay = usePlayback((s) => s.togglePlay);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLSelectElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  if (showProjects || !projectId) {
    return <ProjectsPage onSelect={handleSelectProject} />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-zinc-950">
      <Topbar
        projectId={projectId}
        projectName={project?.name ?? "Loading..."}
        audioReady={!!project?.audio}
        canArrange={audioAnalyzed && clips.length > 0}
        canRender={audioAnalyzed && edl.length > 0}
        lastExportUrl={lastExportUrl}
        beatsPerCut={beatsPerCut}
        beatsPerBar={project?.beats_per_bar ?? null}
        onUploadAudio={(f) => uploadAudioMut.mutate(f)}
        onUploadClip={(f) => uploadClipMut.mutate(f)}
        onBeatsPerCutChange={setBeatsPerCut}
        onBeatsPerBarChange={handleBeatsPerBarChange}
        onShowProjects={() => setShowProjects(true)}
      />
      <main className="flex-1 min-h-0 grid grid-cols-[220px_1fr_520px] gap-2 p-2">
        <MediaBin projectId={projectId} clips={clips} />

        <div className="flex flex-col gap-2 min-h-0 min-w-0">
          <div className="relative z-10 surface rounded-lg px-3 py-2 flex items-center gap-3 text-[11px] text-zinc-400 shrink-0">
            <ResolutionPicker
              projectId={projectId}
              width={outputWidth}
              height={outputHeight}
              fps={project?.fps ?? 30}
            />
            <span className="ml-auto text-zinc-500">Space = play/pause</span>
          </div>
          <div className="flex-1 min-h-0">
            <PreviewCanvas
              clips={clips}
              edl={edl}
              audioUrl={project?.audio?.url ?? null}
              baked={bakeQuery.data ?? null}
              effectChain={effectChain}
              outputWidth={outputWidth}
              outputHeight={outputHeight}
              audioAnalyzed={audioAnalyzed}
              bakeLoading={bakeQuery.isFetching}
            />
          </div>
        </div>

        <ModulationMatrix
          projectId={projectId}
          patches={patches}
          effectChain={effectChain}
          summary={summary}
          baked={bakeQuery.data ?? null}
          preset={project?.preset ?? null}
        />
      </main>
      <footer className="shrink-0 px-2 pb-2 max-h-[50vh]">
        <Timeline
          projectId={projectId}
          audioUrl={project?.audio?.url ?? null}
          summary={summary}
          beatTimes={summary?.beat_times ?? []}
          downbeatTimes={summary?.downbeat_times ?? []}
          edl={edl}
          clips={clips}
        />
      </footer>
    </div>
  );
}
