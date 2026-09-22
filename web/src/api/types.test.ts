import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ActivityEvent,
  ExperimentResult,
  PendingApproval,
  RedTeamFinding,
  Replay,
  ReplayFrame,
  ReplayHeader,
  RunStatus,
  TaskResult,
} from "./types";

/** These are assertions about TYPES, checked by `tsc` (npm run typecheck), not at runtime: the
 * runtime `expect` below only keeps Vitest from calling the file empty. A field that drifts from
 * "always sent" to optional in the generated schema fails the typecheck, not a browser session. */
describe("generated response types", () => {
  it("mark every field the API always sends as required", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<Required<RunStatus>>();
    expectTypeOf<PendingApproval>().toEqualTypeOf<Required<PendingApproval>>();
    expectTypeOf<ActivityEvent>().toEqualTypeOf<Required<ActivityEvent>>();
    expectTypeOf<ExperimentResult>().toEqualTypeOf<Required<ExperimentResult>>();
    expectTypeOf<RedTeamFinding>().toEqualTypeOf<Required<RedTeamFinding>>();
    expectTypeOf<ReplayHeader>().toEqualTypeOf<Required<ReplayHeader>>();
    expectTypeOf<ReplayFrame>().toEqualTypeOf<Required<ReplayFrame>>();
    expectTypeOf<Replay>().toEqualTypeOf<Required<Replay>>();
    expectTypeOf<TaskResult>().toEqualTypeOf<Required<TaskResult>>();
    expect(true).toBe(true);
  });

  it("carry the fields the console reads", () => {
    expectTypeOf<ActivityEvent["ts"]>().toEqualTypeOf<string>();
    expectTypeOf<ActivityEvent["kind"]>().toEqualTypeOf<"node" | "interrupt" | "done" | "error">();
    expectTypeOf<RunStatus["experiments"]>().toEqualTypeOf<ExperimentResult[]>();
    expectTypeOf<RunStatus["invalidations"]>().toEqualTypeOf<RedTeamFinding[]>();
    expectTypeOf<RunStatus["cost_by_agent"]>().toEqualTypeOf<{ [key: string]: number }>();
    expectTypeOf<ExperimentResult>().toHaveProperty("code");
    expectTypeOf<PendingApproval["gate"]>().toEqualTypeOf<"budget" | "final">();
    expect(true).toBe(true);
  });
});
