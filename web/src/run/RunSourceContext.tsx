import { createContext, use, type ReactNode } from "react";

import type { RunSource, RunSourceState } from "./RunSource";
import { useRunSourceState } from "./useRunSource";

const RunSourceContext = createContext<RunSource | null>(null);

/** Everything below this provider reads the run through RunSource and cannot tell whether it is
 * live or a replay. That indifference is the point of the abstraction. */
export function RunSourceProvider({
  source,
  children,
}: {
  source: RunSource;
  children: ReactNode;
}) {
  return <RunSourceContext value={source}>{children}</RunSourceContext>;
}

export function useRunSource(): { source: RunSource; state: RunSourceState } {
  const source = use(RunSourceContext);
  if (source === null) throw new Error("useRunSource must be used inside a <RunSourceProvider>");
  return { source, state: useRunSourceState(source) };
}
