import type { RunStatusKind } from "../api/types";
import { cn } from "../lib/cn";
import type { ConnectionState } from "../run/RunSource";

/** Colour is never the only carrier of state (WCAG 1.4.1): every pill pairs its dot with a text
 * label. Run status and stream health are separate pills because they answer different questions —
 * "what is the run doing" and "can I trust that I am seeing it live". */

const RUN_STATUS: Record<RunStatusKind, { label: string; tone: string }> = {
  running: { label: "running", tone: "text-status-info" },
  awaiting_approval: { label: "awaiting approval", tone: "text-status-warn" },
  completed: { label: "completed", tone: "text-status-ok" },
  failed: { label: "failed", tone: "text-status-danger" },
};

/** `glow`: §7 M9g's one narrow, static (never pulsing) glow — reserved for "you are watching this
 * happen right now", the single state the stream-health pill exists to answer. `var(--status-ok)`
 * inside the arbitrary value is a token reference, not a literal colour, so it clears
 * no-raw-colour. */
function Pill({ tone, label, hint, glow = false }: { tone: string; label: string; hint: string; glow?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-fg-secondary" title={hint}>
      <span aria-hidden="true" className={cn(tone, "text-xs", glow && "drop-shadow-[0_0_6px_var(--status-ok)]")}>
        ●
      </span>
      <span>{label}</span>
    </span>
  );
}

export function RunStatusPill({ status }: { status: RunStatusKind | null }) {
  if (status === null) return <Pill tone="text-status-idle" label="not started" hint="run status" />;
  const { label, tone } = RUN_STATUS[status];
  return <Pill tone={tone} label={label} hint="run status" />;
}

export function streamHealth(
  connection: ConnectionState,
  mode: "live" | "replay",
): { label: string; tone: string } {
  if (mode === "replay") {
    return connection === "closed"
      ? { label: "replay ended", tone: "text-status-idle" }
      : { label: "replay", tone: "text-status-info" };
  }
  switch (connection) {
    case "open":
      return { label: "live", tone: "text-status-ok" };
    case "connecting":
      return { label: "connecting", tone: "text-status-info" };
    case "reconnecting":
      return { label: "reconnecting", tone: "text-status-warn" };
    case "error":
      return { label: "disconnected", tone: "text-status-danger" };
    case "closed":
      return { label: "stream ended", tone: "text-status-idle" };
    case "idle":
      return { label: "idle", tone: "text-status-idle" };
  }
}

export function StreamHealthPill({
  connection,
  mode,
}: {
  connection: ConnectionState;
  mode: "live" | "replay";
}) {
  const { label, tone } = streamHealth(connection, mode);
  return <Pill tone={tone} label={label} hint="stream health" glow={mode === "live" && connection === "open"} />;
}
