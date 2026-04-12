import { create } from "zustand";

export type TaskKey = "analyze" | "render_export";

interface TaskState {
  active: boolean;
  frac: number;
  stage: string;
  error: string | null;
}

interface ProgressState {
  tasks: Record<TaskKey, TaskState>;
  start: (task: TaskKey, stage?: string) => void;
  update: (task: TaskKey, frac: number, stage: string) => void;
  finish: (task: TaskKey) => void;
  fail: (task: TaskKey, error: string) => void;
}

const empty = (): TaskState => ({ active: false, frac: 0, stage: "", error: null });

export const useProgress = create<ProgressState>((set) => ({
  tasks: {
    analyze: empty(),
    render_export: empty(),
  },
  start: (task, stage = "starting...") =>
    set((s) => ({
      tasks: { ...s.tasks, [task]: { active: true, frac: 0, stage, error: null } },
    })),
  update: (task, frac, stage) =>
    set((s) => ({
      tasks: {
        ...s.tasks,
        [task]: { active: true, frac, stage, error: null },
      },
    })),
  finish: (task) =>
    set((s) => ({
      tasks: {
        ...s.tasks,
        [task]: { active: false, frac: 1, stage: "done", error: null },
      },
    })),
  fail: (task, error) =>
    set((s) => ({
      tasks: { ...s.tasks, [task]: { active: false, frac: 0, stage: "error", error } },
    })),
}));
