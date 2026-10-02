import type { RunStatusKind } from "../api/types";
import { formatUsd } from "../lib/format";
import { METER_FILL, meterTone, spendFraction } from "../lib/meter";
import type { ConnectionState } from "../run/RunSource";
import { RunStatusPill, StreamHealthPill } from "./StatusPills";

interface InstrumentBarProps {
  status: RunStatusKind | null;
  spentUsd: number;
  budgetUsd: number;
  connection: ConnectionState;
  mode: "live" | "replay";
}

/** Below the three-column breakpoint the design keeps a 44px sticky bar carrying the three values
 * that must never be lost — phase, spend, stream health — plus a 2px full-bleed budget line
 * (docs/design-plan.md §5, Mobile). Everything else moves into tabs; the columns are deliberately
 * NOT reflowed into a scroll stack, because that would destroy the rule that a value lives at a
 * stable position. M9h: the status and stream pills are chips, and the bar's ground is the deck at
 * 70% so the aurora still reads through it. */
export function InstrumentBar({ status, spentUsd, budgetUsd, connection, mode }: InstrumentBarProps) {
  const fraction = spendFraction(spentUsd, budgetUsd);

  return (
    <div className="sticky top-0 z-10 bg-surface-deck/70 frame:hidden">
      <div className="flex h-(--layout-instrument-bar) items-center justify-between gap-2 border-b border-line-hairline px-4">
        <RunStatusPill status={status} />
        <span className="num text-sm text-fg">
          {formatUsd(spentUsd)}/{formatUsd(budgetUsd)}
        </span>
        <StreamHealthPill connection={connection} mode={mode} />
      </div>
      <div aria-hidden="true" className="h-0.5 bg-meter-track">
        <div
          className={`h-full ${METER_FILL[meterTone(fraction)]}`}
          style={{ width: `${(fraction * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}
