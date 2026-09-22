import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InstrumentBar } from "./InstrumentBar";
import { RunStatusPill, StreamHealthPill, streamHealth } from "./StatusPills";

describe("InstrumentBar", () => {
  const bar = (spent: number, cap: number) => {
    const { container } = render(
      <InstrumentBar status="running" spentUsd={spent} budgetUsd={cap} connection="open" mode="live" />,
    );
    return container;
  };

  it("carries the three values that must never be lost: phase, spend, stream health", () => {
    bar(12.84, 20);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("$12.84/$20.00")).toHaveClass("num");
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("draws a 2px full-bleed budget line, filled in proportion to spend", () => {
    const line = bar(5, 20).querySelector(".bg-meter-track");
    expect(line).toHaveClass("h-0.5");
    expect(line?.firstElementChild).toHaveStyle({ width: "25.0%" });
  });

  it.each([
    [10, "bg-meter-safe"],
    [15, "bg-meter-pressure"], // 75%
    [19, "bg-meter-critical"], // 95%
  ])("colours the line by the shared threshold ramp: $%d spent is %s", (spent, cls) => {
    const fill = bar(spent, 20).querySelector(".bg-meter-track")?.firstElementChild;
    expect(fill).toHaveClass(cls);
  });

  it("is shown only below the three-column frame", () => {
    expect(bar(1, 20).firstElementChild).toHaveClass("frame:hidden");
  });

  it("is sticky, so the values stay put while the feed scrolls", () => {
    expect(bar(1, 20).firstElementChild).toHaveClass("sticky");
  });
});

describe("status pills", () => {
  it("pair every dot with a text label, so colour is never the only carrier (WCAG 1.4.1)", () => {
    render(<RunStatusPill status="awaiting_approval" />);
    expect(screen.getByText("awaiting approval")).toBeInTheDocument();
    expect(screen.getByText("●")).toHaveAttribute("aria-hidden", "true");
  });

  it("says so plainly when there is no run status yet", () => {
    render(<RunStatusPill status={null} />);
    expect(screen.getByText("not started")).toBeInTheDocument();
  });

  it.each([
    ["live", "open", "live"],
    ["live", "reconnecting", "reconnecting"],
    ["live", "error", "disconnected"],
    ["live", "closed", "stream ended"],
    ["live", "connecting", "connecting"],
    ["replay", "open", "replay"],
    ["replay", "closed", "replay ended"],
  ] as const)("labels a %s stream that is %s as %j", (mode, connection, label) => {
    expect(streamHealth(connection, mode).label).toBe(label);
  });

  it("renders the stream health with its label", () => {
    render(<StreamHealthPill connection="reconnecting" mode="live" />);
    expect(screen.getByText("reconnecting")).toBeInTheDocument();
  });
});
