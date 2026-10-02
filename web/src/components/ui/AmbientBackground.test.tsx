import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AmbientBackground } from "./AmbientBackground";

describe("AmbientBackground", () => {
  it("is decorative: hidden from assistive tech and inert to the pointer", () => {
    const { container } = render(<AmbientBackground />);
    const layer = container.firstElementChild;
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer).toHaveClass("pointer-events-none");
  });

  it("sits behind content in a fixed layer", () => {
    const { container } = render(<AmbientBackground />);
    expect(container.firstElementChild).toHaveClass("fixed", "inset-0", "-z-10");
  });

  it("holds nothing focusable or interactive", () => {
    const { container } = render(<AmbientBackground />);
    expect(container.querySelectorAll("a, button, input, select, textarea, [tabindex]")).toHaveLength(0);
  });

  it("animates only the aurora layer, never the grain", () => {
    const { container } = render(<AmbientBackground />);
    const animated = container.querySelectorAll(".aurora-drift");
    expect(animated).toHaveLength(1);
    expect(animated[0]).toHaveClass("aurora");
    expect(container.querySelector(".grain")).not.toHaveClass("aurora-drift");
  });
});
