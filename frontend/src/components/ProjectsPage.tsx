import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Music, Film, Pencil, Check, X, FolderOpen } from "lucide-react";
import clsx from "clsx";
import { api, type Project } from "@/api/client";

interface ProjectsPageProps {
  onSelect: (projectId: string) => void;
}

export function ProjectsPage({ onSelect }: ProjectsPageProps) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: (proj) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onSelect(proj.id);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDeletingId(null);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameProject(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setRenamingId(null);
    },
  });

  const projects = [...(projectsQuery.data ?? [])].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  const handleCreate = () => {
    const name = newName.trim() || "Untitled";
    createMut.mutate(name);
    setNewName("");
  };

  return (
    <div className="h-screen w-screen bg-zinc-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800/80 px-8 py-6 flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-accent/20 grid place-items-center">
            <Music className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Music Video Maker</h1>
            <p className="text-[11px] text-zinc-500">Select a project or create a new one</p>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* New Project Card */}
            <div className="surface rounded-xl p-5 flex flex-col items-center justify-center gap-3 min-h-[180px] border-dashed border-2 border-zinc-700 hover:border-accent/50 transition-colors">
              <div className="h-12 w-12 rounded-full bg-accent/10 grid place-items-center">
                <Plus className="h-6 w-6 text-accent" />
              </div>
              <div className="flex items-center gap-2 w-full">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="Project name..."
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 h-9 text-sm focus:border-accent/50 focus:outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={createMut.isPending}
                  className="h-9 px-4 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-medium transition-colors disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </div>

            {/* Project Cards */}
            {projects.map((proj) => (
              <ProjectCard
                key={proj.id}
                project={proj}
                isRenaming={renamingId === proj.id}
                renameText={renameText}
                isDeleting={deletingId === proj.id}
                onOpen={() => onSelect(proj.id)}
                onStartRename={() => {
                  setRenamingId(proj.id);
                  setRenameText(proj.name);
                }}
                onCancelRename={() => setRenamingId(null)}
                onConfirmRename={() => renameMut.mutate({ id: proj.id, name: renameText })}
                onRenameTextChange={setRenameText}
                onStartDelete={() => setDeletingId(proj.id)}
                onCancelDelete={() => setDeletingId(null)}
                onConfirmDelete={() => deleteMut.mutate(proj.id)}
              />
            ))}
          </div>

          {projects.length === 0 && !projectsQuery.isLoading && (
            <div className="text-center text-zinc-500 py-16">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 text-zinc-700" />
              <p>No projects yet. Create one to get started.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function ProjectCard({
  project,
  isRenaming,
  renameText,
  isDeleting,
  onOpen,
  onStartRename,
  onCancelRename,
  onConfirmRename,
  onRenameTextChange,
  onStartDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  project: Project;
  isRenaming: boolean;
  renameText: string;
  isDeleting: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onConfirmRename: () => void;
  onRenameTextChange: (v: string) => void;
  onStartDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const hasAudio = !!project.audio;
  const clipCount = project.clips?.length ?? 0;
  const cutCount = project.edl?.length ?? 0;
  const updatedAt = new Date(project.updated_at);
  const timeAgo = formatTimeAgo(updatedAt);

  return (
    <div
      className={clsx(
        "surface rounded-xl p-5 flex flex-col gap-3 min-h-[180px] cursor-pointer",
        "hover:border-accent/40 hover:shadow-lg hover:shadow-accent/5 transition-all group",
      )}
      onClick={() => !isRenaming && !isDeleting && onOpen()}
    >
      {/* Title row */}
      <div className="flex items-start gap-2">
        <div className="h-9 w-9 rounded-lg bg-zinc-800 grid place-items-center shrink-0">
          {hasAudio ? (
            <Music className="h-4 w-4 text-accent" />
          ) : (
            <Film className="h-4 w-4 text-zinc-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                value={renameText}
                onChange={(e) => onRenameTextChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onConfirmRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                autoFocus
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 h-7 text-sm"
              />
              <button onClick={onConfirmRename} className="text-green-400 hover:text-green-300">
                <Check className="h-4 w-4" />
              </button>
              <button onClick={onCancelRename} className="text-zinc-500 hover:text-zinc-300">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <h3 className="text-sm font-medium truncate">{project.name}</h3>
          )}
          <p className="text-[10px] text-zinc-500 mt-0.5">{timeAgo}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[10px] text-zinc-500">
        {hasAudio && <span className="text-accent">Audio</span>}
        <span>{clipCount} clip{clipCount !== 1 ? "s" : ""}</span>
        {cutCount > 0 && <span>{cutCount} cuts</span>}
        <span className="font-mono">{project.width}×{project.height}</span>
      </div>

      {/* Audio filename */}
      {project.audio && (
        <div className="text-[10px] text-zinc-600 font-mono truncate">
          {project.audio.filename}
        </div>
      )}

      {/* Actions */}
      <div className="mt-auto flex items-center gap-2 pt-2 border-t border-zinc-800/50">
        {isDeleting ? (
          <div className="flex items-center gap-2 text-[11px]" onClick={(e) => e.stopPropagation()}>
            <span className="text-red-400">Delete?</span>
            <button onClick={onConfirmDelete} className="text-red-400 hover:text-red-300 font-medium">Yes</button>
            <button onClick={onCancelDelete} className="text-zinc-500 hover:text-zinc-300">No</button>
          </div>
        ) : (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onStartRename(); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 transition-opacity"
              title="Rename"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onStartDelete(); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <span className="ml-auto text-[10px] text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity">
              Click to open
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
