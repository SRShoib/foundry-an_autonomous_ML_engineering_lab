import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { slugify, textContent } from "./headings";

/** `id` built from the heading's OWN rendered text via the same slugify() extractHeadings.ts uses
 * on the raw markdown — so a ReportToc.tsx link built from the raw text always resolves to the
 * anchor a real render produced, even though the two never see the same representation of it.
 * `node` (react-markdown's ExtraProps) is destructured out, never spread — a DOM <h2> would warn
 * about an unrecognised prop otherwise. */
function AnchoredH2({ children, node: _node, ...props }: ComponentPropsWithoutRef<"h2"> & ExtraProps) {
  return (
    <h2 id={slugify(textContent(children))} {...props}>
      {children}
    </h2>
  );
}

const components: Components = { h2: AnchoredH2 };

/** Renders `report_md` / `model_card_md` (docs/design-plan.md §6's report view and model card) —
 * both code-assembled markdown (foundry/teams/reporter.py) with GFM pipe tables for the leaderboard
 * and cost-by-agent sections, plus LLM-authored prose (ReportNarrative.summary/recommendation)
 * folded in as plain paragraphs. No `rehypePlugins`/`rehype-raw`: that LLM text is untrusted, so
 * raw HTML in it is left unrendered rather than trusted, react-markdown's default. Styling comes
 * from the `doc` utility (styles/base.css) via descendant selectors, not a components map per tag —
 * this markdown's structure (headings, tables, paragraphs) is entirely code-controlled. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="doc">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
