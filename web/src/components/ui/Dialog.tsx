import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, type TargetAndTransition, type Transition } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/** Re-exported so callers get Radix's automatic aria-labelledby/aria-describedby wiring between
 * Dialog.Content and its heading/body, without reaching into @radix-ui/react-dialog themselves. */
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;

interface DialogProps {
  open: boolean;
  /** Called on every close attempt — Escape, outside click, or a caller's own close button.
   * `dismissible={false}` (the gate) makes those first two no-ops; the caller's own control is
   * still the one thing that can close it, by calling this directly rather than through Radix. */
  onOpenChange: (open: boolean) => void;
  dismissible?: boolean;
  /** design-plan.md §5's two float-layer shapes: `centered` for the gate dialogs (§6, §7 entry:
   * scale 0.97→1 plus fade), `sheet` for the 560px experiment drawer (§7: 280ms translateX). */
  variant: "centered" | "sheet";
  /** Radix calls this when focus would otherwise move automatically on open — e.g. to steer it
   * onto the dialog's own heading (design-plan.md §7's gate entry: "focus moves to the panel
   * heading") instead of the first focusable control. */
  onOpenAutoFocus?: (event: Event) => void;
  overlayTransition?: Transition;
  panelTransition?: {
    initial: TargetAndTransition;
    animate: TargetAndTransition;
    exit: TargetAndTransition;
    transition: Transition;
  };
  className?: string;
  children: ReactNode;
}

// §3.3 M9g: the float layer's own material — --surface-glass/-glass-border (translucency, alpha
// >=0.84) plus a native Tailwind backdrop-blur (never reset by theme.css's @theme block, which
// only zeroes --color-*/--text-*/--font-*/--radius-*/--shadow-*/--ease-*/--tracking-*) in place of
// the flat --surface-raised fill these two variants used before. --shadow-float itself is now the
// layered contact-plus-cast shadow token (tokens.css).
const VARIANT_CLASS: Record<DialogProps["variant"], string> = {
  centered:
    "fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-float border border-surface-glass-border bg-surface-glass shadow-float backdrop-blur-md",
  sheet:
    "fixed inset-y-0 right-0 z-50 flex w-[min(100vw,560px)] flex-col border-l border-surface-glass-border bg-surface-glass shadow-float backdrop-blur-md",
};

const DEFAULT_PANEL_TRANSITION: NonNullable<DialogProps["panelTransition"]> = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97 },
  transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1], delay: 0.12 },
};

/** The restyled Radix Dialog shell (SPEC: "Radix UI primitives for accessible dialogs/menus,
 * fully restyled") shared by GateDialog and ExperimentDrawer: portal, focus trap, `aria-modal`,
 * tokens only. `forceMount` + AnimatePresence is the standard way to get an EXIT animation out of
 * Radix, which otherwise unmounts its content the instant `open` goes false. */
export function Dialog({
  open,
  onOpenChange,
  dismissible = true,
  variant,
  onOpenAutoFocus,
  overlayTransition,
  panelTransition = DEFAULT_PANEL_TRANSITION,
  className,
  children,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-surface-abyss"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.6 }}
                exit={{ opacity: 0 }}
                transition={overlayTransition ?? { duration: 0.2 }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content
              asChild
              forceMount
              {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
              onEscapeKeyDown={(event) => {
                if (!dismissible) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (!dismissible) event.preventDefault();
              }}
              onInteractOutside={(event) => {
                if (!dismissible) event.preventDefault();
              }}
            >
              <motion.div
                className={cn(VARIANT_CLASS[variant], className)}
                initial={panelTransition.initial}
                animate={panelTransition.animate}
                exit={panelTransition.exit}
                transition={panelTransition.transition}
              >
                {children}
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
