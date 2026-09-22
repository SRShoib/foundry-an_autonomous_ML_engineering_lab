import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFinding } from "../test/fixtures";
import { InvalidationConnector } from "./InvalidationConnector";
import { LEADERBOARD_PANEL_ID } from "./Leaderboard";
import type { Choreography } from "./useInvalidationChoreography";

const finding = makeFinding("exp-1", "invalidated");

function Harness({ choreography }: { choreography: Choreography }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="dock">
      <div id={LEADERBOARD_PANEL_ID} />
      <div data-audit-entry="exp-1" />
      <InvalidationConnector containerRef={ref} choreography={choreography} />
    </div>
  );
}

describe("InvalidationConnector", () => {
  it.each(["idle", "flag", "demote"] as const)("draws nothing during %s", (phase) => {
    const { container } = render(<Harness choreography={{ phase, finding: phase === "idle" ? null : finding }} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it.each(["connect", "finding"] as const)("draws the connector during %s, once both anchors exist", (phase) => {
    const { container } = render(<Harness choreography={{ phase, finding }} />);
    expect(container.querySelector("svg line")).not.toBeNull();
  });

  it("draws nothing when the audit anchor for THIS finding is not in the DOM", () => {
    function NoAnchor() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <div id={LEADERBOARD_PANEL_ID} />
          <InvalidationConnector containerRef={ref} choreography={{ phase: "connect", finding }} />
        </div>
      );
    }
    const { container } = render(<NoAnchor />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
