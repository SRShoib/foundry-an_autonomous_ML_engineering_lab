"""SPEC's definition of done: `make up && make run TASK=churn`. Selects a checkpointer
(Postgres for real runs — SPEC M3: "Postgres checkpointing on"; in-memory via
`--checkpointer memory` for quick offline demos), installs the deterministic LLM stub when no
OPENAI_API_KEY is set (mirroring foundry/llm.py::get_llm's own switch, done once here rather
than inside get_llm to keep fixtures out of the library's hot path — see foundry/stubs.py), runs
the graph to completion, and writes the report/model card to
settings.artifacts_dir/<thread_id>/.

M6: the graph now has two real interrupt() gates (foundry/gates.py) — the CLI answers them, it
never skips them. By default it prompts on stdin (the interrupt genuinely fires, checkpoints, and
records a HumanDecision either way); `--auto-approve` answers every gate with approve
non-interactively, for CI/demos, still through the same real interrupt/resume round trip. If
stdin isn't a TTY and --auto-approve wasn't passed, the run is left paused at a durable
checkpoint — SPEC's "expensive runs pause for approval and resume via the API" is exactly this
case, so the CLI reports the thread id and how to resume it via app/main.py rather than guessing
an answer.

M7: a LangGraph Store is opened alongside the checkpointer, same --checkpointer switch (Postgres
for real runs, InMemoryStore for --checkpointer memory) — mirroring foundry/graph.py's own
store=None default, `make run TASK=churn` twice in a row against Postgres is exactly SPEC's
"demonstrate run #2 differing because of run #1's lessons" demo, no test harness required.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from collections.abc import Sequence
from contextlib import nullcontext
from typing import Any, cast

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.memory import InMemoryStore
from langgraph.store.postgres import PostgresStore
from langgraph.types import Command

from foundry.config import settings
from foundry.datasets import REGISTRY, get_dataset
from foundry.graph import build_graph, initial_state, run_config
from foundry.state import FoundryState
from foundry.stubs import install_canned_responses

# Report/model-card markdown uses em dashes; Windows consoles default to a codepage (cp1252)
# that can't encode them (same issue scripts/smoke_test.py works around for mlflow's output).
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="foundry", description="Run the foundry ML engineering lab end-to-end."
    )
    parser.add_argument("--task", choices=sorted(REGISTRY), help="bundled dataset registry key")
    parser.add_argument("--goal", default=None, help="default: 'predict <target_column>'")
    parser.add_argument("--budget", type=float, default=20.0, help="budget in USD")
    parser.add_argument("--checkpointer", choices=["postgres", "memory"], default="postgres")
    parser.add_argument("--thread-id", dest="thread_id", default=None, help="reuse this thread id")
    parser.add_argument(
        "--show",
        dest="show_thread_id",
        default=None,
        metavar="THREAD_ID",
        help="print the persisted report for this thread instead of running",
    )
    parser.add_argument(
        "--auto-approve",
        action="store_true",
        help="answer every approval gate with approve, non-interactively (CI/demos)",
    )
    return parser


def _format_approval_request(payload: dict[str, Any]) -> str:
    lines = [f"=== APPROVAL REQUIRED: {payload.get('gate')} ===", str(payload.get("reason", ""))]
    lines.append(
        f"Spent: ${payload.get('spent_usd', 0.0):.2f} / ${payload.get('budget_usd', 0.0):.2f} "
        "budget"
    )
    if payload.get("gate") == "final":
        if payload.get("best_experiment_id"):
            lines.append(
                f"Winning: {payload['best_experiment_id']}  "
                f"{payload.get('best_metric_name')} {payload.get('best_metric_value'):.4f}"
            )
        else:
            lines.append("Winning: none (no cleared experiment survived)")
        lines.append(f"Red team invalidated: {payload.get('n_invalidated', 0)}")
    return "\n".join(lines)


def _decide(payload: dict[str, Any], *, auto_approve: bool) -> dict[str, Any] | None:
    """None means "leave it paused" — either --auto-approve wasn't passed and stdin isn't a TTY
    to prompt on, or the prompt hit EOF. Never invents an answer; the checkpoint stays resumable
    via the API either way (SPEC: "expensive runs pause for approval and resume via the API")."""
    print()
    print(_format_approval_request(payload))
    if auto_approve:
        print("--auto-approve: approving")
        return {"approved": True, "note": "auto-approved via --auto-approve"}
    if not sys.stdin.isatty():
        return None
    try:
        answer = input("Approve? [y/N]: ").strip().lower()
    except EOFError:
        return None
    return {"approved": answer == "y", "note": ""}


def _write_artifacts(thread_id: str, state: FoundryState) -> None:
    out_dir = settings.artifacts_dir / thread_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_md = state.get("report_md")
    if report_md:
        (out_dir / "report.md").write_text(report_md, encoding="utf-8")
    model_card_md = state.get("model_card_md")
    if model_card_md:
        (out_dir / "model_card.md").write_text(model_card_md, encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # Validate before ever opening a checkpointer connection — the default checkpointer is
    # Postgres, and a plain usage error shouldn't require a live database to report.
    if args.show_thread_id is None and args.task is None:
        print("error: --task is required (or use --show THREAD_ID)", file=sys.stderr)
        return 2

    checkpointer_cm = (
        PostgresSaver.from_conn_string(settings.database_url)
        if args.checkpointer == "postgres"
        else nullcontext(InMemorySaver())
    )
    store_cm = (
        PostgresStore.from_conn_string(settings.database_url)
        if args.checkpointer == "postgres"
        else nullcontext(InMemoryStore())
    )

    with checkpointer_cm as checkpointer, store_cm as store:
        if isinstance(checkpointer, PostgresSaver):
            checkpointer.setup()
        if isinstance(store, PostgresStore):
            store.setup()
        graph = build_graph(checkpointer, store)

        if args.show_thread_id is not None:
            snapshot = graph.get_state({"configurable": {"thread_id": args.show_thread_id}})
            report = snapshot.values.get("report_md") if snapshot.values else None
            if not report:
                print(f"no persisted report for thread {args.show_thread_id!r}", file=sys.stderr)
                return 1
            print(report)
            return 0

        if not settings.openai_api_key:
            install_canned_responses()

        dataset = get_dataset(args.task)
        goal = args.goal or f"predict {dataset.target_column}"
        thread_id = args.thread_id or str(uuid.uuid4())

        state = initial_state(goal=goal, dataset_ref=args.task, budget_usd=args.budget)
        graph_input: FoundryState | Command = state
        config = run_config(thread_id)

        while True:
            result = cast("dict[str, Any]", graph.invoke(graph_input, config))
            interrupts = result.get("__interrupt__")
            if not interrupts:
                break
            decision = _decide(interrupts[0].value, auto_approve=args.auto_approve)
            if decision is None:
                print()
                print(f"thread_id: {thread_id}")
                print(f"PAUSED at gate: {interrupts[0].value.get('gate')}")
                print("Resume via the API, e.g.:")
                print(f'  POST /runs/{thread_id}/resume {{"approved": true}}')
                return 2
            graph_input = Command(resume=decision)

        final_state = cast(FoundryState, result)
        _write_artifacts(thread_id, final_state)
        print(f"thread_id: {thread_id}")
        print(f"stop_reason: {final_state['stop_reason']}")
        print()
        print(final_state["report_md"])
        return 0


if __name__ == "__main__":
    sys.exit(main())
