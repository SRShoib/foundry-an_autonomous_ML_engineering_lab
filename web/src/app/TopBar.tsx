import type { ReactNode } from "react";
import { Link } from "react-router";

import type { RunStatusKind } from "../api/types";
import { DisconnectedBar } from "../components/states/DisconnectedBar";
import type { ConnectionState } from "../run/RunSource";
import { ReplayTransport } from "./ReplayTransport";
import { RunStatusPill, StreamHealthPill } from "./StatusPills";
import { ThemeToggle } from "./ThemeToggle";

export interface Meta {
  label: string;
  value: string;
}

interface TopBarProps {
  /** Spaced columns, each a muted micro-label over a mono value — separated by whitespace and a 1px
   * rule, never by a middle dot (the SPEC avoid-list, design-plan self-critique 5). */
  meta?: readonly Meta[];
  status?: RunStatusKind | null;
  connection?: ConnectionState;
  mode?: "live" | "replay";
  /** Renders the replay transport; it draws nothing for a live run. */
  transport?: boolean;
  children?: ReactNode;
}

export function TopBar({
  meta = [],
  status,
  connection,
  mode = "live",
  transport = false,
  children,
}: TopBarProps) {
  return (
    <div className="bg-surface-abyss">
      <div className="flex h-(--layout-topbar) items-center gap-2 border-b border-line-hairline px-4 frame:gap-4">
        <Link to="/runs" className="text-md font-semibold text-fg">
          foundry
        </Link>

        <dl className="hidden min-w-0 items-center gap-4 frame:flex">
          {meta.map((item) => (
            <div key={item.label} className="flex flex-col border-l border-line-hairline pl-4">
              <dt className="text-2xs text-fg-muted">{item.label}</dt>
              <dd className="num truncate text-sm text-fg">{item.value}</dd>
            </div>
          ))}
        </dl>

        <div className="ml-auto flex items-center gap-2 frame:gap-4">
          {/* Below the frame breakpoint these live in the instrument bar; showing both would say
              everything twice. */}
          <div className="hidden items-center gap-4 frame:flex">
            {status !== undefined && <RunStatusPill status={status} />}
            {connection !== undefined && <StreamHealthPill connection={connection} mode={mode} />}
          </div>
          {transport && <ReplayTransport />}
          {children}
          <ThemeToggle />
        </div>
      </div>
      <DisconnectedBar connection={connection ?? "idle"} />
    </div>
  );
}
