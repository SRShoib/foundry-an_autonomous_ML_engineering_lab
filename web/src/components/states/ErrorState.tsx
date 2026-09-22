import type { ReactNode } from "react";

import { ApiError, isApiUnreachable } from "../../api/client";

/** docs/design-plan.md §9: an error names what failed and how to fix it, and shows the API's own
 * message VERBATIM (`RunStatus.error`, FastAPI's `detail`) rather than a generic "something went
 * wrong". `fix` is the console's own advice for when the message alone is not enough. */
export function ErrorState({
  title,
  detail,
  fix,
  action,
}: {
  title: string;
  detail: string;
  fix?: string;
  action?: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 border-l-2 border-status-danger py-2 pl-4">
      <p className="text-md font-medium text-fg">{title}</p>
      <p className="num max-w-prose whitespace-pre-wrap break-words text-sm text-fg-secondary">
        {detail}
      </p>
      {fix === undefined ? null : <p className="max-w-prose text-sm text-fg-secondary">{fix}</p>}
      {action === undefined ? null : <div className="pt-2">{action}</div>}
    </div>
  );
}

const UNREACHABLE_FIX =
  "The API did not answer. Start it with `make api`; recorded runs still replay without it.";

/** Turns whatever a query threw into an ErrorState. The message is always shown as-is. Advice is
 * added ONLY when the API genuinely could not be reached (see isApiUnreachable): an error that
 * carries its own fix — a missing recording, an API refusal — must not have "start the API"
 * bolted on, which would be wrong. */
export function QueryErrorState({
  error,
  title,
  action,
}: {
  error: unknown;
  title: string;
  action?: ReactNode;
}) {
  const detail =
    error instanceof ApiError
      ? error.detail
      : error instanceof Error
        ? error.message
        : "The request did not complete.";
  return (
    <ErrorState
      title={title}
      detail={detail}
      {...(isApiUnreachable(error) ? { fix: UNREACHABLE_FIX } : {})}
      action={action}
    />
  );
}
