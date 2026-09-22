/** docs/design-plan.md §11: "M9b turns this check into a unit test over the real CSS variables so
 * the tokens cannot drift below AA unnoticed." The first draft of that plan asserted AA without
 * computing it, and computing it found seven failures — this is the computation, kept running.
 */
import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";
import {
  BESPOKE_CONTRAST_TOKENS,
  DECORATIVE_TOKENS,
  GRAPHIC_FLOOR,
  GRAPHIC_TOKENS,
  SURFACES,
  TEXT_FLOOR,
  TEXT_TOKENS,
} from "./tokenGroups";
import { isColour, readTokens } from "../test/readTokens";

const { dark, light } = readTokens();
const themes = { dark, light } as const;

const CHECKED = new Set<string>([...SURFACES, ...TEXT_TOKENS, ...GRAPHIC_TOKENS]);
const EXEMPT = new Set<string>([...DECORATIVE_TOKENS, ...BESPOKE_CONTRAST_TOKENS]);

describe("token classification", () => {
  it("places every colour token in exactly one contrast group", () => {
    const colours = Object.entries(dark)
      .filter(([, value]) => isColour(value))
      .map(([name]) => name);
    const unclassified = colours.filter((name) => !CHECKED.has(name) && !EXEMPT.has(name));
    expect(unclassified, "register these in styles/tokenGroups.ts").toEqual([]);
  });

  it("defines every colour token in the light theme itself, never by inheriting dark", () => {
    const missing = Object.entries(dark)
      .filter(([name, value]) => isColour(value) && light[name] === undefined)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});

describe.each(["dark", "light"] as const)("%s theme meets WCAG AA", (theme) => {
  const tokens = themes[theme];
  const value = (name: string): string => {
    const found = tokens[name];
    if (found === undefined) throw new Error(`--${name} is not defined in the ${theme} theme`);
    return found;
  };

  describe.each(SURFACES)("on --%s", (surface) => {
    it.each(TEXT_TOKENS)(`--%s is at least ${TEXT_FLOOR}:1 as text`, (token) => {
      expect(contrastRatio(value(token), value(surface))).toBeGreaterThanOrEqual(TEXT_FLOOR);
    });

    it.each(GRAPHIC_TOKENS)(`--%s is at least ${GRAPHIC_FLOOR}:1 as a graphic`, (token) => {
      expect(contrastRatio(value(token), value(surface))).toBeGreaterThanOrEqual(GRAPHIC_FLOOR);
    });
  });
});

describe("the figures design-plan §3 quotes", () => {
  const ratio = (theme: "dark" | "light", fg: string, bg: string): number => {
    const tokens = themes[theme];
    const f = tokens[fg];
    const b = tokens[bg];
    if (f === undefined || b === undefined) throw new Error(`missing token ${fg} or ${bg}`);
    return contrastRatio(f, b);
  };

  // §3.1's "Min contrast" / worst-case column. Asserting each figure, not only the AA floor, means
  // a palette edit that stays above 4.5:1 but quietly erodes the margin still fails a test.
  const quotedWorstCase: Readonly<Record<string, number>> = {
    "text-primary": 12.1,
    "text-secondary": 6.5,
    "text-muted": 4.7,
    "team-principal": 6.9,
    "team-data": 5.4,
    "team-modeling": 5.5,
    "team-runner": 5.9,
    "team-redteam": 4.7,
    "team-reporter": 5.1,
    "status-ok": 5.5,
    "status-warn": 6.4,
    "status-danger": 4.7,
    "status-info": 4.8,
    "status-idle": 3.2,
    "line-control": 3.2,
    "line-focus": 4.8,
  };

  it.each(Object.entries(quotedWorstCase))("holds --%s at its quoted %s:1 worst case", (token, quoted) => {
    const ratios = SURFACES.map((surface) => ({ surface, r: ratio("dark", token, surface) }));
    const worst = ratios.reduce((a, b) => (b.r < a.r ? b : a));
    expect(worst.r).toBeCloseTo(quoted, 1);
    // every quoted worst case sits on the raised surface, where the red-team alert lives
    expect(worst.surface).toBe("surface-raised");
  });

  it("holds the deck-surface figures §3.1 quotes in parentheses", () => {
    expect(ratio("dark", "text-primary", "surface-deck")).toBeCloseTo(14.8, 1);
    expect(ratio("dark", "text-secondary", "surface-deck")).toBeCloseTo(7.9, 1);
    expect(ratio("dark", "text-muted", "surface-deck")).toBeCloseTo(5.8, 1);
  });

  it("holds --team-redteam on --surface-raised, where the red-team alert sits, at about 4.74:1", () => {
    // §11's headline correction: the draft #E0645F gave 4.2:1 here and failed AA.
    expect(ratio("dark", "team-redteam", "surface-raised")).toBeCloseTo(4.74, 2);
  });

  it("finds --text-muted on --surface-raised the tightest dark text pair, at about 4.71:1", () => {
    // §11 words this as team-redteam at 4.74:1. --text-muted is a hair tighter. Nothing fails;
    // the plan's sentence is what was imprecise, so the test records the measured truth.
    let tightest = { pair: "", ratio: Infinity };
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        const r = ratio("dark", token, surface);
        if (r < tightest.ratio) tightest = { pair: `${token} on ${surface}`, ratio: r };
      }
    }
    expect(tightest.pair).toBe("text-muted on surface-raised");
    expect(tightest.ratio).toBeCloseTo(4.71, 2);
  });

  it("keeps --status-danger identical to --team-redteam: invalidation IS the danger state", () => {
    expect(dark["status-danger"]).toBe(dark["team-redteam"]);
    expect(light["status-danger"]).toBe(light["team-redteam"]);
  });
});

describe("M9g's accent", () => {
  // --accent is a GRAPHIC_TOKEN, checked against the five grounds by the describe.each loop above
  // like every other graphic token. What that loop can't check: --accent-contrast is only ever
  // read as a label SITTING ON a filled --accent surface, never on one of the five grounds
  // directly, so it needs its own pair rather than the standard surface loop.
  it.each(["dark", "light"] as const)("holds --accent-contrast at >= %s theme's 4.5:1 text floor against --accent", (theme) => {
    const tokens = themes[theme];
    expect(contrastRatio(tokens["accent-contrast"] ?? "", tokens["accent"] ?? "")).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  it("holds dark --accent at its computed 3.17:1 worst case on --surface-raised", () => {
    const ratios = SURFACES.map((surface) => contrastRatio(dark["accent"] ?? "", dark[surface] ?? ""));
    expect(Math.min(...ratios)).toBeCloseTo(3.17, 1);
  });
});
