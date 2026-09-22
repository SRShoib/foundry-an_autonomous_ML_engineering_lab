import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ApiClientContext } from "./ApiClientContext";
import { ApiError, createApiClient, isApiUnreachable, unwrap } from "./client";
import { queryKeys, useEvalResults, useResumeRun, useRun, useRuns, useStartRun } from "./queries";
import { createQueryClient, shouldRetry } from "./queryClient";
import { fakeApi, TEST_BASE_URL, type FakeRoutes } from "../test/fakeApi";
import { makeRunStatus } from "../test/fixtures";

function setup(routes: FakeRoutes) {
  const fake = fakeApi(routes);
  const queryClient = createQueryClient();
  const client = createApiClient({ baseUrl: TEST_BASE_URL, fetch: fake.fetch });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ApiClientContext value={client}>{children}</ApiClientContext>
    </QueryClientProvider>
  );
  return { fake, queryClient, wrapper };
}

describe("queries", () => {
  it("useRun returns the run's status", async () => {
    const { wrapper } = setup({
      "GET /runs/t-1": () => ({ json: makeRunStatus({ spent_usd: 1.5 }) }),
    });
    const { result } = renderHook(() => useRun("t-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.spent_usd).toBe(1.5);
  });

  it("does not fetch until it has a thread id", () => {
    const { fake, wrapper } = setup({});
    renderHook(() => useRun(undefined), { wrapper });
    expect(fake.calls).toEqual([]);
  });

  it("surfaces FastAPI's own message verbatim on a 404, and does not retry it", async () => {
    const { fake, wrapper } = setup({
      "GET /runs/nope": () => ({ status: 404, json: { detail: "unknown thread_id 'nope'" } }),
    });
    const { result } = renderHook(() => useRun("nope"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
    expect((result.current.error as ApiError).detail).toBe("unknown thread_id 'nope'");
    expect(fake.callsTo("GET /runs/nope")).toHaveLength(1);
  });

  it("carries the eval route's fix-naming message through to the error state", async () => {
    const { wrapper } = setup({
      "GET /eval": () => ({ status: 404, json: { detail: "no eval results yet; run `make eval`" } }),
    });
    const { result } = renderHook(() => useEvalResults(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).detail).toContain("make eval");
  });

  it("useStartRun posts the request body and refreshes the run list", async () => {
    let listed = 0;
    const { fake, wrapper } = setup({
      "GET /runs": () => ({ json: listed++ === 0 ? [] : [makeRunStatus()] }),
      "POST /runs": () => ({ status: 202, json: { thread_id: "t-9", status: "running" } }),
    });
    const list = renderHook(() => useRuns(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(list.result.current.data).toEqual([]);

    const start = renderHook(() => useStartRun(), { wrapper });
    start.result.current.mutate({ task: "churn_leaky", goal: "predict churn", budget_usd: 1 });
    await waitFor(() => expect(start.result.current.isSuccess).toBe(true));

    expect(fake.callsTo("POST /runs")[0]?.body).toEqual({
      task: "churn_leaky",
      goal: "predict churn",
      budget_usd: 1,
    });
    await waitFor(() => expect(list.result.current.data).toHaveLength(1));
  });

  it("useResumeRun posts the decision to that run and refreshes it", async () => {
    const { fake, wrapper, queryClient } = setup({
      "POST /runs/t-1/resume": () => ({ status: 202, json: { thread_id: "t-1", status: "running" } }),
      "GET /runs/t-1": () => ({ json: makeRunStatus() }),
    });
    queryClient.setQueryData(queryKeys.run("t-1"), makeRunStatus({ status: "awaiting_approval" }));

    const { result } = renderHook(() => useResumeRun("t-1"), { wrapper });
    result.current.mutate({ approved: true, note: "looks right" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fake.callsTo("POST /runs/t-1/resume")[0]?.body).toEqual({
      approved: true,
      note: "looks right",
    });
  });
});

describe("shouldRetry", () => {
  it("never retries a 4xx, which is the API telling us something true", () => {
    expect(shouldRetry(0, new ApiError(404, "unknown"))).toBe(false);
    expect(shouldRetry(0, new ApiError(409, "no pending approval"))).toBe(false);
  });

  it("retries a 5xx or a network fault, twice", () => {
    expect(shouldRetry(0, new ApiError(500, "boom"))).toBe(true);
    expect(shouldRetry(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(2, new ApiError(500, "boom"))).toBe(false);
  });
});

describe("unwrap", () => {
  const response = (status: number, statusText = "") => new Response(null, { status, statusText });

  it("returns data on success", () => {
    expect(unwrap({ data: { ok: 1 }, response: response(200) })).toEqual({ ok: 1 });
  });

  it("flattens a FastAPI 422 validation list into readable messages", () => {
    const error = { detail: [{ msg: "Field required" }, { msg: "Input should be a valid number" }] };
    expect(() => unwrap({ error, response: response(422) })).toThrow("Field required; Input should be a valid number");
  });

  it("falls back to the HTTP status text when there is no detail", () => {
    expect(() => unwrap({ error: {}, response: response(503, "Service Unavailable") })).toThrow(
      "Service Unavailable",
    );
  });

  it("records whether the message came from the API or is only a status line", () => {
    const fromApi = (() => {
      try {
        unwrap({ error: { detail: "unknown thread_id 'x'" }, response: response(404) });
      } catch (e) {
        return e as ApiError;
      }
    })();
    const fromProxy = (() => {
      try {
        unwrap({ error: {}, response: response(502, "Bad Gateway") });
      } catch (e) {
        return e as ApiError;
      }
    })();
    expect(fromApi?.fromApi).toBe(true);
    expect(fromProxy?.fromApi).toBe(false);
  });
});

describe("isApiUnreachable", () => {
  it("is true for a fetch that failed outright, and for a gateway's bare 5xx", () => {
    expect(isApiUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isApiUnreachable(new ApiError(502, "Bad Gateway", false))).toBe(true);
    expect(isApiUnreachable(new ApiError(503, "Service Unavailable", false))).toBe(true);
    expect(isApiUnreachable(new ApiError(500, "Internal Server Error", false))).toBe(true);
  });

  it("is false when the API itself answered, whatever it said", () => {
    expect(isApiUnreachable(new ApiError(500, "docker daemon went away", true))).toBe(false);
    expect(isApiUnreachable(new ApiError(404, "unknown thread_id", true))).toBe(false);
    expect(isApiUnreachable(new ApiError(404, "Not Found", false))).toBe(false); // 4xx is never "down"
    expect(isApiUnreachable(new Error("boom"))).toBe(false);
    expect(isApiUnreachable("boom")).toBe(false);
  });
});
