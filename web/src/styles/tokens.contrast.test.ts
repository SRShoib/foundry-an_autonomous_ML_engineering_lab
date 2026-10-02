/** docs/design-plan.md §11: "M9b turns this check into a unit test over the real CSS variables so
 * the tokens cannot drift below AA unnoticed." The first draft of that plan asserted AA without
 * computing it, and computing it found seven failures — this is the computation, kept running.
 * M9h's Aurora palette was computed first too, and the computation caught a second batch (22% washes
 * that dropped muted text to 4.20:1; three light team colours too close to the floor under their own
 * wash) — the "washes", "team washes" and "chips" blocks below are what keep those fixed.
 */
import { describe, expect, it } from "vitest";

import { compositeOver, contrastRatio, hexLayer, insetShadowPeak, normalCdf, parseRgbLayers } from "./contrast";
import {
  BESPOKE_CONTRAST_TOKENS,
  CHIP_ALPHA,
  CHIP_TONE_TOKENS,
  DECORATIVE_TOKENS,
  GRAPHIC_FLOOR,
  GRAPHIC_TOKENS,
  INSET_SHADOW_WASHES,
  ROW_WASH_TOKENS,
  SURFACES,
  TEAM_WASH_SURFACES,
  TEXT_FLOOR,
  TEXT_TOKENS,
  WASH_LAYERS,
  WASH_TEXT_TOKENS,
} from "./tokenGroups";
import { isColour, readTokens } from "../test/readTokens";

const { dark, light } = readTokens();
const themes = { dark, light } as const;

const CHECKED = new Set<string>([...SURFACES, ...TEXT_TOKENS, ...GRAPHIC_TOKENS]);
const EXEMPT = new Set<string>([...DECORATIVE_TOKENS, ...BESPOKE_CONTRAST_TOKENS]);

function valueOf(theme: "dark" | "light", name: string): string {
  const found = themes[theme][name];
  if (found === undefined) throw new Error(`--${name} is not defined in the ${theme} theme`);
  return found;
}

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

  it("restates in light every gradient, shadow and wash that names literal rgb() stops", () => {
    // Gradients and shadows are not "colour tokens" by isColour (they start with a function or a
    // length), so the check above cannot see them — yet each of these names literal stops tuned to
    // the dark ground, and one left unrestated would paint a dark-tinted cast on paper by omission.
    // Gradients built only from other tokens (--gradient-brand, -meter-*) carry no literal stop and
    // follow the theme on their own, so they are correctly absent from this list.
    const missing = Object.entries(dark)
      .filter(([name, value]) => !isColour(value) && /rgba?\(/.test(value) && light[name] === undefined)
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
    "text-primary": 13.65,
    "text-secondary": 7.52,
    "text-muted": 5.43,
    "team-principal": 9.71,
    "team-data": 7.66,
    "team-modeling": 6.78,
    "team-runner": 8.79,
    "team-redteam": 5.76,
    "team-reporter": 6.69,
    "status-ok": 8.69,
    "status-warn": 8.94,
    "status-danger": 5.76,
    "status-info": 6.54,
    "status-idle": 3.67,
    "line-control": 3.65,
    "line-focus": 6.46,
    "brand-1": 4.19,
    "brand-2": 4.86,
    "brand-3": 8.5,
    accent: 3.37,
    "accent-to": 3.16,
    "accent-hover": 4.31,
  };

  it.each(Object.entries(quotedWorstCase))("holds --%s at its quoted %s:1 worst case", (token, quoted) => {
    const ratios = SURFACES.map((surface) => ({ surface, r: ratio("dark", token, surface) }));
    const worst = ratios.reduce((a, b) => (b.r < a.r ? b : a));
    expect(worst.r).toBeCloseTo(quoted, 1);
    // every quoted worst case sits on the raised surface, where the red-team alert lives
    expect(worst.surface).toBe("surface-raised");
  });

  it("holds the deck-surface figures §3.1 quotes in parentheses", () => {
    expect(ratio("dark", "text-primary", "surface-deck")).toBeCloseTo(16.41, 1);
    expect(ratio("dark", "text-secondary", "surface-deck")).toBeCloseTo(9.03, 1);
    expect(ratio("dark", "text-muted", "surface-deck")).toBeCloseTo(6.52, 1);
  });

  it("holds --team-redteam on --surface-raised, where the red-team alert sits, at about 5.76:1", () => {
    // §11's headline correction was that the first draft gave 4.2:1 here and failed AA; M9h's rose
    // clears it with real margin.
    expect(ratio("dark", "team-redteam", "surface-raised")).toBeCloseTo(5.76, 1);
  });

  it("finds --text-muted on --surface-raised the tightest dark text pair, at about 5.43:1", () => {
    let tightest = { pair: "", ratio: Infinity };
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        const r = ratio("dark", token, surface);
        if (r < tightest.ratio) tightest = { pair: `${token} on ${surface}`, ratio: r };
      }
    }
    expect(tightest.pair).toBe("text-muted on surface-raised");
    expect(tightest.ratio).toBeCloseTo(5.43, 1);
  });

  it("keeps --status-danger identical to --team-redteam: invalidation IS the danger state", () => {
    expect(dark["status-danger"]).toBe(dark["team-redteam"]);
    expect(light["status-danger"]).toBe(light["team-redteam"]);
  });

  it("keeps --meter-critical identical to --status-danger: the meter reuses the status hues", () => {
    expect(dark["meter-critical"]).toBe(dark["status-danger"]);
    expect(light["meter-critical"]).toBe(light["status-danger"]);
  });
});

