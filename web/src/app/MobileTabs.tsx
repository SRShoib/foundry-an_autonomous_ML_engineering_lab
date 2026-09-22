import { useRef, type KeyboardEvent } from "react";

import { cn } from "../lib/cn";

export interface Tab<T extends string> {
  id: T;
  label: string;
}

export const tabId = (id: string): string => `tab-${id}`;
export const panelId = (id: string): string => `tabpanel-${id}`;

interface MobileTabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}

/** The tab strip of the below-frame layout. Follows the ARIA tabs pattern: one tab in the tab
 * order (roving tabindex), Left/Right/Home/End move between them and select as they go. */
export function MobileTabs<T extends string>({ tabs, active, onChange, label }: MobileTabsProps<T>) {
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
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex border-b border-line-hairline bg-surface-deck frame:hidden"
    >
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
            className={cn(
              "min-h-11 flex-1 border-b-2 px-3 text-sm",
              selected
                ? "border-line-focus font-medium text-fg"
                : "border-transparent text-fg-secondary hover:text-fg",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
