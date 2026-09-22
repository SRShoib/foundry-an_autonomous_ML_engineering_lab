import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeEvidence, makeFinding, makeRunStatus } from "../test/fixtures";
import { AuditPanel, evidenceHeadline } from "./AuditPanel";
import type { Choreography } from "./useInvalidationChoreography";

const IDLE: Choreography = { phase: "idle", finding: null };

describe("evidenceHeadline", () => {
  it("leakage: the worst column and its measured AUC", () => {
    const finding = makeFinding("exp-1", "invalidated", {
      category: "leakage",
      evidence: makeEvidence({ worst_column: "signup_bonus", worst_column_target_auc: 0.9962 }),
    });
    expect(evidenceHeadline(finding)).toEqual({ label: "signup_bonus", value: "AUC 0.9962" });
  });

  it("contamination: the duplicate row rate as a percentage", () => {
    const finding = makeFinding("exp-1", "invalidated", {
      category: "contamination",
      evidence: makeEvidence({ duplicate_row_rate: 0.082 }),
    });
    expect(evidenceHeadline(finding)).toEqual({ label: "duplicate rows", value: "8.2%" });
  });

  it("validation_overfitting: the reported metric itself", () => {
    const finding = makeFinding("exp-1", "invalidated", {
      category: "validation_overfitting",
      evidence: makeEvidence({ reported_metric_name: "roc_auc", reported_metric_value: 0.9995 }),
    });
    expect(evidenceHeadline(finding)).toEqual({ label: "roc_auc", value: "0.9995" });
  });

  it.each(["seed_hacking", "improper_cv"] as const)(
    "%s has no code-measured evidence to show",
    (category) => {
      const finding = makeFinding("exp-1", "invalidated", { category, evidence: makeEvidence() });
      expect(evidenceHeadline(finding)).toBeNull();
    },
  );

  it("returns null when the finding predates M9d and carries no evidence at all", () => {
    const finding = makeFinding("exp-1", "invalidated", { evidence: null });
    expect(evidenceHeadline(finding)).toBeNull();
  });
});

describe("AuditPanel", () => {
  it("shows an empty state naming what happens next when nothing has been audited", () => {
    render(<AuditPanel status={makeRunStatus({ invalidations: [] })} choreography={IDLE} onOpen={vi.fn()} />);
    expect(screen.getByText(/audits every cleared experiment/)).toBeInTheDocument();
  });

  it("shows an empty state that reads differently once some audits have cleared", () => {
    const status = makeRunStatus({ invalidations: [makeFinding("exp-1", "valid")] });
    render(<AuditPanel status={status} choreography={IDLE} onOpen={vi.fn()} />);
    expect(screen.getByText(/Every audited experiment has cleared/)).toBeInTheDocument();
  });

  it("filters RunStatus.invalidations to invalidated verdicts only, and counts them in the header", () => {
    const status = makeRunStatus({
      invalidations: [makeFinding("exp-1", "invalidated"), makeFinding("exp-2", "valid")],
    });
    render(<AuditPanel status={status} choreography={IDLE} onOpen={vi.fn()} />);
    expect(screen.getByText("1 invalidated")).toBeInTheDocument();
    expect(screen.getByText("exp-1")).toBeInTheDocument();
    expect(screen.queryByText("exp-2")).not.toBeInTheDocument();
  });

  it("renders the choreography's own finding expanded — category at display size, with evidence", () => {
    const finding = makeFinding("exp-1", "invalidated", {
      category: "leakage",
      evidence: makeEvidence({ worst_column: "retention_call_outcome", worst_column_target_auc: 0.9962 }),
    });
    const status = makeRunStatus({ invalidations: [finding] });
    render(<AuditPanel status={status} choreography={{ phase: "finding", finding }} onOpen={vi.fn()} />);
    expect(screen.getByText("leakage")).toHaveClass("text-display");
    expect(screen.getByText("AUC 0.9962")).toBeInTheDocument();
  });

  it("a finding not currently active in the choreography renders as a compact row, not expanded", () => {
    const finding = makeFinding("exp-1", "invalidated");
    const status = makeRunStatus({ invalidations: [finding] });
    render(<AuditPanel status={status} choreography={IDLE} onOpen={vi.fn()} />);
    expect(screen.queryByText("leakage")).not.toHaveClass("text-display");
  });

  it("opens an experiment from either a compact or an expanded row", async () => {
    const finding = makeFinding("exp-1", "invalidated");
    const status = makeRunStatus({ invalidations: [finding] });
    const onOpen = vi.fn();
    render(<AuditPanel status={status} choreography={{ phase: "finding", finding }} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Open experiment exp-1" }));
    expect(onOpen).toHaveBeenCalledWith("exp-1");
  });
});
