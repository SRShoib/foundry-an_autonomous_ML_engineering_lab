import { Tabs, tabId, panelId, type Tab } from "../components/ui/Tabs";
import { cn } from "../lib/cn";

export { tabId, panelId, type Tab };

interface MobileTabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}

/** The tab strip of the below-frame layout, built on the shared components/ui/Tabs.tsx
 * primitive — this file now supplies only ITS OWN styling (a full-width bottom strip with an
 * underline indicator), not the ARIA/keyboard behaviour. */
export function MobileTabs<T extends string>({ tabs, active, onChange, label }: MobileTabsProps<T>) {
  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={onChange}
      label={label}
      className="flex border-b border-line-hairline bg-surface-deck frame:hidden"
      tabClassName={(selected) =>
        cn(
          "min-h-11 flex-1 border-b-2 px-3 text-sm",
          selected
            ? "border-line-focus font-medium text-fg"
            : "border-transparent text-fg-secondary hover:text-fg",
        )
      }
    />
  );
}
