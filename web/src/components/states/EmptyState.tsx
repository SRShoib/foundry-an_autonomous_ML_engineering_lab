import type { ReactNode } from "react";

/** docs/design-plan.md §9: an empty state tells the operator what to do next, not merely that
 * there is nothing here. "No runs yet. Pick a dataset above to start one." */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <p className="text-md font-medium text-fg">{title}</p>
      <p className="max-w-prose text-sm text-fg-secondary">{hint}</p>
      {action === undefined ? null : <div className="pt-2">{action}</div>}
    </div>
  );
}
