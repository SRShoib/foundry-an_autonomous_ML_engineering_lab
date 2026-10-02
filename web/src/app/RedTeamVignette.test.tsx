import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFinding } from "../test/fixtures";
import { RedTeamVignette } from "./RedTeamVignette";
import type { Choreography } from "./useInvalidationChoreography";

// Motion's real useReducedMotion caches its answer in a module-level singleton initialised on first
// use, so a test that flips the media query after any earlier render in this file would see a stale
// value. Mocking the hook (and only the hook — `motion.div` stays real) is the same isolation
// lib/useAnimatedNumber.test.ts and app/useInvalidationChoreography.test.ts already use.
const reducedMotion = vi.hoisted(() => ({ value: false as boolean }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reducedMotion.value,
}));

beforeEach(() => {
  reducedMotion.value = false;
});

const finding = makeFinding("exp-001", "invalidated");
const at = (phase: Choreography["phase"]): Choreography => ({ phase, finding: phase === "idle" ? null : finding });

describe("RedTeamVignette", () => {
  it("draws nothing while idle — an idle mount with existing invalidations must never play it", () => {
    const { container } = render(<RedTeamVignette choreography={at("idle")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["flag", "demote", "connect", "finding"] as const)("is present during the %s beat", (phase) => {
    const { container } = render(<RedTeamVignette choreography={at(phase)} />);
    expect(container.querySelector("[data-vignette]")).not.toBeNull();
  });

  it("is decorative and inert: hidden from assistive tech, no pointer events, tokenized shadow", () => {
    const { container } = render(<RedTeamVignette choreography={at("flag")} />);
    const vignette = container.querySelector("[data-vignette]");
    expect(vignette).toHaveAttribute("aria-hidden", "true");
    expect(vignette).toHaveClass("pointer-events-none", "fixed", "inset-0", "shadow-vignette-danger");
  });

  it("is not drawn at all under reduced motion — it carries no information the panel does not", () => {
    reducedMotion.value = true;
    const { container } = render(<RedTeamVignette choreography={at("flag")} />);
    expect(container.querySelector("[data-vignette]")).toBeNull();
  });
});
