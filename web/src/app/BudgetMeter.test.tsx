import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BudgetMeter, useThresholdTicks } from "./BudgetMeter";
import { makeGate, makeRunStatus } from "../test/fixtures";

describe("BudgetMeter", () => {
  it("shows a skeleton, not the meter, before a status arrives", () => {
    render(<BudgetMeter status={null} />);
    expect(screen.getByText("budget")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("prints the cap in the panel header and the spend as the hero number", () => {
    render(<BudgetMeter status={makeRunStatus({ spent_usd: 12.84, budget_usd: 20 })} />);
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("$12.84")).toBeInTheDocument();
  });

  it("exposes spend as an accessible progressbar, with the figure always printed too (§3.1)", () => {
    render(<BudgetMeter status={makeRunStatus({ spent_usd: 5, budget_usd: 20 })} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "20");
    expect(bar).toHaveAttribute("aria-valuetext", "$5.00 of $20.00");
  });

  it.each([
    [10, "bg-meter-safe"],
    [15, "bg-meter-pressure"],
    [19, "bg-meter-critical"],
  ])("colours the fill by the shared threshold ramp: $%d of $20 is %s", (spent, cls) => {
    render(<BudgetMeter status={makeRunStatus({ spent_usd: spent, budget_usd: 20 })} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.querySelector(`.${cls}`)).not.toBeNull();
  });

  it("draws the projected-spend hatch only when a gate is pending, spanning spent to projected", () => {
    const { rerender } = render(<BudgetMeter status={makeRunStatus({ spent_usd: 5, budget_usd: 20 })} />);
    expect(screen.getByRole("progressbar").querySelector(".meter-hatch")).toBeNull();

    rerender(
      <BudgetMeter
        status={makeRunStatus({
          spent_usd: 5,
          budget_usd: 20,
          status: "awaiting_approval",
          pending_approval: makeGate({ spent_usd: 5, budget_usd: 20, projected_usd: 15 }),
        })}
      />,
    );
    const hatch = screen.getByRole("progressbar").querySelector(".meter-hatch") as HTMLElement;
    expect(hatch).not.toBeNull();
    expect(hatch).toHaveStyle({ left: "25%", width: "50%" });
    expect(screen.getByText("projected")).toBeInTheDocument();
    expect(screen.getByText("$15.00")).toBeInTheDocument();
  });

  it("shows no hatch and no \"projected\" row for the final gate's sign-off, which projects nothing beyond spend", () => {
    // The demo recording's final-gate PendingApproval carries projected_usd: 0 — it is a sign-off,
    // not a spend estimate — which used to render a nonsensical "projected $0.00" under a $0.30 bar.
    render(
      <BudgetMeter
        status={makeRunStatus({
          spent_usd: 0.3,
          budget_usd: 1,
          status: "awaiting_approval",
          pending_approval: makeGate({ gate: "final", spent_usd: 0.3, budget_usd: 1, projected_usd: 0 }),
        })}
      />,
    );
    expect(screen.getByRole("progressbar").querySelector(".meter-hatch")).toBeNull();
    expect(screen.queryByText("projected")).not.toBeInTheDocument();
  });
});

describe("useThresholdTicks", () => {
  it("has no ticks below 70%", () => {
    const { result } = renderHook(() => useThresholdTicks(0.5));
    expect(result.current).toEqual({ pressure: false, critical: false });
  });

  it("lights the pressure tick at 70% and the critical tick past 90%", () => {
    const { result, rerender } = renderHook(({ f }) => useThresholdTicks(f), { initialProps: { f: 0.5 } });
    rerender({ f: 0.7 });
    expect(result.current).toEqual({ pressure: true, critical: false });
    rerender({ f: 0.95 });
    expect(result.current).toEqual({ pressure: true, critical: true });
  });

  it("keeps a tick lit even if the fraction later drops back below the threshold — it marks history", () => {
    const { result, rerender } = renderHook(({ f }) => useThresholdTicks(f), { initialProps: { f: 0.95 } });
    rerender({ f: 0.2 });
    expect(result.current).toEqual({ pressure: true, critical: true });
  });

  it("lights immediately on mount if it starts past a threshold (a reload mid-run)", () => {
    const { result } = renderHook(() => useThresholdTicks(0.92));
    expect(result.current).toEqual({ pressure: true, critical: true });
  });
});
