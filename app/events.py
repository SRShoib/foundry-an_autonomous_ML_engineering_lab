"""Compact activity-feed events (SPEC M6: "streamed activity feed"). to_event() maps one
foundry/graph.py stream_mode="updates" chunk — {node_name: update_dict} for a normal step, or
{"__interrupt__": (Interrupt(...),)} when a gate fires — to an EventContent. Deliberately NOT a
state dump: report_md and the full experiments list never stream, only a one-line summary plus
the numbers a live viewer actually wants. Pure and unit-testable without a graph, a checkpointer,
or a background thread — app/runs.py's RunManager is the only caller."""

from __future__ import annotations

from typing import Any, Literal, NamedTuple

from pydantic import BaseModel

EventKind = Literal["node", "interrupt", "done", "error"]


class ActivityEvent(BaseModel):
    thread_id: str
    seq: int
    kind: EventKind
    node: str | None = None
    summary: str
    spent_usd: float | None = None


class EventContent(NamedTuple):
    """thread_id/seq aren't known until app/runs.py's RunHandle stamps an event onto its
    append-only log under its lock — everything else is a pure function of one stream chunk."""

    kind: EventKind
    node: str | None
    summary: str
    spent_usd: float | None = None


def _summarize_update(node: str, update: dict[str, Any]) -> str:
    if node == "principal":
        team = update.get("next_team")
        return f"principal -> {team}" if team else "principal (stopping)"
    if node == "experiment_runner":
        experiments = update.get("experiments") or []
        if experiments:
            first = experiments[0]
            return f"experiment_runner: {first.experiment_id} {first.status}"
        return "experiment_runner"
    if node == "red_team":
        findings = update.get("invalidations") or []
        n_invalid = sum(1 for f in findings if f.verdict == "invalidated")
        return f"red_team: {len(findings)} audited, {n_invalid} invalidated"
    if node == "data_team":
        return "data_team: profiled + cleaned"
    if node == "reporter":
        return "reporter: report drafted"
    if node == "final_gate":
        decisions = update.get("human_decisions") or []
        if decisions:
            return f"final_gate: {'APPROVED' if decisions[0].approved else 'DECLINED'}"
        return "final_gate"
    return node


def to_event(chunk: dict[str, Any]) -> EventContent:
    if "__interrupt__" in chunk:
        interrupts = chunk["__interrupt__"]
        payload = interrupts[0].value if interrupts else {}
        gate = payload.get("gate", "?") if isinstance(payload, dict) else "?"
        return EventContent(kind="interrupt", node=None, summary=f"awaiting approval: {gate}")
    node, update = next(iter(chunk.items()))
    spent_usd = update.get("spent_usd") if isinstance(update, dict) else None
    return EventContent(
        kind="node", node=node, summary=_summarize_update(node, update or {}), spent_usd=spent_usd
    )