describe("the primary button: white text on the deep gradient", () => {
  // --accent / --accent-to are GRAPHIC tokens, checked against the five grounds by the loop above
  // like every other graphic token. What that loop can't check: --accent-contrast is only ever read
  // as a label SITTING ON a filled --accent or --accent-to surface, never on one of the five
  // grounds, so it needs its own pairs rather than the standard surface loop. Both ends of the
  // gradient are checked because the label crosses the whole gradient.
  it.each(["dark", "light"] as const)("holds --accent-contrast at %s theme's 4.5:1 floor against both gradient stops", (theme) => {
    const tokens = themes[theme];
    for (const stop of ["accent", "accent-to"] as const) {
      expect(contrastRatio(tokens["accent-contrast"] ?? "", tokens[stop] ?? ""), `white on --${stop}`).toBeGreaterThanOrEqual(
        TEXT_FLOOR,
      );
    }
  });

  it("holds dark --accent at its computed 3.37:1 worst case on --surface-raised", () => {
    const ratios = SURFACES.map((surface) => contrastRatio(dark["accent"] ?? "", dark[surface] ?? ""));
    expect(Math.min(...ratios)).toBeCloseTo(3.37, 1);
  });
});

describe.each(["dark", "light"] as const)("%s: translucent washes never erode text below AA (§12.3)", (theme) => {
  it.each(Object.entries(WASH_LAYERS))("--%s keeps text-primary/secondary/muted at 4.5:1 at its peak", (name, grounds) => {
    const layers = parseRgbLayers(valueOf(theme, name));
    // A vacuous pass is the failure mode of a parser test: if the regex stopped matching, the loop
    // below would run zero times and "pass".
    expect(layers.length, `--${name} has no rgb() stops to check`).toBeGreaterThan(0);
    for (const layer of layers) {
      for (const ground of grounds) {
        const background = compositeOver(layer, valueOf(theme, ground));
        for (const text of WASH_TEXT_TOKENS) {
          expect(
            contrastRatio(valueOf(theme, text), background),
            `${text} on --${name} (alpha ${layer.alpha}) over ${ground}`,
          ).toBeGreaterThanOrEqual(TEXT_FLOOR);
        }
      }
    }
  });
});

