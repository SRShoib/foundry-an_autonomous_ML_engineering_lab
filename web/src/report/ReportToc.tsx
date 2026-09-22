import type { Heading } from "./headings";

/** docs/design-plan.md §6: "a single centred column ... sticky mini-TOC on the left at 1100px and
 * up" — `frame:` is exactly that breakpoint (styles/theme.css's --breakpoint-frame, the same one
 * the live run view's own three-column frame collapses at). Hidden entirely below it rather than
 * reflowed: a short list of anchors earns no mobile tab of its own. */
export function ReportToc({ headings }: { headings: readonly Heading[] }) {
  if (headings.length === 0) return null;
  return (
    <nav aria-label="Report sections" className="hidden w-40 shrink-0 frame:block">
      <ol className="sticky top-(--space-6) flex flex-col gap-1.5 border-l border-line-hairline pl-3">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              className="text-xs text-fg-secondary transition-colors duration-(--dur-quick) ease-out hover:text-fg"
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
