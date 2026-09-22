import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveRegion } from "./LiveRegion";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const region = () => screen.getByRole("status");

describe("LiveRegion", () => {
  it("is a polite, atomic live region, hidden from sight but not from screen readers", () => {
    render(<LiveRegion message="" />);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "true");
    expect(region()).toHaveClass("sr-only");
  });

  it("announces the first message immediately", () => {
    render(<LiveRegion message="principal -> data_team" />);
    expect(region()).toHaveTextContent("principal -> data_team");
  });

  it("speaks only the LATEST message per interval, not every one", () => {
    const { rerender } = render(<LiveRegion message="event 1" intervalMs={2000} />);
    expect(region()).toHaveTextContent("event 1");

    // a burst arrives inside the window
    for (const n of [2, 3, 4, 5]) {
      rerender(<LiveRegion message={`event ${n}`} intervalMs={2000} />);
      act(() => vi.advanceTimersByTime(100));
    }
    expect(region()).toHaveTextContent("event 1"); // nothing new has been spoken yet

    act(() => vi.advanceTimersByTime(2000));
    expect(region()).toHaveTextContent("event 5"); // one announcement, the latest
    expect(region()).not.toHaveTextContent("event 3");
  });

  it("can be assertive, for the one thing that must interrupt", () => {
    render(<LiveRegion message="Red team invalidated exp-001" politeness="assertive" />);
    expect(region()).toHaveAttribute("aria-live", "assertive");
  });

  it("says nothing for an empty message", () => {
    render(<LiveRegion message="" />);
    expect(region()).toBeEmptyDOMElement();
  });
});
