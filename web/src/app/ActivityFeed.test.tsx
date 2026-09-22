import { useRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityFeed, VIRTUALIZE_ABOVE, entryMotion, feedRowStyle, type ActivityFeedProps } from "./ActivityFeed";
import type { ActivityEvent } from "../api/types";
import { makeEvent } from "../test/fixtures";

/** Mirrors the real structure: AppFrame owns the scrolling element and ActivityFeed renders
 * INSIDE it, sharing the same ref rather than nesting a second scroller. */
function Harness(props: Omit<ActivityFeedProps, "scrollElementRef">) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="scroll-container" style={{ height: 200, overflow: "auto" }}>
      <ActivityFeed {...props} scrollElementRef={ref} />
    </div>
  );
}

function setScrollShape(element: HTMLElement, { scrollTop = 0, scrollHeight = 0, clientHeight = 0 }) {
  Object.defineProperty(element, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
}

const events = (n: number): ActivityEvent[] => Array.from({ length: n }, (_, i) => makeEvent(i));

describe("entryMotion", () => {
  it("is opacity-only at high rate, regardless of batch size", () => {
    expect(entryMotion(1, 25)).toEqual({ slide: false, durationS: 0.09, staggerS: 0 });
  });

  it("drops the stagger above 6 in a tick, but keeps the slide", () => {
    expect(entryMotion(7, 5)).toEqual({ slide: true, durationS: 0.14, staggerS: 0 });
  });

  it("slides with a small stagger in the base case", () => {
    expect(entryMotion(2, 5)).toEqual({ slide: true, durationS: 0.14, staggerS: 0.02 });
  });

  it("treats the rate threshold as the top priority even with a small batch", () => {
    expect(entryMotion(1, 20)).toMatchObject({ slide: false });
  });
});

describe("feedRowStyle", () => {
  it("uses the team's own hue and label for a node event", () => {
    const style = feedRowStyle(makeEvent(0, { node: "red_team" }));
    expect(style.label).toBe("red team");
    expect(style.railClass).toBe("bg-team-redteam");
    expect(style.railWidthPx).toBe(5); // the heavier rail, red_team only
  });

  it.each([
    ["interrupt", "text-status-warn"],
    ["done", "text-status-ok"],
    ["error", "text-status-danger"],
] as const)("falls back to the status ramp for a %s event, which carries no node", (kind, textClass) => {
    const style = feedRowStyle(makeEvent(0, { kind, node: null }));
    expect(style.label).toBe(kind);
    expect(style.textClass).toBe(textClass);
  });

  it("shows a humanised node name for a node with no team of its own (final_gate, lesson_writer)", () => {
    expect(feedRowStyle(makeEvent(0, { node: "final_gate" })).label).toBe("final gate");
    expect(feedRowStyle(makeEvent(0, { node: "lesson_writer" })).label).toBe("lesson writer");
  });
});

describe("ActivityFeed", () => {
  it("shows a loading skeleton, not an empty state, while still connecting", () => {
    render(<Harness events={[]} batchSize={0} ratePerSecond={0} connected={false} />);
    expect(screen.queryByText("No events yet")).not.toBeInTheDocument();
  });

  it("shows the empty state once connected with genuinely nothing yet", () => {
    render(<Harness events={[]} batchSize={0} ratePerSecond={0} connected={true} />);
    expect(screen.getByText("No events yet")).toBeInTheDocument();
  });

  it("renders one row per event, the summary verbatim, and the zero-padded seq", () => {
    const list = [makeEvent(0, { node: "data_team", summary: "data_team: profiled + cleaned" })];
    render(<Harness events={list} batchSize={1} ratePerSecond={0} connected />);
    const rows = within(screen.getByRole("list", { name: "Activity feed" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("000");
    expect(rows[0]).toHaveTextContent("data_team: profiled + cleaned");
    expect(rows[0]).toHaveTextContent("data");
  });

  it("prints a per-row cost only when the event actually carries one", () => {
    const list = [
      makeEvent(0, { spent_usd: 0.0412 }),
      makeEvent(1, { spent_usd: null }),
    ];
    render(<Harness events={list} batchSize={2} ratePerSecond={0} connected />);
    expect(screen.getByText("$0.0412")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Activity feed" })).getAllByRole("listitem");
    expect(rows[1]).not.toHaveTextContent("$");
  });

  it("renders every row below the virtualization threshold as a plain flex list", () => {
    render(<Harness events={events(10)} batchSize={10} ratePerSecond={0} connected />);
    const list = screen.getByRole("list", { name: "Activity feed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(list).not.toHaveAttribute("style");
  });

  it("switches to a height-styled, windowed list above the virtualization threshold", () => {
    const n = VIRTUALIZE_ABOVE + 5;
    render(<Harness events={events(n)} batchSize={n} ratePerSecond={0} connected />);
    const list = screen.getByRole("list", { name: "Activity feed" });
    // jsdom lays out nothing, so the exact set of mounted rows is not meaningful to assert — but
    // the list itself must be handed the virtualizer's own total-height style, proving the
    // component actually switched modes rather than silently rendering the plain path.
    expect(list.style.height).not.toBe("");
    for (const row of within(list).queryAllByRole("listitem")) {
      expect(row).toHaveAttribute("aria-setsize", String(n));
    }
  });

  it("auto-scrolls to the bottom when new events arrive while following", () => {
    const { rerender } = render(<Harness events={events(1)} batchSize={1} ratePerSecond={0} connected />);
    const container = screen.getByTestId("scroll-container");
    setScrollShape(container, { scrollHeight: 500 });

    rerender(<Harness events={events(2)} batchSize={1} ratePerSecond={0} connected />);
    expect(container.scrollTop).toBe(500);
  });

  it("disengages follow-mode when the operator scrolls away from the bottom, and shows the live control", () => {
    render(<Harness events={events(5)} batchSize={5} ratePerSecond={0} connected />);
    const container = screen.getByTestId("scroll-container");
    expect(screen.queryByRole("button", { name: /live/ })).not.toBeInTheDocument();

    setScrollShape(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: /live/ })).toBeInTheDocument();
  });

  it("re-engages follow-mode and jumps to the bottom when \"live\" is pressed", () => {
    render(<Harness events={events(5)} batchSize={5} ratePerSecond={0} connected />);
    const container = screen.getByTestId("scroll-container");
    setScrollShape(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(container);
    const liveButton = screen.getByRole("button", { name: /live/ });

    fireEvent.click(liveButton);
    expect(container.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: /live/ })).not.toBeInTheDocument();
  });

  it("holdFollow stops auto-scroll and hides the live control without touching following itself", () => {
    const { rerender } = render(
      <Harness events={events(1)} batchSize={1} ratePerSecond={0} connected holdFollow />,
    );
    const container = screen.getByTestId("scroll-container");
    setScrollShape(container, { scrollHeight: 500 });

    rerender(<Harness events={events(2)} batchSize={1} ratePerSecond={0} connected holdFollow />);
    expect(container.scrollTop).toBe(0); // no auto-scroll while held
    expect(screen.queryByRole("button", { name: /live/ })).not.toBeInTheDocument(); // still following, just held

    rerender(<Harness events={events(3)} batchSize={1} ratePerSecond={0} connected />);
    expect(container.scrollTop).toBe(500); // resumes exactly where following left off
  });
});
