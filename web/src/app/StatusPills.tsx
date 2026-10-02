import { Check, Hourglass, TriangleAlert, type LucideIcon } from "lucide-react";

import type { RunStatusKind } from "../api/types";
import { Chip, type ChipTone } from "../components/ui/Chip";
import type { ConnectionState } from "../run/RunSource";

/** Colour is never the only carrier of state (WCAG 1.4.1): every pill is a `Chip`, which pairs its
 * tone-coloured mark with a text label. Run status and stream health are separate pills because they
 * answer different questions — "what is the run doing" and "can I trust that I am seeing it live". */

const RUN_STATUS: Record<RunStatusKind, { label: string; tone: ChipTone; icon?: LucideIcon; live?: boolean }> = {
  // The ping ring is reserved (§7) for "this is happening right now": running, and a live stream.
  running: { label: "running", tone: "info", live: true },
  awaiting_approval: { label: "awaiting approval", tone: "warn", icon: Hourglass },
  completed: { label: "completed", tone: "ok", icon: Check },
  failed: { label: "failed", tone: "danger", icon: TriangleAlert },
};

export function RunStatusPill({ status }: { status: RunStatusKind | null }) {
  if (status === null) {
    return (
      <Chip tone="idle" title="run status">
        not started
      </Chip>
    );
  }
  const { label, tone, icon, live } = RUN_STATUS[status];
  return (
    <Chip tone={tone} title="run status" {...(icon === undefined ? {} : { icon })} live={live === true}>
      {label}
    </Chip>
  );
}

export interface StreamHealth {
  label: string;
  tone: ChipTone;
  /** True only for a live stream that is open: the one state the pill's glow and ping ring exist for. */
  live: boolean;
}

export function streamHealth(connection: ConnectionState, mode: "live" | "replay"): StreamHealth {
  if (mode === "replay") {
    return connection === "closed"
      ? { label: "replay ended", tone: "idle", live: false }
      : { label: "replay", tone: "info", live: false };
  }
  switch (connection) {
    case "open":
      return { label: "live", tone: "ok", live: true };
    case "connecting":
      return { label: "connecting", tone: "info", live: false };
    case "reconnecting":
      return { label: "reconnecting", tone: "warn", live: false };
    case "error":
      return { label: "disconnected", tone: "danger", live: false };
    case "closed":
      return { label: "stream ended", tone: "idle", live: false };
    case "idle":
      return { label: "idle", tone: "idle", live: false };
  }
}

/** §7 (revised M9h): the live pill carries the one resting glow in the product plus a slow ping ring,
 * reserved for "you are watching this happen right now" — the single state this pill exists to
 * answer. `shadow-glow-ok` is a token, so it clears the shadows-are-tokenized rule. */
export function StreamHealthPill({
  connection,
  mode,
}: {
  connection: ConnectionState;
  mode: "live" | "replay";
}) {
  const { label, tone, live } = streamHealth(connection, mode);
  return (
    <Chip tone={tone} title="stream health" live={live} {...(live ? { className: "shadow-glow-ok" } : {})}>
      {label}
    </Chip>
  );
}
