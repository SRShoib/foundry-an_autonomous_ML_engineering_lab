import type { ReactNode } from "react";
import { motion } from "motion/react";

import { AmbientBackground } from "../components/ui/AmbientBackground";
import { TopBar } from "./TopBar";

/** The frame for screens that are not a live run — runs home, report, eval, not-found: the same
 * top bar, and a single centred column. Deliberately not a card grid (docs/design-plan.md §6).
 *
 * M9h: the page sits on the same ambient ground as the live view (the root is `isolate`, see
 * AppFrame), and the centred column is no longer a flat `--surface-deck` slab. That slab, a lighter
 * band down the middle of a darker page, read as a rendering bug in the screenshots; panels now sit
 * directly on the ground. */
export function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="isolate flex min-h-dvh flex-col bg-surface-abyss text-fg">
      <AmbientBackground />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded-control focus:border focus:border-line-control focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>
      <header>
        <TopBar nav />
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 frame:px-6">
        {/* §7 M9g: a route enter transition — <MotionConfig reducedMotion="user"> (App.tsx) already
            covers reduced-motion for every motion.* component, this one included. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          <h1 className="mb-4 text-xl font-semibold tracking-tight text-fg">{title}</h1>
          <div className="flex flex-col gap-4">{children}</div>
        </motion.div>
      </main>
    </div>
  );
}
