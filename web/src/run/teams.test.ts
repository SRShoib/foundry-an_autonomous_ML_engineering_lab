import { describe, expect, it } from "vitest";

import { TEAM_META, TEAM_ORDER, teamForEvent, teamForNode } from "./teams";
import { makeEvent } from "../test/fixtures";

describe("teamForNode", () => {
  it.each([
    ["principal", "principal"],
    ["data_team", "data_team"],
    ["modeling_team", "modeling_team"],
    ["experiment_runner", "experiment_runner"],
    ["red_team", "red_team"],
    ["reporter", "reporter"],
  ] as const)("maps the %s node to the %s team", (node, team) => {
    expect(teamForNode(node)).toBe(team);
  });

  it("has no team for null (interrupt/done/error events carry no node)", () => {
    expect(teamForNode(null)).toBeNull();
  });

  it("has no team for nodes with no hue of their own", () => {
    expect(teamForNode("final_gate")).toBeNull();
    expect(teamForNode("lesson_writer")).toBeNull();
  });

  it("has no team for an unrecognised node, rather than throwing", () => {
    expect(teamForNode("something_new")).toBeNull();
  });

  it("reads the node off an event", () => {
    expect(teamForEvent(makeEvent(0, { node: "red_team" }))).toBe("red_team");
  });
});

describe("TEAM_META", () => {
  it("gives every team in TEAM_ORDER a label, glyph and rail colour", () => {
    for (const team of TEAM_ORDER) {
      const meta = TEAM_META[team];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.glyph.length).toBeGreaterThan(0);
      expect(meta.railBg).toMatch(/^bg-team-/);
      expect(meta.text).toMatch(/^text-team-/);
    }
  });

  it("gives only red_team the heavier rail (design-plan §5's ▐ vs ▌)", () => {
    for (const team of TEAM_ORDER) {
      expect(TEAM_META[team].railWidth).toBe(team === "red_team" ? "thick" : "thin");
    }
  });
});
