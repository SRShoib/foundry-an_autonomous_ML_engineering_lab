"""`python -m foundry.eval` (Makefile: `make eval`) — SPEC M8's "Definition of done": "make eval
prints the metrics + ablation table." Mirrors foundry/cli.py's own shape: installs the
deterministic LLM stub when no ANTHROPIC_API_KEY is set (foundry/llm.py's own switch), runs the
full task/ablation matrix (foundry/eval/ablations.py::run_task_matrix, once per dataset, or just
one dataset's via --task), prints the rendered tables to stdout, and writes the raw TaskResult
list to artifacts/eval/results.json + the results region of README.md in place
(foundry/eval/report.py::write_readme_results) between its BEGIN/END markers.

Writes after EVERY task's matrix, not only once at the end: each task's 5-run matrix is several
real Docker container invocations and can run long — a crash or interruption partway through the
full sweep should still leave the README/results.json reflecting every task that finished, rather
than losing a completed run's real numbers because a later task's run never got to write anything.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from foundry.config import settings
from foundry.datasets import REGISTRY
from foundry.eval.ablations import TASKS, run_task_matrix
from foundry.eval.harness import TaskResult
from foundry.eval.report import render_all, write_readme_results
from foundry.stubs import install_canned_responses

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="foundry.eval", description="Run foundry's eval harness and ablation matrix."
    )
    parser.add_argument(
        "--task", choices=sorted(REGISTRY), default=None, help="run only this dataset's matrix"
    )
    parser.add_argument("--budget", type=float, default=20.0, help="budget in USD per run")
    return parser


def _write_outputs(results: list[TaskResult]) -> None:
    artifacts_dir = _REPO_ROOT / settings.artifacts_dir / "eval"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    results_path = artifacts_dir / "results.json"
    results_path.write_text(
        json.dumps([r.model_dump(mode="json") for r in results], indent=2), encoding="utf-8"
    )
    write_readme_results(str(_REPO_ROOT / "README.md"), results)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not settings.anthropic_api_key:
        install_canned_responses()

    tasks = (args.task,) if args.task is not None else TASKS
    results: list[TaskResult] = []
    for dataset_ref in tasks:
        print(f"=== {dataset_ref} ===")
        results.extend(run_task_matrix(dataset_ref, budget_usd=args.budget))
        _write_outputs(results)
        print(f"({dataset_ref} done; results.json and README.md updated so far)\n")

    print(render_all(results))
    print(f"\nwrote {_REPO_ROOT / settings.artifacts_dir / 'eval' / 'results.json'}")
    print(f"updated {_REPO_ROOT / 'README.md'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
