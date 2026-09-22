import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "../../run/RunSource";
import { DisconnectedBar, useDisconnectPhase } from "./DisconnectedBar";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function phases(...sequence: ConnectionState[]) {
  const { result, rerender } = renderHook(({ c }) => useDisconnectPhase(c), {
    initialProps: { c: sequence[0] as ConnectionState },
  });
  const seen = [result.current];
  for (const next of sequence.slice(1)) {
    rerender({ c: next });
    seen.push(result.current);
  }
  return { seen, result };
}

describe("useDisconnectPhase", () => {
  it("is hidden while the stream is healthy", () => {
    expect(phases("connecting", "open", "open").seen).toEqual(["hidden", "hidden", "hidden"]);
  });

  it("runs indeterminate while reconnecting", () => {
    expect(phases("open", "reconnecting", "reconnecting").seen).toEqual([
      "hidden",
      "indeterminate",
      "indeterminate",
    ]);
  });

  it("COMPLETES on reconnect rather than vanishing, then hides after the settle time", () => {
    const { seen, result } = phases("open", "reconnecting", "open");
    expect(seen).toEqual(["hidden", "indeterminate", "completing"]);

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("completing");
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBe("hidden");
  });

  it("does not celebrate a recovery that did not happen: giving up just hides", () => {
    expect(phases("open", "reconnecting", "error").seen).toEqual(["hidden", "indeterminate", "hidden"]);
    expect(phases("open", "reconnecting", "idle").seen).toEqual(["hidden", "indeterminate", "hidden"]);
  });

  it("does not complete for a stream that was never disconnected", () => {
    expect(phases("connecting", "open").seen).toEqual(["hidden", "hidden"]);
  });
});

describe("DisconnectedBar", () => {
  it("is decorative: the stream-health pill says the same in words", () => {
    const { container } = render(<DisconnectedBar connection="reconnecting" />);
    const bar = container.firstElementChild;
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).toHaveAttribute("data-phase", "indeterminate");
    expect(bar).toHaveClass("h-0.5"); // 2px
  });
});
