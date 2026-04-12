import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/** Fetches a continuous Float32 signal from the backend, cached per (project, name). */
export function useSignal(projectId: string | null, name: string, enabled = true) {
  return useQuery({
    queryKey: ["signal", projectId, name],
    queryFn: () => api.getSignal(projectId!, name),
    enabled: !!projectId && enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
