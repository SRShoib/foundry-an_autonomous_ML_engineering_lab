import { useEffect, useRef, useState } from "react";

import type { ConnectionState } from "../../run/RunSource";

export type BarPhase = "hidden" | "indeterminate" | "completing";

/** docs/design-plan.md §7, stream disconnect: while reconnecting a 2px indeterminate line runs
 * under the top bar, and on reconnect it COMPLETES left to right rather than vanishing. So
 * reconnecting → open is "completing", but reconnecting → anything else (the client gave up, the
 * stream was closed) is not a recovery and must not be celebrated as one: it just hides. */
export function useDisconnectPhase(connection: ConnectionState, settleMs = 300): BarPhase {
  const [phase, setPhase] = useState<BarPhase>("hidden");
  const previous = useRef(connection);

  useEffect(() => {
    const before = previous.current;
    previous.current = connection;

    if (connection === "reconnecting") {
      setPhase("indeterminate");
      return;
    }
    if (before === "reconnecting" && connection === "open") {
      setPhase("completing");
      const timer = setTimeout(() => setPhase("hidden"), settleMs);
      return () => clearTimeout(timer);
    }
    setPhase("hidden");
  }, [connection, settleMs]);

  return phase;
}

/** A decorative line: the stream-health pill carries the same information in words. */
export function DisconnectedBar({ connection }: { connection: ConnectionState }) {
  const phase = useDisconnectPhase(connection);
  return (
    <div aria-hidden="true" data-phase={phase} className="relative h-0.5 overflow-hidden">
      {phase === "indeterminate" && <div className="bar-indeterminate h-full bg-status-warn" />}
      {phase === "completing" && <div className="bar-complete h-full bg-status-ok" />}
    </div>
  );
}
