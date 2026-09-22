import type { ReactNode } from "react";

import { cn } from "../lib/cn";

interface AppFrameProps {
  topBar: ReactNode;
  /** Mobile only: the sticky 44px instrument bar. */
  instrument?: ReactNode;
  /** Mobile only: the tab strip. */
  tabs?: ReactNode;
  rail?: ReactNode;
  dock?: ReactNode;
  /** Which region a below-frame viewport shows. Above the breakpoint both are always docked. */
  mobileView?: "main" | "dock";
  children: ReactNode;
}

/**
 * docs/design-plan.md §5: a fixed instrument frame and ONE scrolling channel. Everything that is a
 * state — phase, budget, leaderboard, team roster — is docked at a stable screen position (the
 * left rail and the right dock) and never moves; only the centre column scrolls. That single rule
 * is what separates this from a SaaS dashboard, where everything scrolls together and nothing has
 * a home.
 *
 * At `frame:` (1100px and up) it is a 216 / fluid / 340 grid under a 56px bar. Below it the rail
 * disappears, and the instrument bar plus tabs take over — the regions are still rendered ONCE
 * and merely shown or hidden, so no landmark or id is ever duplicated.
 */
export function AppFrame({
  topBar,
  instrument,
  tabs,
  rail,
  dock,
  mobileView = "main",
  children,
}: AppFrameProps) {
  return (
    <div className="flex h-dvh flex-col bg-surface-abyss text-fg frame:grid frame:grid-cols-[var(--layout-rail)_minmax(var(--layout-center-min),1fr)_var(--layout-dock)] frame:grid-rows-[auto_minmax(0,1fr)]">
      <header className="frame:col-span-3">{topBar}</header>

      <div className="frame:hidden">
        {instrument}
        {tabs}
      </div>

      <aside
        aria-label="Run summary"
        className="hidden overflow-y-auto border-r border-line-hairline p-4 frame:block"
      >
        {rail}
      </aside>

      <main
        id="main"
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface-deck frame:block",
          mobileView !== "main" && "hidden",
        )}
      >
        {children}
      </main>

      <aside
        aria-label="Budget, leaderboard and audit"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto border-line-hairline p-4 frame:block frame:border-l",
          mobileView !== "dock" && "hidden",
        )}
      >
        {dock}
      </aside>
    </div>
  );
}
