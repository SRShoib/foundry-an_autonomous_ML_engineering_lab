/** Mechanical guards for the design plan's invariants (docs/design-plan.md). CLAUDE.md says "no raw
 * hex values in components" and "follow docs/design-plan.md exactly"; a rule that is only written
 * down erodes over four more milestones, so each one that can be checked by a regex is. The rules
 * are data, and design-invariants.test.ts proves each fires on a bad sample before it trusts a
 * clean result on the real source — a guard that cannot fail is worse than none.
 */

export interface Rule {
  readonly id: string;
  readonly why: string;
  /** Returns one message per violation found in `source`. */
  readonly check: (source: string) => string[];
}

function matches(source: string, pattern: RegExp, label: (m: string) => string): string[] {
  return [...source.matchAll(pattern)].map((m) => label(m[0]));
}

export const RULES: readonly Rule[] = [
  {
    id: "no-raw-colour",
    why: "colours come from tokens only (CLAUDE.md, §3); a literal cannot follow the theme",
    check: (source) => [
      ...matches(
        source,
        /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,
        (m) => `raw hex ${m}`,
      ),
      ...matches(source, /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/g, (m) => `raw ${m})`),
    ],
  },
  {
    id: "focus-never-suppressed",
    why: "§10: a 2px --line-focus ring at a 2px offset, never suppressed",
    check: (source) =>
      matches(
        source,
        /outline\s*:\s*(?:none|0)\b|\boutline-(?:none|0)\b/g,
        (m) => `focus outline removed: ${m}`,
      ),
  },
  {
    id: "no-tracked-out-caps",
    why: "§4 and the SPEC avoid-list: no ALL-CAPS tracked-out eyebrow labels",
    check: (source) => [
      ...matches(source, /\btracking-(?:wide|wider|widest)\b/g, (m) => `wide tracking ${m}`),
      ...matches(source, /\buppercase\b/g, () => "uppercase text"),
      ...[...source.matchAll(/letter-spacing\s*:\s*([\d.]+)em/g)]
        .filter((m) => Number(m[1]) > 0.01)
        .map((m) => `letter-spacing ${m[1]}em exceeds the 0.01em ceiling`),
    ],
  },
  {
    id: "one-shadow",
    why: "§3.3: no box-shadow in the docked layer; the system defines exactly one, --shadow-float",
    check: (source) => [
      ...matches(
        source,
        /\bshadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner)\b/g,
        (m) => `default Tailwind shadow ${m}`,
      ),
      ...[...source.matchAll(/box-shadow\s*:\s*([^;}]+)/g)]
        .filter((m) => !/^\s*(?:var\(--shadow-float\)|none)\s*$/.test(m[1] ?? ""))
        .map((m) => `box-shadow:${m[1]}`),
    ],
  },
  {
    id: "weights-stop-at-600",
    why: "§4: weights are 400, 500, 600; there is no 700 anywhere",
    check: (source) => [
      ...matches(source, /\bfont-(?:bold|extrabold|black)\b/g, (m) => `heavy weight ${m}`),
      ...matches(source, /font-weight\s*:\s*(?:700|800|900|bold|bolder)\b/g, (m) => m),
    ],
  },
];

/** A comment that says "never use outline: none" is documentation, not a violation. `//` is only a
 * comment marker at a line start or after whitespace, so `http://...` in a string survives. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function violations(source: string): { rule: Rule; message: string }[] {
  const code = stripComments(source);
  return RULES.flatMap((rule) => rule.check(code).map((message) => ({ rule, message })));
}
