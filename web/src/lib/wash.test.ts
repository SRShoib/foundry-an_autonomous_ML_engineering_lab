import { describe, expect, it } from "vitest";

import { ROW_WASH_TOKENS } from "../styles/tokenGroups";
import { readTokens } from "../test/readTokens";
import { WASH } from "./wash";

const { dark, light } = readTokens();

/** `wash [--wash-hue:var(--team-data)]` -> `team-data` */
const hueOf = (washClass: string): string | undefined => /--wash-hue:var\(--([\w-]+)\)/.exec(washClass)?.[1];

describe("WASH", () => {
  it("names a hue token that really exists in both themes — a typo would paint a transparent wash", () => {
    for (const [tone, washClass] of Object.entries(WASH)) {
      const hue = hueOf(washClass);
      expect(hue, `${tone} names no --wash-hue`).toBeDefined();
      expect(dark[hue ?? ""], `--${hue} is missing from dark`).toBeDefined();
      expect(light[hue ?? ""], `--${hue} is missing from light`).toBeDefined();
    }
  });

  it("covers exactly the tones tokens.contrast.test.ts holds to AA — a wash it does not check cannot exist", () => {
    const hues = Object.values(WASH).map(hueOf).sort();
    expect(hues).toEqual([...ROW_WASH_TOKENS].sort());
  });

  it("starts every class with the `wash` utility, so the strength token always applies", () => {
    for (const washClass of Object.values(WASH)) expect(washClass.startsWith("wash ")).toBe(true);
  });

  it("restates --wash-row in light, lower than dark: the same tint reads far heavier on paper", () => {
    const dk = Number.parseFloat(dark["wash-row"] ?? "");
    const lt = Number.parseFloat(light["wash-row"] ?? "");
    expect(Number.isFinite(dk) && Number.isFinite(lt)).toBe(true);
    expect(lt).toBeLessThan(dk);
  });
});
