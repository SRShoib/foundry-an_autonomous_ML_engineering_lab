"""SPEC's definition of done: `make up && make run TASK=churn`. Selects a checkpointer
(Postgres for real runs — SPEC M3: "Postgres checkpointing on"; in-memory via
`--checkpointer memory` for quick offline demos), installs the deterministic LLM stub when no
ANTHROPIC_API_KEY is set (mirroring foundry/llm.py::get_llm's own switch, done once here rather
than inside get_llm to keep fixtures out of the library's hot path — see foundry/stubs.py), runs
the graph to completion, and writes the report/model card to
settings.artifacts_dir/<thread_id>/.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from collections.abc import Sequence
from contextlib import nullcontext
from typing import cast

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres import PostgresSaver

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
    return parser


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

    with checkpointer_cm as checkpointer:
        if isinstance(checkpointer, PostgresSaver):
            checkpointer.setup()
        graph = build_graph(checkpointer)

        if args.show_thread_id is not None:
            snapshot = graph.get_state({"configurable": {"thread_id": args.show_thread_id}})
            report = snapshot.values.get("report_md") if snapshot.values else None
            if not report:
                print(f"no persisted report for thread {args.show_thread_id!r}", file=sys.stderr)
                return 1
            print(report)
            return 0

        if not settings.anthropic_api_key:
            install_canned_responses()

        dataset = get_dataset(args.task)
        goal = args.goal or f"predict {dataset.target_column}"
        thread_id = args.thread_id or str(uuid.uuid4())

        state = initial_state(goal=goal, dataset_ref=args.task, budget_usd=args.budget)
        final_state = cast(FoundryState, graph.invoke(state, run_config(thread_id)))

        _write_artifacts(thread_id, final_state)
        print(f"thread_id: {thread_id}")
        print(f"stop_reason: {final_state['stop_reason']}")
        print()
        print(final_state["report_md"])
        return 0


if __name__ == "__main__":
    sys.exit(main())
