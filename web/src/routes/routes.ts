/** Route patterns for <Route path>, and builders for links. Kept together so a path is spelled in
 * exactly one place. */
export const ROUTES = {
  home: "/",
  runs: "/runs",
  run: "/runs/:threadId",
  report: "/runs/:threadId/report",
  replay: "/replay/:name",
  eval: "/eval",
} as const;

export const links = {
  run: (threadId: string): string => `/runs/${encodeURIComponent(threadId)}`,
  report: (threadId: string): string => `/runs/${encodeURIComponent(threadId)}/report`,
  replay: (name: string): string => `/replay/${encodeURIComponent(name)}`,
} as const;

/** The recording SPEC M9 requires: the red team catching the booby-trapped dataset. Committed under
 * web/public/replays, so it plays with the API stopped. */
export const DEMO_REPLAY = "demo-churn-leaky";
