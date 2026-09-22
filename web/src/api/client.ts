import createClient, { type Client } from "openapi-fetch";

import type { paths } from "./schema";

/** The FastAPI app serves its routes at the root, so the console reaches it through `/api` and both
 * proxies strip the prefix (vite.config.ts in dev, docker/web/Caddyfile when built). */
export const API_BASE = "/api";

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  baseUrl?: string;
  /** Injected by tests: Node's fetch cannot resolve a relative baseUrl like `/api`. */
  fetch?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? API_BASE,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export const api: ApiClient = createApiClient();

/** A non-2xx API response. `detail` is FastAPI's own message, shown verbatim in error states
 * (docs/design-plan.md §9: name the failure and the fix, never a generic "something went wrong"). */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  /** True when `detail` is FastAPI's own message. False when it is only an HTTP status line — which
   * is what a proxy (Vite in dev, Caddy when built) answers with when the API behind it is down:
   * a bare 502, with no `detail`. That difference is how the console tells "the API said no" from
   * "the API is not there". */
  readonly fromApi: boolean;

  constructor(status: number, detail: string, fromApi = true) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.fromApi = fromApi;
  }
}

/** The API could not be reached: fetch itself failed (no connection), or a gateway answered for it. */
export function isApiUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return !error.fromApi && error.status >= 500;
  return error instanceof TypeError;
}

function detailOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    // FastAPI's 422 carries a list of validation problems; flatten to their messages.
    if (Array.isArray(detail)) {
      return detail
        .map((item: unknown) =>
          typeof item === "object" && item !== null && "msg" in item
            ? String((item as { msg: unknown }).msg)
            : String(item),
        )
        .join("; ");
    }
  }
  return undefined;
}

/** Collapses openapi-fetch's `{ data, error, response }` into data-or-throw, which is what
 * TanStack Query wants from a queryFn. */
export function unwrap<T>(result: {
  data?: T | undefined;
  error?: unknown;
  response: Response;
}): T {
  if (result.error !== undefined || result.data === undefined) {
    const { status, statusText } = result.response;
    const detail = detailOf(result.error);
    throw new ApiError(status, detail ?? (statusText || `HTTP ${status}`), detail !== undefined);
  }
  return result.data;
}
