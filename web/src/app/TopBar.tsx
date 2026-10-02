import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";

import type { RunStatusKind } from "../api/types";
import { Logo } from "../components/brand/Logo";
import { DisconnectedBar } from "../components/states/DisconnectedBar";
import { cn } from "../lib/cn";
import type { ConnectionState } from "../run/RunSource";
import { ReplayTransport } from "./ReplayTransport";
import { RunStatusPill, StreamHealthPill } from "./StatusPills";
import { ThemeToggle } from "./ThemeToggle";

/** M9e: the only way to reach /eval — sentence case, no tracked caps, no arrow (SPEC's avoid-list).
 * Shown only on the PageFrame screens (runs home, report, eval), via TopBarProps.nav — NOT on the
 * live run view, whose top bar is already at capacity on mobile (§5's instrument bar reserves it
 * for phase/spend/stream-health) and whose own "foundry" link is the way back to runs home. */
function PrimaryNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-control px-2.5 py-1 text-sm transition-colors duration-(--dur-quick) ease-out",
      isActive ? "bg-surface-raised text-fg" : "text-fg-secondary hover:bg-surface-raised/60 hover:text-fg",
    );
  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      <NavLink to="/runs" className={linkClass}>
        runs
      </NavLink>
      <NavLink to="/eval" className={linkClass}>
        eval
      </NavLink>
    </nav>
  );
}

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
  /** Shows the runs/eval PrimaryNav. Only PageFrame.tsx passes this — see PrimaryNav's docstring. */
  nav?: boolean;
  children?: ReactNode;
}

export function TopBar({
  meta = [],
  status,
  connection,
  mode = "live",
  transport = false,
  nav = false,
  children,
}: TopBarProps) {
  // The underline's travelling highlight means "a run is streaming right now" — not merely that a
  // stream is open (a finished or gated run holds its stream open too).
  const streaming = status === "running" && connection === "open";

  return (
    // §3.3/§7 M9g/M9h: a sticky glass bar — translucent + blurred rather than a flat fill, so content
    // that scrolls underneath it (PageFrame's page-level scroll on runs home/eval/report) reads
    // through softly instead of vanishing under a hard edge. Harmless where the bar already sits
    // outside any scrolling ancestor (the live run view's AppFrame grid): `sticky` is then a no-op.
    <div className="sticky top-0 z-30 bg-surface-glass backdrop-blur-xl backdrop-saturate-150">
      <div className="flex h-(--layout-topbar) items-center gap-2 px-4 frame:gap-4">
        <Link to="/runs" className="rounded-control">
          <Logo />
        </Link>

        {nav && <PrimaryNav />}

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
          <div className="hidden items-center gap-2 frame:flex">
            {status !== undefined && <RunStatusPill status={status} />}
            {connection !== undefined && <StreamHealthPill connection={connection} mode={mode} />}
          </div>
          {transport && <ReplayTransport />}
          {children}
          <ThemeToggle />
        </div>
      </div>
      <div
        aria-hidden="true"
        data-streaming={streaming ? "" : undefined}
        className={cn("hairline-brand relative h-px w-full overflow-hidden opacity-70", streaming && "meter-sheen")}
      />
      <DisconnectedBar connection={connection ?? "idle"} />
    </div>
  );
}
