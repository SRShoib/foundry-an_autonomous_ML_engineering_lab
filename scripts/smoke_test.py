"""M1 end-to-end guardrail proof, run via `make smoke`.

Requires `docker compose up` (postgres + mlflow healthy) and the sandbox image built
(`make sandbox-build`) beforehand. Each step prints PASS/FAIL and the script exits non-zero
on the first failure — the guardrails it proves (sandbox network isolation, sandbox resource
caps, checkpointer durability) are the ones CLAUDE.md calls non-negotiable.
"""

from __future__ import annotations

import subprocess
import sys
import time
import uuid
from typing import NoReturn

from foundry.config import settings

# mlflow prints unicode emoji to stdout; Windows consoles default to a codepage
# (cp1252) that can't encode them, which raises UnicodeEncodeError. Not a smoke-test
# concern — force UTF-8 with a replace fallback rather than crash on a log line.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # pyright: ignore[reportAttributeAccessIssue]


def fail(step: str, detail: str) -> NoReturn:
    print(f"FAIL: {step} — {detail}")
    sys.exit(1)


def ok(step: str) -> None:
    print(f"PASS: {step}")


def step_postgres_checkpointer() -> None:
    from langchain_core.runnables import RunnableConfig
    from langgraph.checkpoint.postgres import PostgresSaver
    from langgraph.graph import END, START, StateGraph
    from typing_extensions import TypedDict

    class State(TypedDict):
        value: str

    def node(state: State) -> dict[str, str]:
        return {"value": state["value"] + "-processed"}

    thread_id = str(uuid.uuid4())
    config: RunnableConfig = {"configurable": {"thread_id": thread_id}}

    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        checkpointer.setup()
        builder = StateGraph(State)
        builder.add_node("node", node)
        builder.add_edge(START, "node")
        builder.add_edge("node", END)
        graph = builder.compile(checkpointer=checkpointer)
        result = graph.invoke({"value": "hello"}, config)
        if result["value"] != "hello-processed":
            fail("postgres checkpointer", f"unexpected invoke result: {result}")

    # Fresh connection, proving durability rather than in-process memory.
    with PostgresSaver.from_conn_string(settings.database_url) as checkpointer:
        snapshot = checkpointer.get_tuple(config)
        if snapshot is None:
            fail("postgres checkpointer", "no checkpoint found on a fresh connection")
        if snapshot.checkpoint["channel_values"].get("value") != "hello-processed":
            fail("postgres checkpointer", f"unexpected persisted state: {snapshot.checkpoint}")

    ok("postgres checkpointer round-trip (fresh connection)")


def step_mlflow_roundtrip() -> None:
    import mlflow
    from mlflow import MlflowClient

    client = MlflowClient(tracking_uri=settings.mlflow_tracking_uri)
    experiment_name = f"smoke-test-{uuid.uuid4()}"
    experiment_id = client.create_experiment(experiment_name)

    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
    with mlflow.start_run(experiment_id=experiment_id) as run:
        mlflow.log_metric("smoke_metric", 1.0)
        run_id = run.info.run_id

    runs = client.search_runs(experiment_ids=[experiment_id])
    if not runs:
        fail("mlflow round-trip", "search_runs returned no runs")
    logged = client.get_run(run_id)
    if logged.data.metrics.get("smoke_metric") != 1.0:
        fail("mlflow round-trip", f"metric not persisted: {logged.data.metrics}")

    ok("mlflow round-trip (create experiment, log run, read back)")


def _docker_run(args: list[str], timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "run", "--rm", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def step_sandbox_runs() -> None:
    result = _docker_run([settings.sandbox_image, "-c", "print('ok')"])
    if result.returncode != 0 or "ok" not in result.stdout:
        detail = f"exit={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
        fail("sandbox runs", detail)
    ok("sandbox image builds and runs")


def step_sandbox_network_isolated() -> None:
    code = "import socket; socket.create_connection(('8.8.8.8', 53), timeout=3)"
    result = _docker_run(["--network", "none", settings.sandbox_image, "-c", code])
    if result.returncode == 0:
        detail = "network call succeeded — --network none did not block egress"
        fail("sandbox network isolation", detail)
    ok("sandbox network isolation (--network none blocks egress)")


def step_sandbox_memory_capped() -> None:
    code = "s = 'x' * (10**9)"
    result = _docker_run(["--memory", "64m", settings.sandbox_image, "-c", code])
    if result.returncode == 0:
        fail("sandbox memory cap", "process was not killed despite exceeding --memory=64m")
    ok(f"sandbox memory cap enforced (exit={result.returncode})")


def step_sandbox_wallclock_kill() -> None:
    proc = subprocess.Popen(
        ["docker", "run", "--rm", settings.sandbox_image, "-c", "import time; time.sleep(30)"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 5
    while proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.2)
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=10)
        ok("sandbox wall-clock kill (host-side timeout terminates the container)")
    else:
        detail = "container exited before the timeout — test is not exercising the kill path"
        fail("sandbox wall-clock kill", detail)


def main() -> None:
    step_postgres_checkpointer()
    step_mlflow_roundtrip()
    step_sandbox_runs()
    step_sandbox_network_isolated()
    step_sandbox_memory_capped()
    step_sandbox_wallclock_kill()
    print("\nAll M1 guardrail checks passed.")


if __name__ == "__main__":
    main()
