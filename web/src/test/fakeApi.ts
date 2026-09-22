/** A fake `fetch` for tests: routes are declared up front, every call is recorded, and an
 * unrouted call answers 500 with a message that names it — so a test that hits an endpoint it did
 * not expect fails loudly instead of hanging on the network. */

export interface RecordedRequest {
  method: string;
  path: string;
  url: string;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  /** Raw body, for stream tests. */
  body?: BodyInit | null;
  headers?: Record<string, string>;
}

export type FakeRoutes = Readonly<
  Record<string, (request: RecordedRequest) => FakeReply | Promise<FakeReply>>
>;

export interface FakeApi {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  callsTo: (route: string) => RecordedRequest[];
}

export const TEST_BASE_URL = "http://api.test/api";

export function fakeApi(routes: FakeRoutes): FakeApi {
  const calls: RecordedRequest[] = [];

  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "") + url.search;
    const text = request.method === "GET" ? "" : await request.clone().text();
    const recorded: RecordedRequest = {
      method: request.method,
      path,
      url: request.url,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    calls.push(recorded);

    const handler = routes[`${request.method} ${path}`];
    if (!handler) {
      return Response.json({ detail: `fakeApi: no route for ${request.method} ${path}` }, { status: 500 });
    }
    const reply = await handler(recorded);
    const status = reply.status ?? 200;
    if (reply.body !== undefined) {
      return new Response(reply.body, { status, headers: reply.headers ?? {} });
    }
    return Response.json(reply.json ?? null, { status, headers: reply.headers ?? {} });
  };

  return {
    fetch: fake as typeof fetch,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}
