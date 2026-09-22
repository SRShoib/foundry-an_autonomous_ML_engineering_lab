import { describe, expect, it } from "vitest";

import { mlflowRunUrl } from "./mlflow";

describe("mlflowRunUrl", () => {
  it("builds a run link against the default local tracking URL", () => {
    expect(mlflowRunUrl("run-abc")).toBe("http://localhost:5000/#/experiments/0/runs/run-abc");
  });
});
