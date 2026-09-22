import { describe, expect, it } from "vitest";

import { costRows } from "./costByAgent";

describe("costRows", () => {
  it("orders the four known roles and labels workers in the plural", () => {
    const rows = costRows({ principal: 0.07, red_team: 0.05, sandbox: 0.000371, worker: 0.2 });
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ["principal", "principal"],
      ["worker", "workers"],
      ["red_team", "red team"],
      ["sandbox", "sandbox"],
    ]);
    expect(rows.map((r) => r.usd)).toEqual([0.07, 0.2, 0.05, 0.000371]);
  });

  it("zero-fills a role that has not spent yet, so the row is present from the start", () => {
    const rows = costRows({});
    expect(rows.every((r) => r.usd === 0)).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it("appends an unrecognised role rather than dropping its cost", () => {
    const rows = costRows({ principal: 1, literature_scout: 0.3 });
    expect(rows.at(-1)).toEqual({ id: "literature_scout", label: "literature_scout", usd: 0.3 });
  });
});
