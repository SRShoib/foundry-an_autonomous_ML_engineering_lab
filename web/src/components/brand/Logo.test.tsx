import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Logo, LogoMark } from "./Logo";

describe("Logo", () => {
  it("names itself 'foundry' with the wordmark shown", () => {
    render(<Logo />);
    expect(screen.getByText("foundry")).toBeInTheDocument();
    expect(screen.getByText("foundry")).toHaveClass("gradient-text");
  });

  it("still names itself, for assistive tech, when the wordmark is hidden", () => {
    render(<Logo wordmark={false} />);
    expect(screen.getByText("foundry")).toHaveClass("sr-only");
  });

  it("hides the drawing itself from assistive tech", () => {
    const { container } = render(<Logo />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("takes its colours from the brand tokens, never a literal", () => {
    const { container } = render(<LogoMark />);
    const stops = [...container.querySelectorAll("stop")].map((stop) => stop.getAttribute("stop-color"));
    expect(stops).toContain("var(--brand-1)");
    expect(stops).toContain("var(--brand-2)");
    expect(stops).toContain("var(--brand-3)");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("gives every mark its own gradient id, so two on one page cannot collide", () => {
    const { container } = render(
      <>
        <LogoMark />
        <LogoMark />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((gradient) => gradient.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("scales the mark with the size prop", () => {
    const { container, rerender } = render(<Logo size="sm" />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "24");
    rerender(<Logo size="md" />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "30");
  });
});
