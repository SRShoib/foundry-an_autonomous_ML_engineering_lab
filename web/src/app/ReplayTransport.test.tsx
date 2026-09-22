import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DivergenceNotice, ReplayTransportView } from "./ReplayTransport";
import type { TransportState } from "../run/RunSource";

const transport = (overrides: Partial<TransportState> = {}): TransportState => ({
  playing: false,
  speed: 1,
  elapsedS: 5,
  durationS: 20,
  ...overrides,
});

function setup(t: TransportState, locked = false) {
  const handlers = { onPlay: vi.fn(), onPause: vi.fn(), onSpeed: vi.fn(), onSeek: vi.fn() };
  render(<ReplayTransportView transport={t} locked={locked} {...handlers} />);
  return handlers;
}

describe("ReplayTransportView", () => {
  it("offers play when paused and pause when playing, named by the action", async () => {
    const paused = setup(transport({ playing: false }));
    await userEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(paused.onPlay).toHaveBeenCalledOnce();
  });

  it("offers pause while playing", async () => {
    const playing = setup(transport({ playing: true }));
    await userEvent.click(screen.getByRole("button", { name: "Pause replay" }));
    expect(playing.onPause).toHaveBeenCalledOnce();
  });

  it("selects 1×, 4× or 16× through a native radio group", async () => {
    const { onSpeed } = setup(transport({ speed: 4 }));
    expect(screen.getByRole("radio", { name: "4×" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "1×" })).not.toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "16×" }));
    expect(onSpeed).toHaveBeenCalledWith(16);
    expect(screen.getByRole("group", { name: "Playback speed" })).toBeInTheDocument();
  });

  it("moves between speeds with the arrow keys, which native radios provide for free", async () => {
    const { onSpeed } = setup(transport({ speed: 1 }));
    screen.getByRole("radio", { name: "1×" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSpeed).toHaveBeenCalledWith(4);
  });

  it("shows the position and duration in mono, and exposes them to assistive tech", () => {
    setup(transport({ elapsedS: 83, durationS: 125 }));
    expect(screen.getByText("1:23 / 2:05")).toHaveClass("num");
    const slider = screen.getByRole("slider", { name: "Replay position" });
    expect(slider).toHaveAttribute("aria-valuetext", "1:23 of 2:05");
    expect(slider).toHaveValue("664"); // 83/125 of 1000 steps
  });

  it("seeks to a fraction of the run", () => {
    const { onSeek } = setup(transport());
    const slider = screen.getByRole("slider", { name: "Replay position" });
    // fireEvent-style value set through the native setter, as a drag would
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "500");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSeek).toHaveBeenCalledWith(0.5);
  });

  it("locks play and the scrubber while a gate waits: a gate is answered, not scrubbed past", () => {
    setup(transport(), true);
    expect(screen.getByRole("button", { name: "Play replay" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Replay position" })).toBeDisabled();
  });

  it("copes with a zero-length recording", () => {
    setup(transport({ elapsedS: 0, durationS: 0 }));
    expect(screen.getByText("0:00 / 0:00")).toBeInTheDocument();
  });
});

describe("DivergenceNotice", () => {
  it("renders nothing when the operator agreed with the recording", () => {
    const { container } = render(<DivergenceNotice divergence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says plainly what differed and what playback does about it", () => {
    render(
      <DivergenceNotice
        divergence={{ seq: 4, gate: "budget", recordedApproved: true, operatorApproved: false }}
      />,
    );
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("You rejected the budget gate; the recording approved it.");
    expect(note).toHaveTextContent("Playback follows the recording");
  });
});
