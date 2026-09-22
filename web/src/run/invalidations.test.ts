import { describe, expect, it } from "vitest";

import { makeFinding } from "../test/fixtures";
import { invalidatedFindings, newlyInvalidated } from "./invalidations";

describe("invalidatedFindings", () => {
  it("filters to invalidated verdicts only — RunStatus.invalidations is the FULL audit trail", () => {
    const findings = [
      makeFinding("exp-1", "invalidated"),
      makeFinding("exp-2", "valid"),
      makeFinding("exp-3", "invalidated"),
    ];
    expect(invalidatedFindings(findings).map((f) => f.experiment_id)).toEqual(["exp-1", "exp-3"]);
  });
});

describe("newlyInvalidated", () => {
  it("returns nothing when nothing changed", () => {
    const findings = [makeFinding("exp-1", "invalidated")];
    expect(newlyInvalidated(findings, findings)).toEqual([]);
  });

  it("returns an invalidation that is not in the previous list", () => {
    const previous = [makeFinding("exp-1", "invalidated")];
    const current = [...previous, makeFinding("exp-2", "invalidated")];
    expect(newlyInvalidated(current, previous).map((f) => f.experiment_id)).toEqual(["exp-2"]);
  });

  it("ignores valid findings on both sides", () => {
    const previous = [makeFinding("exp-1", "valid")];
    const current = [makeFinding("exp-1", "valid"), makeFinding("exp-2", "valid")];
    expect(newlyInvalidated(current, previous)).toEqual([]);
  });

  it("does not re-report an id that was already invalidated, even across unrelated changes", () => {
    const previous = [makeFinding("exp-1", "invalidated")];
    const current = [makeFinding("exp-1", "invalidated"), makeFinding("exp-2", "valid")];
    expect(newlyInvalidated(current, previous)).toEqual([]);
  });
});
