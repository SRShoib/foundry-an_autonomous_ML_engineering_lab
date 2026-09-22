import { useRef, type KeyboardEvent } from "react";

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
}

/** The ARIA tabs primitive (SPEC: "Radix UI primitives for accessible dialogs/menus" — extended
 * here to the one other place the console needs real tab semantics). Follows the ARIA tabs
 * pattern: one tab in the tab order (roving tabindex), Left/Right/Home/End move between them and
 * select as they go. Originally app/MobileTabs.tsx's own logic; extracted so the experiment
 * drawer's `spec`/`code`/`output`/`attempts` tabs (M9d) get the same keyboard behaviour without a
 * second implementation to keep in sync. */
export function Tabs<T extends string>({ tabs, active, onChange, label, className, tabClassName }: TabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

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
            className={tabClassName(selected)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
