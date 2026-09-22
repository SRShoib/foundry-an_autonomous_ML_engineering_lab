import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./client";

/** A 4xx is the API telling us something true (unknown run, no eval results yet): retrying cannot
 * change it and only delays the error state that names the fix. Only network faults and 5xx retry. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}
