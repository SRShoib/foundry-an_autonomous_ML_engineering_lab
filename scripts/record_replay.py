"""Record one real run into a replay file (SPEC M9: "Ship one recorded demo run that includes the
red team catching the booby-trapped dataset"). `make record-replay` writes
web/public/replays/demo-churn-leaky.jsonl, the file the operator console replays with zero API
calls, so UI development and demos never spend budget or need Docker.

It drives the PRODUCTION path — a real RunManager with a real JsonlRecorder, the real graph, and
genuine resume() round trips at every gate — so the artifact is produced by the code under test,
not by a bespoke writer that could drift from what a live run records. It needs a running Docker
daemon and foundry-sandbox:latest (`make sandbox-build`), because experiment code really executes
in the sandbox. With no OPENAI_API_KEY the deterministic stub LLM is used, which costs nothing; the
red team's catch on churn_leaky comes from the code-owned audit floor (foundry/teams/red_team.py's
_apply_floor: audit_leak_auc_threshold / audit_suspicious_metric_ceiling), not from LLM judgement,
so the headline moment is deterministic either way.

The default budget is deliberately small. foundry/gates.py's budget gate pauses when spend plus the
projected cost of the pending experiments would exceed 80% of the budget, and a $20 budget never
trips it — which would leave the recording without the budget gate the console must demonstrate.
Both gates are approved, at once: the recording operator's deliberation is excluded from every
frame offset anyway (app/replay.py), so the replay's own operator does the deliberating live.
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid
from pathlib import Path

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

from app.replay import JsonlRecorder, Replay, fold_frames, replay_from_jsonl
from app.runs import RunManager
from foundry.config import settings
from foundry.datasets import get_dataset
from foundry.graph import build_graph
from foundry.stubs import install_canned_responses

DEFAULT_TASK = "churn_leaky"
DEFAULT_BUDGET_USD = 1.0


def _force_utf8_output() -> None:
    """Same guard as scripts/smoke_test.py, and it matters more here. On Windows a piped or
    redirected stdout defaults to cp1252, and MLflow writes an emoji "View run" line to it when a
    run is terminated: the resulting UnicodeEncodeError makes foundry/tools/tracker.py drop the
    experiment's mlflow_run_id (it must never fail an experiment) — so the recording would ship
    with no MLflow links and nothing would say why."""
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Record a run into a replay JSONL file.")
    parser.add_argument("--task", default=DEFAULT_TASK, help="bundled dataset registry key")
    parser.add_argument("--name", help="replay name (default: demo-<task>)")
    parser.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD)
    parser.add_argument("--out-dir", type=Path, default=None, help="default: replay_demo_dir")
    parser.add_argument("--timeout-s", type=float, default=1800.0)
    parser.add_argument("--poll-s", type=float, default=0.25)
    return parser


def record(
    *,
    task: str,
    name: str,
    budget_usd: float,
    out_dir: Path,
    timeout_s: float = 1800.0,
    poll_s: float = 0.25,
) -> Replay:
    dataset = get_dataset(task)  # KeyError names the valid registry keys
    if not settings.openai_api_key:
        install_canned_responses()

    recorder = JsonlRecorder(out_dir, name=name)
    manager = RunManager(build_graph(InMemorySaver(), InMemoryStore()), recorder)
    thread_id = str(uuid.uuid4())
    manager.start(
        thread_id=thread_id,
        goal=f"predict {dataset.target_column}",
        dataset_ref=task,
        budget_usd=budget_usd,
    )

    deadline = time.monotonic() + timeout_s
    while True:
        status = manager.status(thread_id)
        if status.status == "awaiting_approval":
            gate = status.pending_approval.gate if status.pending_approval else "?"
            manager.resume(
                thread_id, {"approved": True, "note": f"approved while recording ({gate} gate)"}
            )
        elif status.status == "failed":
            raise RuntimeError(f"run failed while recording: {status.error}")
        elif status.status == "completed":
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"run did not finish within {timeout_s:.0f}s")
        time.sleep(poll_s)

    # The recorder closes the file before the run reports completed (app/runs.py settles the
    # recording before handle.finish()), so the finished file can be read straight back.
    replay = replay_from_jsonl(
        (out_dir / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
    )
    if replay.header.final_status is None:
        raise RuntimeError(f"{name}.jsonl was not closed; the recording is incomplete")
    return replay


def describe(replay: Replay, path: Path) -> str:
    header = replay.header
    last = fold_frames(replay.frames)[-1]
    caught = [f for f in last.invalidations if f.verdict == "invalidated"]
    linked = sum(1 for e in last.experiments if e.mlflow_run_id)
    gates = ", ".join(
        f"{d.gate}={'approved' if d.approved else 'rejected'}" for d in header.decisions
    )
    lines = [
        f"recorded {path}",
        f"  frames        {header.n_frames} over {header.duration_s:.1f}s of agent time",
        f"  gates         {gates or 'none reached'}",
        f"  experiments   {len(last.experiments)}",
        f"  mlflow ids    {linked}/{len(last.experiments)}",
        f"  red team      {len(last.invalidations)} audited, {len(caught)} invalidated",
        f"  spend         ${last.spent_usd:.4f} of ${last.budget_usd:.2f}",
    ]
    for finding in caught:
        lines.append(f"  caught        {finding.experiment_id}: {finding.category}")
    if linked < len(last.experiments):
        lines.append(
            "  warning       some experiments have no MLflow run id, so the console cannot link "
            "them; is MLflow up (`make up`)?"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    _force_utf8_output()
    args = build_parser().parse_args(argv)
    out_dir: Path = args.out_dir or settings.replay_demo_dir
    name: str = args.name or f"demo-{args.task.replace('_', '-')}"
    try:
        replay = record(
            task=args.task,
            name=name,
            budget_usd=args.budget_usd,
            out_dir=out_dir,
            timeout_s=args.timeout_s,
            poll_s=args.poll_s,
        )
    except (KeyError, RuntimeError, TimeoutError) as exc:
        print(f"record_replay: {exc}", file=sys.stderr)
        return 1
    print(describe(replay, out_dir / f"{name}.jsonl"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
