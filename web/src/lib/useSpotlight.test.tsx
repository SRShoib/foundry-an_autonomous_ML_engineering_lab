import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSpotlight } from "./useSpotlight";

function Surface() {
  const spot = useSpotlight<HTMLDivElement>();
  return <div data-testid="surface" {...spot} />;
}

beforeEach(() => {
  // Run the frame callback synchronously: the hook's contract is "one write per frame", and this lets
  // a test see the write without waiting on a real frame.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

describe("useSpotlight", () => {
  it("writes the pointer position, relative to the element, as --mx and --my", () => {
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    // jsdom lays nothing out, so the rect is all zeroes and the position is the raw client position.
    fireEvent.pointerMove(surface, { clientX: 40, clientY: 25, pointerType: "mouse" });
    expect(surface.style.getPropertyValue("--mx")).toBe("40px");
    expect(surface.style.getPropertyValue("--my")).toBe("25px");
  });

  it("subtracts the element's own offset", () => {
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 100, top: 60 } as DOMRect);
    fireEvent.pointerMove(surface, { clientX: 130, clientY: 75, pointerType: "mouse" });
    expect(surface.style.getPropertyValue("--mx")).toBe("30px");
    expect(surface.style.getPropertyValue("--my")).toBe("15px");
  });

  it("ignores touch: there is no hover to follow", () => {
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    fireEvent.pointerMove(surface, { clientX: 40, clientY: 25, pointerType: "touch" });
    expect(surface.style.getPropertyValue("--mx")).toBe("");
  });

  it("leaves the last position in place on leave, so the highlight fades out where it was", () => {
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    fireEvent.pointerMove(surface, { clientX: 40, clientY: 25, pointerType: "mouse" });
    fireEvent.pointerLeave(surface);
    expect(surface.style.getPropertyValue("--mx")).toBe("40px");
  });

  it("coalesces a burst of moves into the latest frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    fireEvent.pointerMove(surface, { clientX: 1, clientY: 1, pointerType: "mouse" });
    fireEvent.pointerMove(surface, { clientX: 2, clientY: 2, pointerType: "mouse" });
    fireEvent.pointerMove(surface, { clientX: 3, clientY: 3, pointerType: "mouse" });
    // Nothing is written until a frame runs, and the earlier two were cancelled by the later ones;
    // running every queued callback (the stub cannot actually cancel) still ends on the LAST position.
    expect(surface.style.getPropertyValue("--mx")).toBe("");
    for (const callback of callbacks) callback(0);
    expect(surface.style.getPropertyValue("--mx")).toBe("3px");
  });
});
