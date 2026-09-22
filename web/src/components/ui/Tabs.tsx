import { useId, useRef, type KeyboardEvent } from "react";
import { motion } from "motion/react";

export interface Tab<T extends string> {
  id: T;
  label: string;
}

export const tabId = (id: string): string => `tab-${id}`;
export const panelId = (id: string): string => `tabpanel-${id}`;

interface TabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  /** The tablist container's own classes — each consumer positions and styles its strip
   * differently (the mobile bottom nav vs. the experiment drawer's tab row). */
  className?: string;
  /** Per-tab classes, given whether that tab is the selected one. */
  tabClassName: (selected: boolean) => string;
  /** §7 M9g interaction motion: "the selected-tab underline is a layoutId-shared element that
   * slides between tabs" — the same shared-layout technique GateDialog/BudgetMeter's hero-value
   * fly already uses, not new machinery. Off by default since not every Tabs consumer wants it.
   * `useId` scopes the shared id to THIS Tabs instance, so two mounted at once (mobile tabs behind
   * an open drawer) never fight over one indicator. */
  indicator?: boolean;
}

/** The ARIA tabs primitive (SPEC: "Radix UI primitives for accessible dialogs/menus" — extended
 * here to the one other place the console needs real tab semantics). Follows the ARIA tabs
 * pattern: one tab in the tab order (roving tabindex), Left/Right/Home/End move between them and
 * select as they go. Originally app/MobileTabs.tsx's own logic; extracted so the experiment
 * drawer's `spec`/`code`/`output`/`attempts` tabs (M9d) get the same keyboard behaviour without a
 * second implementation to keep in sync. */
export function Tabs<T extends string>({ tabs, active, onChange, label, className, tabClassName, indicator = false }: TabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const indicatorId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;

    event.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={selected}
            aria-controls={panelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative ${tabClassName(selected)}`}
          >
            {tab.label}
            {indicator && selected && (
              <motion.span
                aria-hidden="true"
                layoutId={indicatorId}
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
                transition={{ duration: 0.24, ease: [0.65, 0, 0.35, 1] }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
