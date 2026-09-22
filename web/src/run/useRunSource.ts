import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { RunSource, RunSourceState } from "./RunSource";

/** Subscribes a component to a RunSource. The third argument (the server snapshot) is the same
 * function: there is no server render, but React requires one when the store can be read during
 * hydration, and a source's snapshot is already a stable, cached object. */
export function useRunSourceState(source: RunSource): RunSourceState {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Owns a source's lifecycle: creates it once per `key`, starts it on mount, stops it on unmount.
 *
 * StrictMode mounts, unmounts and remounts every effect in development. That is safe here because
 * RunSource.start() is idempotent and restartable — a live source de-duplicates by seq when it
 * reconnects, and a replay resumes from where it was — which is exactly why both were written to
 * be, rather than this hook working around them. */
export function useManagedRunSource(create: () => RunSource, key: string): RunSource {
  // `create` is deliberately not a dependency: the source is identified by `key` (a thread id or
  // a replay name), and a new closure each render must not build a new source.
  const source = useMemo(create, [key]);
  useEffect(() => {
    source.start();
    return () => source.stop();
  }, [source]);
  return source;
}
