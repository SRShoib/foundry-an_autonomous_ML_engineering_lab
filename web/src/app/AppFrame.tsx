import type { ReactNode, Ref } from "react";

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
  /** The centre column's own scroll container — the ONE scrolling channel (§5). The activity feed
   * reads its scroll position off this to drive follow-mode, rather than the feed nesting a second
   * scroller of its own inside it. */
  mainRef?: Ref<HTMLElement>;
  /** §7's gate entry: "the deck desaturates to 40% over 400ms" while a gate dialog (portalled
   * above everything here, so never itself dimmed) has focus. Applied to rail/main/dock only —
   * never the top bar, which stays legible as the one fixed point of reference. */
  deenergized?: boolean;
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
  mainRef,
  deenergized = false,
  children,
}: AppFrameProps) {
  const deenergizedClass = "transition-[filter,opacity] duration-(--dur-base) ease-out saturate-[.4] opacity-70";
  return (
    <div className="flex h-dvh flex-col bg-surface-abyss text-fg frame:grid frame:grid-cols-[var(--layout-rail)_minmax(var(--layout-center-min),1fr)_var(--layout-dock)] frame:grid-rows-[auto_minmax(0,1fr)]">
      <header className="frame:col-span-3">{topBar}</header>

      <div className={cn("frame:hidden", deenergized && deenergizedClass)}>
        {instrument}
        {tabs}
      </div>

      <aside
        aria-label="Run summary"
        className={cn(
          "hidden overflow-y-auto border-r border-line-hairline p-4 frame:block",
          deenergized && deenergizedClass,
        )}
      >
        {rail}
      </aside>

      <main
        id="main"
        ref={mainRef}
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface-deck frame:block",
          mobileView !== "main" && "hidden",
          deenergized && deenergizedClass,
        )}
      >
        {children}
      </main>

      <aside
        aria-label="Budget, leaderboard and audit"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto border-line-hairline p-4 frame:block frame:border-l",
          mobileView !== "dock" && "hidden",
          deenergized && deenergizedClass,
        )}
      >
        {dock}
      </aside>
    </div>
  );
}
