"""Human-in-the-loop gates (SPEC M6: "budget gate... final gate"; CLAUDE.md: "both interrupt()
gates are real and checkpointer-backed, never skipped"). `ask()` is the single place that calls
langgraph.types.interrupt() and validates what comes back, so there is exactly one spot that turns
a raw resume value into a HumanResponse instead of trusting it directly (CLAUDE.md: "Only
validate at system boundaries" — a human's Command(resume=...) IS a system boundary, whether it
arrived via app/main.py's FastAPI request body or foundry/cli.py's stdin prompt). Both
foundry/teams/principal.py's budget gate and this module's final_gate node call it.

budget_approval_request() is a pure predicate + payload builder, deliberately separate from the
interrupt() call itself, so the gate condition (and foundry/tools/cost.py's project_run_usd floor
beating a low-balled ExperimentSpec.est_cost_usd) is unit-testable without a graph, a
checkpointer, or a real interrupt. It fires at most once per run: once a HumanDecision(gate=
"budget") already exists in state["human_decisions"], the condition stops being asked again — the
unappealable code cap (spent_usd >= budget_usd, checked in foundry/teams/principal.py before any
LLM call) still stops the run regardless, so the gate's job is only "flag that this is about to
get expensive", not to be re-litigated every subsequent turn on the same still-true condition.

final_gate is a standalone node between reporter and END (foundry/graph.py), not code inside
reporter itself: reporter's own LLM call happens before this point, and a node re-executes ALL of
its logic from the top on resume (verified against the installed LangGraph 1.2.9 — an interrupted
node commits nothing and replays in full once resumed). Placing the interrupt after an LLM call
would re-bill that call every time a human's approval is awaited; final_gate does no LLM work at
all, so replaying it on resume costs nothing.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langgraph.types import interrupt

from foundry.config import settings
from foundry.models import ApprovalRequest, ExperimentSpec, HumanDecision, HumanResponse
from foundry.state import FoundryState
from foundry.tools.cost import project_run_usd


def ask(request: ApprovalRequest) -> HumanResponse:
    raw = interrupt(request.model_dump(mode="json"))
    return HumanResponse.model_validate(raw)


def budget_approval_request(
    state: FoundryState, pending: Sequence[ExperimentSpec], spent_usd: float
) -> ApprovalRequest | None:
    if any(decision.gate == "budget" for decision in state["human_decisions"]):
        return None

    completed_costs = [r.cost_usd for r in state["experiments"] if r.status == "success"]
    projected = {
        spec.experiment_id: project_run_usd(spec.est_cost_usd, completed_costs) for spec in pending
    }
    projected_total = round(sum(projected.values()), 8)
    budget_usd = state["budget_usd"]

    over_threshold = spent_usd + projected_total > settings.budget_gate_fraction * budget_usd
    over_cap_ids = sorted(
        eid for eid, cost in projected.items() if cost > settings.cost_cap_usd_per_run
    )
    if not (over_threshold or over_cap_ids):
        return None

    reasons: list[str] = []
    if over_threshold:
        reasons.append(
            f"projected spend ${spent_usd + projected_total:.2f} would exceed "
            f"{settings.budget_gate_fraction:.0%} of the ${budget_usd:.2f} budget"
        )
    if over_cap_ids:
        reasons.append(
            f"experiment(s) {over_cap_ids} project above the "
            f"${settings.cost_cap_usd_per_run:.2f} per-run cap"
        )
    return ApprovalRequest(
        gate="budget",
        reason="; ".join(reasons),
        spent_usd=spent_usd,
        budget_usd=budget_usd,
        projected_usd=projected_total,
    )


def final_gate(state: FoundryState) -> dict[str, Any]:
    board = state["leaderboard"]
    best = board[0] if board else None
    request = ApprovalRequest(
        gate="final",
        reason=f"sign-off requested — stop_reason={state['stop_reason']}",
        spent_usd=state["spent_usd"],
        budget_usd=state["budget_usd"],
        best_experiment_id=best.experiment_id if best else None,
        best_metric_name=best.primary_metric_name if best else None,
        best_metric_value=best.primary_metric_value if best else None,
        n_invalidated=sum(1 for f in state["invalidations"] if f.verdict == "invalidated"),
        report_md=state["report_md"],
    )
    response = ask(request)

    status_line = "APPROVED" if response.approved else "DECLINED"
    note_suffix = f" — {response.note}" if response.note else ""
    report_md = state["report_md"] or ""

    return {
        "human_decisions": [
            HumanDecision(gate="final", approved=response.approved, note=response.note)
        ],
        "report_md": f"{report_md}\n\n## Sign-off\n\n**{status_line}**{note_suffix}",
    }