describe("insetShadowPeak models what a browser really paints", () => {
  it("is Phi(spread / sigma) of the nominal alpha — the 140px / 8px / 0.22 vignette measured ~11% at the edge", () => {
    const peak = insetShadowPeak("inset 0 0 140px 8px rgb(255 111 134 / 0.22)");
    expect(peak?.rgb).toEqual([255, 111, 134]);
    expect(peak?.alpha).toBeCloseTo(0.22 * normalCdf(8 / 70), 5);
    expect(peak?.alpha).toBeGreaterThan(0.1);
    expect(peak?.alpha).toBeLessThan(0.13);
  });

  it("grows toward the nominal alpha as the spread grows, and never exceeds it", () => {
    const narrow = insetShadowPeak("inset 0 0 160px 0px rgb(0 0 0 / 0.5)");
    const wide = insetShadowPeak("inset 0 0 160px 200px rgb(0 0 0 / 0.5)");
    expect(narrow?.alpha).toBeCloseTo(0.25, 3); // half the shadow's coverage at its own edge
    expect(wide?.alpha).toBeLessThanOrEqual(0.5);
    expect(wide?.alpha).toBeGreaterThan(0.49);
  });

  it("returns null for a value that is not a plain full-viewport inset shadow", () => {
    expect(insetShadowPeak("0 12px 30px -10px rgb(0 0 0 / 0.8)")).toBeNull();
    expect(insetShadowPeak("")).toBeNull();
  });
});

describe.each(["dark", "light"] as const)("%s: the red-team vignette never erodes text below AA (§8)", (theme) => {
  it.each(Object.entries(INSET_SHADOW_WASHES))("--%s holds text-primary/secondary/muted at 4.5:1 at its real peak", (name, grounds) => {
    const peak = insetShadowPeak(valueOf(theme, name));
    expect(peak, `--${name} is not a full-viewport inset shadow the guard can model`).not.toBeNull();
    if (peak === null) return;
    for (const ground of grounds) {
      const background = compositeOver(peak, valueOf(theme, ground));
      for (const text of WASH_TEXT_TOKENS) {
        expect(
          contrastRatio(valueOf(theme, text), background),
          `${text} under --${name} (peak alpha ${peak.alpha.toFixed(3)}) over ${ground}`,
        ).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }
    }
  });
});

describe.each(["dark", "light"] as const)("%s: team washes (§3.1) and chips (§12.5)", (theme) => {
  // The REAL --wash-row for this theme (a percentage such as "8%"), so the strength checked is
  // exactly the strength that ships — dark and light restate it differently on purpose.
  const rowWashAlpha = Number.parseFloat(valueOf(theme, "wash-row")) / 100;

  it("reads a sane --wash-row (a guard against the parse quietly returning NaN and the loop below passing vacuously)", () => {
    expect(rowWashAlpha).toBeGreaterThan(0);
    expect(rowWashAlpha).toBeLessThanOrEqual(0.12);
  });

  it.each(ROW_WASH_TOKENS)("--%s: its label and the secondary/muted text hold 4.5:1 on its own row wash", (team) => {
    for (const ground of TEAM_WASH_SURFACES) {
      const background = compositeOver(hexLayer(valueOf(theme, team), rowWashAlpha), valueOf(theme, ground));
      for (const text of [team, "text-secondary", "text-muted"]) {
        expect(contrastRatio(valueOf(theme, text), background), `${text} over ${team} wash on ${ground}`).toBeGreaterThanOrEqual(
          TEXT_FLOOR,
        );
      }
    }
  });

  it.each(CHIP_TONE_TOKENS)("--%s: its icon holds 3:1 and a text-primary label 4.5:1 on its own 15% chip tint", (tone) => {
    for (const ground of SURFACES) {
      const background = compositeOver(hexLayer(valueOf(theme, tone), CHIP_ALPHA), valueOf(theme, ground));
      expect(contrastRatio(valueOf(theme, tone), background), `${tone} icon on ${ground}`).toBeGreaterThanOrEqual(GRAPHIC_FLOOR);
      expect(contrastRatio(valueOf(theme, "text-primary"), background), `label on ${tone} tint on ${ground}`).toBeGreaterThanOrEqual(
        TEXT_FLOOR,
      );
    }
  });
});
