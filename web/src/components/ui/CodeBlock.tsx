import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1600;

/** The experiment drawer's code / stdout / stderr well (docs/design-plan.md §12.5): monospace on
 * `--surface-inset`, wrapped, with a copy button. The button is a real `<button>` with an accessible
 * name, and the "Copied" confirmation is also spoken, through a polite live region, because the
 * visible label change alone is invisible to a screen reader.
 *
 * `navigator.clipboard` is absent on an insecure origin and rejects when permission is denied; in
 * both cases the button simply does nothing rather than throwing into the drawer. */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(children);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="overflow-hidden rounded-panel border border-line-hairline bg-surface-inset">
      <div className="flex items-center justify-between gap-2 border-b border-line-hairline px-3 py-1.5">
        <span className="text-2xs text-fg-muted">{label ?? ""}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-2xs text-fg-secondary transition-colors duration-(--dur-quick) ease-out hover:bg-surface-raised hover:text-fg"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3 text-status-ok" strokeWidth={2.5} />
          ) : (
            <Copy aria-hidden="true" className="size-3" strokeWidth={2.25} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="num overflow-x-auto whitespace-pre-wrap break-words p-3 text-xs text-fg">
        {children || "(empty)"}
      </pre>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
