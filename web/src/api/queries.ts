/** TanStack Query owns request/response server state: the run list, one run's status, the eval
 * table, the replay list, and the two mutations. It deliberately does NOT own the event stream —
 * that is a push source with its own batching and reconnect policy (src/run/), which invalidates
 * `queryKeys.run(id)` rather than keeping a second copy of the status. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "./ApiClientContext";
import { unwrap } from "./client";
import type {
  DatasetOption,
  ExperimentResult,
  PendingApproval,
  ReplaySummary,
  ResumeRequest,
  RunStatus,
  StartRunRequest,
  StartRunResponse,
  TaskResult,
} from "./types";

export const queryKeys = {
  runs: ["runs"] as const,
  run: (threadId: string) => ["run", threadId] as const,
  experiments: (threadId: string) => ["experiments", threadId] as const,
  approvals: ["approvals"] as const,
  evalResults: ["eval"] as const,
  replays: ["replays"] as const,
  datasets: ["datasets"] as const,
};

/** Runs home (M9e) polls: a run's spend and its `updated_at` age are live values that move even
 * with nobody watching the individual run's own SSE stream. 4s matches BudgetMeter's own sense of
 * "current" closely enough for a list view without hammering the API. */
const RUNS_LIST_REFETCH_MS = 4000;

export function useRuns(): UseQueryResult<RunStatus[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: async ({ signal }) => unwrap(await api.GET("/runs", { signal })),
    refetchInterval: RUNS_LIST_REFETCH_MS,
  });
}

export function useDatasets(): UseQueryResult<DatasetOption[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.datasets,
    queryFn: async ({ signal }) => unwrap(await api.GET("/datasets", { signal })),
    staleTime: Number.POSITIVE_INFINITY, // the bundled registry never changes at runtime
  });
}

export function useRun(threadId: string | undefined): UseQueryResult<RunStatus> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.run(threadId ?? ""),
    enabled: threadId !== undefined,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET("/runs/{thread_id}", {
          params: { path: { thread_id: threadId ?? "" } },
          signal,
        }),
      ),
  });
}

export function useExperiments(threadId: string | undefined): UseQueryResult<ExperimentResult[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.experiments(threadId ?? ""),
    enabled: threadId !== undefined,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET("/runs/{thread_id}/experiments", {
          params: { path: { thread_id: threadId ?? "" } },
          signal,
        }),
      ),
  });
}

export function useApprovals(): UseQueryResult<PendingApproval[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: async ({ signal }) => unwrap(await api.GET("/approvals", { signal })),
  });
}

export function useEvalResults(): UseQueryResult<TaskResult[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.evalResults,
    queryFn: async ({ signal }) => unwrap(await api.GET("/eval", { signal })),
  });
}

export function useReplays(): UseQueryResult<ReplaySummary[]> {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.replays,
    queryFn: async ({ signal }) => unwrap(await api.GET("/replays", { signal })),
  });
}

export function useStartRun(): UseMutationResult<StartRunResponse, Error, StartRunRequest> {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: StartRunRequest) => unwrap(await api.POST("/runs", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
  });
}

export function useResumeRun(
  threadId: string,
): UseMutationResult<StartRunResponse, Error, ResumeRequest> {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ResumeRequest) =>
      unwrap(
        await api.POST("/runs/{thread_id}/resume", {
          params: { path: { thread_id: threadId } },
          body,
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.run(threadId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals }),
      ]);
    },
  });
}
