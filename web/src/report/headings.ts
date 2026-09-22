import type { ReactNode } from "react";

export interface Heading {
  id: string;
  text: string;
}

/** "Leaderboard" -> "leaderboard", "Cost by agent" -> "cost-by-agent". Used by BOTH
 * extractHeadings (on the raw markdown, for ReportToc.tsx) and Markdown.tsx's h2 renderer (on the
 * rendered heading's own text) — the same function on the same underlying text always produces
 * the same id, so a TOC link is never left dangling. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Flattens a react-markdown component's `children` (a string, a number, nested elements, or an
 * array of any of those) down to its visible text, ignoring markup — "**Sign-off**" renders as the
 * text "Sign-off". */
export function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "object" && "props" in node) {
    const children = (node as { props?: { children?: ReactNode } }).props?.children;
    return textContent(children);
  }
  return "";
}

/** Every level-2 heading in `markdown`, in reading order — report/ReportToc.tsx's mini table of
 * contents. Only `##` is extracted: foundry/teams/reporter.py's render_report and
 * render_model_card use a single `#` title once, then flat `##` sections, never a deeper level. */
export function extractHeadings(markdown: string): Heading[] {
  return [...markdown.matchAll(/^##[ \t]+(.+)$/gm)].map((match) => {
    const text = match[1]?.trim() ?? "";
    return { id: slugify(text), text };
  });
}
