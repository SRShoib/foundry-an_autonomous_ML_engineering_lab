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
  it("accepts token references, the one shadow, tabular numerics and a 0.01em tracking", () => {
    const good = [
      "background: var(--surface-panel); color: var(--text-primary);",
      "box-shadow: var(--shadow-float);",
      "box-shadow: var(--shadow-raised);",
      "letter-spacing: 0.01em; font-weight: 600;",
      'className="bg-surface-panel text-fg font-medium shadow-float hover:shadow-hover focus-visible:ring-2"',
      "id=\"#root\"; const url = '#/components/schemas/RunStatus';",
    ].join("\n");
    expect(violations(good)).toEqual([]);
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
