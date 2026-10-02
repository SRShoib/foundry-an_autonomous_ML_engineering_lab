import { render, screen } from "@testing-library/react";
import { Check } from "lucide-react";
import { describe, expect, it } from "vitest";

import { Chip, type ChipTone } from "./Chip";

const TONES: readonly ChipTone[] = ["ok", "warn", "danger", "info", "idle", "brand", "neutral"];

describe("Chip", () => {
  it("always carries a text label — colour is never the only carrier of state (WCAG 1.4.1)", () => {
    render(<Chip tone="danger">failed</Chip>);
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("keeps the label in --text-primary, not the tone colour", () => {
    // Tone text on its own 15% tint is under 4.5:1 on the light theme; only the mark takes the tone.
    const { container } = render(<Chip tone="ok">completed</Chip>);
    const chip = container.firstElementChild;
    expect(chip).toHaveClass("text-fg");
    expect(chip?.className).not.toMatch(/(^|\s)text-status-/);
  });

  it.each(TONES)("renders the %s tone", (tone) => {
    const { container } = render(<Chip tone={tone}>label</Chip>);
    expect(container.firstElementChild).toHaveClass("rounded-pill", "ring-1");
  });

  it("tints with a token colour at 15%, never a literal", () => {
    const { container } = render(<Chip tone="warn">awaiting approval</Chip>);
    expect(container.firstElementChild).toHaveClass("bg-status-warn/15");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("shows a dot when no icon is given, and hides it from assistive tech", () => {
    const { container } = render(<Chip tone="info">running</Chip>);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toHaveClass("rounded-pill", "bg-current");
  });

  it("shows the icon instead of the dot when one is given", () => {
    const { container } = render(
      <Chip tone="ok" icon={Check}>
        done
      </Chip>,
    );
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".bg-current")).toBeNull();
  });

  it("emits the ping ring only while live", () => {
    const { container, rerender } = render(<Chip tone="ok">live</Chip>);
    expect(container.querySelector(".ping-ring")).toBeNull();
    rerender(
      <Chip tone="ok" live>
        live
      </Chip>,
    );
    expect(container.querySelector(".ping-ring")).not.toBeNull();
  });

  it("passes a title through as a hint", () => {
    render(
      <Chip tone="idle" title="stream health">
        idle
      </Chip>,
    );
    expect(screen.getByTitle("stream health")).toBeInTheDocument();
  });
});
