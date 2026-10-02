import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { RULES, violations } from "./designRules";

const SRC = join(import.meta.dirname, "..");

/** Source that legitimately holds what the rules forbid: tokens.css defines every colour; tests, the
 * test-support helpers in test/ and the rules themselves quote the forbidden patterns; schema.d.ts
 * is generated. */
function isExempt(path: string): boolean {
  const rel = relative(SRC, path).split(sep).join("/");
  return (
    rel === "styles/tokens.css" ||
    rel === "styles/designRules.ts" ||
    rel === "api/schema.d.ts" ||
    rel.startsWith("test/") ||
    /\.test\.tsx?$/.test(rel)
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !isExempt(path));
}

describe("each design rule actually fires on a bad sample", () => {
  const bad: Readonly<Record<string, string>> = {
    "no-raw-colour": 'const c = "#1a2b3c"; .x { color: rgb(1 2 3); background: hsl(0 0% 0%) }',
    "focus-never-suppressed": ".x:focus { outline: none } <a className='focus:outline-none' />",
    "no-tracked-out-caps": '<h2 className="uppercase tracking-widest"> .x { letter-spacing: 0.2em }',
    "shadows-are-tokenized": '<div className="shadow-lg"> .x { box-shadow: 0 1px 3px black }',
    "weights-stop-at-600": '<b className="font-bold"> .x { font-weight: 700 }',
    "no-hover-motion": '<div className="hover:-translate-y-1 hover:scale-105 group-hover:translate-x-2 animate-bounce">',
  };

  it("has a bad sample for every rule", () => {
    expect(Object.keys(bad).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  it.each(RULES)("$id", (rule) => {
    expect(rule.check(bad[rule.id] ?? "").length).toBeGreaterThan(0);
  });
});

describe("comments are documentation, not violations", () => {
  it("ignores a forbidden pattern quoted in a comment but not one in code", () => {
    expect(violations("/* never write outline: none */\n// also not shadow-lg here")).toEqual([]);
    expect(violations("a { outline: none } /* fine */").length).toBeGreaterThan(0);
  });

  it("does not mistake a URL for a line comment", () => {
    expect(violations('fetch("http://localhost:8000"); color: #ff00aa;').length).toBe(1);
  });
});

describe("each design rule leaves the allowed forms alone", () => {
  it("accepts token references, the shadow ladder, tabular numerics and a 0.01em tracking", () => {
    const good = [
      "background: var(--surface-panel); color: var(--text-primary);",
      "box-shadow: var(--shadow-float);",
      "box-shadow: var(--shadow-raised);",
      "box-shadow: var(--shadow-glow-brand);",
      "letter-spacing: 0.01em; font-weight: 600;",
      "letter-spacing: -0.02em;",
      'className="bg-surface-panel text-fg font-medium shadow-float hover:shadow-hover focus-visible:ring-2"',
      'className="bg-status-ok/15 text-fg shadow-glow-ok active:scale-[0.98] tracking-tight"',
      "id=\"#root\"; const url = '#/components/schemas/RunStatus';",
    ].join("\n");
    expect(violations(good)).toEqual([]);
  });

  it("allows press feedback (`active:scale-*`) while refusing the same motion on hover", () => {
    expect(violations('className="active:scale-[0.98]"')).toEqual([]);
    expect(violations('className="hover:scale-[1.02]"').length).toBeGreaterThan(0);
  });
});

/** An asterisk directly followed by a slash INSIDE comment prose (a wildcard token name written
 * next to a slash, "dur-star-slash-ease-star") ends the comment early. Everything after it is then
 * parsed as CSS, and Tailwind leaves every later `@utility`/`@theme` block unprocessed, so the
 * production build ships a stylesheet that is silently missing those utilities (it happened in M9h:
 * 22 warnings, a 52 kB stylesheet instead of 61 kB, nothing failing). Vitest runs with `css: false`,
 * so no component test can see it — this reads the files directly. After the real comments are
 * stripped, no comment-body line (an asterisk, then words) and no stray comment terminator may remain. */
export function commentLeaks(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [
    ...[...code.matchAll(/\*\//g)].map(() => "a stray `*/` outside any comment"),
    ...[...code.matchAll(/^[ \t]*\*[ \t]+[\w-][^\n]*/gm)].map((m) => `a comment-body line outside any comment: ${m[0].trim()}`),
  ];
}

describe("CSS comments are well-formed", () => {
  it("catches an early-terminated comment (the bad sample proves the guard can fail)", () => {
    // Built from parts so this file's own comment never contains the terminator it is testing for.
    const terminator = "*" + "/";
    const bad = `/* built from the --dur-${terminator}--ease-* tokens, and more prose */\n.x { color: var(--text-primary); }`;
    expect(commentLeaks(bad).length).toBeGreaterThan(0);
  });

  it("leaves universal selectors and well-formed comments alone", () => {
    const good = "/* a fine comment, even one mentioning var(--shadow-*) */\n*,\n*::before { margin: 0 }\n* { box-sizing: border-box }";
    expect(commentLeaks(good)).toEqual([]);
  });

  it("finds no leaked comment text in any stylesheet under web/src", () => {
    const stylesheets = readdirSync(SRC, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(stylesheets.length, "expected to find the project's stylesheets").toBeGreaterThan(0);
    const found = stylesheets.flatMap((path) =>
      commentLeaks(readFileSync(path, "utf8")).map((leak) => `${relative(SRC, path)}: ${leak}`),
    );
    expect(found).toEqual([]);
  });
});

describe("web/src follows docs/design-plan.md", () => {
  const files = sourceFiles(SRC);

  it("scans the source tree (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no design-rule violations", () => {
    const found = files.flatMap((path) =>
      violations(readFileSync(path, "utf8")).map(
        (v) => `${relative(SRC, path)}: [${v.rule.id}] ${v.message}: ${v.rule.why}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
