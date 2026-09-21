# foundry — an autonomous ML engineering lab

A hierarchical multi-agent system on LangGraph. Given a tabular dataset, a one-line goal, and
a budget, a principal agent supervises data, modeling, and red-team subgraphs to produce a
trained model, an experiment report, and a model card. See [SPEC.md](SPEC.md) for the full
architecture and milestone plan; see [CLAUDE.md](CLAUDE.md) for project conventions and
guardrails.

This repo is built one milestone at a time. **Status: M4 (scale-out) complete.**

## Requirements

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Docker + Docker Compose

## Getting started

```sh
cp .env.example .env         # adjust if needed — defaults work out of the box
uv sync

make sandbox-build           # builds the foundry-sandbox image
make up                      # starts postgres + mlflow, waits for healthy
make smoke                   # proves the guardrails: sandbox isolation, checkpointer
                              # durability, mlflow round-trip

make lint                    # ruff
make typecheck                # pyright
make test                    # pytest — unit tests always run; @pytest.mark.docker,
                              # @pytest.mark.postgres, and @pytest.mark.mlflow tests run too
                              # if the corresponding service is available, and skip
                              # automatically if not

make run TASK=churn          # runs the V1 graph end-to-end on the bundled churn dataset;
                              # writes artifacts/<thread_id>/{report.md,model_card.md}

make down                    # stop postgres + mlflow
```

MLflow UI: http://localhost:5000

## Why these design decisions

(Expanded as later milestones land — see the M8 definition of done in SPEC.md.)

- **Sandbox-only execution**: agent-written code never runs on the host. Every run goes
  through a purpose-built Docker image with no network access and enforced CPU/memory/time
  caps — verified end-to-end by `make smoke`, not just declared in a config file.
- **Postgres, not SQLite, for both the checkpointer and MLflow**: one server, two databases,
  matching how this would actually be deployed, and giving the LangGraph checkpointer real
  durability across process restarts from day one.
- **The graph must run with no API keys**: `foundry/llm.py` swaps in a deterministic stub
  whenever `ANTHROPIC_API_KEY` is unset, so the graph and its tests are never gated on a live
  model or network access.
- **Metrics are never estimated by an LLM**: `foundry/models.py` splits structured types into
  LLM-authored (plans, findings, assessments) and code-authored (`DataProfile`,
  `ExperimentResult`, sandbox output) groups — the stub's canned-response registry only covers
  the former, so wiring an LLM to produce a metric fails loudly instead of silently. The
  experiment runner's only LLM-authored output is a code string (`TrainingCode`); metrics are
  parsed from the sandbox's stdout by `foundry/tools/metrics.py`, a pure function with no model
  in the loop.
- **The experiment runner is a hand-rolled self-debug loop, not `langgraph.prebuilt.
  create_react_agent`**: that prebuilt requires a real tool-calling chat model, which the
  offline stub cannot provide without breaking the "no API keys" guarantee — and more
  importantly, it would let metrics reach `ExperimentResult` through the model's narrated final
  answer rather than a pure parse of sandbox output. The hand-rolled version is still reason →
  act → observe (write code → run in the sandbox → feed the traceback back), just with an
  explicit, countable `for attempt in range(self_debug_max_attempts)` instead of an emergent
  property of a recursion limit.
- **The principal's hard stops are code, its judgment is an LLM call**: iteration/budget/target
  caps are checked before the LLM is ever consulted, and `PrincipalDirective`'s `stop_reason`
  type deliberately excludes `budget_exhausted`/`max_iterations` — a model can never talk its
  way past a cap it isn't allowed to reason about.
- **Send fan-out, not a modeling_team subgraph**: M4 parallelizes experiments by having
  `foundry/teams/principal.py` return `Command(goto=[Send("experiment_runner", ...), ...])` for
  every pending `ExperimentSpec` in the current planning batch, rather than restructuring
  `modeling_team` into a subgraph — principal is already the graph's single routing authority,
  so it is also the natural place to decide how many experiments run in parallel.
  `experiment_runner` reads a small `RunnerInput` payload (LangGraph's map-reduce pattern), not
  the full state, and there is no more "no pending spec" case to guard against: Send always
  names exactly the one spec each branch runs.
- **spent_usd is derived, never incrementally written, under parallelism**: Send-fanned-out
  `experiment_runner` branches genuinely execute on separate threads (verified against
  LangGraph 1.2.9's `BackgroundExecutor`), so each one appends its own `CostEntry` items to
  `state["costs"]` (an add-reducer — safe under concurrent writes) instead of writing
  `spent_usd` directly, which would race and silently lose cost. `principal` is the sole writer
  of `spent_usd`, recomputing it from `state["costs"]` every turn; `reporter` tops it up exactly
  once more after the loop ends, folding in its own not-yet-merged LLM cost, which is safe
  because reporter always runs alone.
- **Per-agent cost is priced by real token usage, not a flat rate**: `foundry/llm.py`'s
  `MeteredClient` reads `AIMessage.usage_metadata` off the real Anthropic response and prices it
  against `foundry/tools/cost.py`'s per-model $/token table, so the model split (cheap
  `worker`/haiku vs. strong `principal`/`red_team`/opus) actually shows up as different costs in
  the report's cost-by-agent breakdown — a single flat per-call rate couldn't demonstrate the
  split doing anything. `StubClient` calls (no API key) are priced at the old flat rate, since
  there's no real token usage to read.
- **MLflow logging is host-side and best-effort**: `foundry/tools/tracker.py` logs each
  experiment via `MlflowClient`'s explicit `create_run`/`log_*`/`set_terminated` calls, never
  the fluent `mlflow.start_run()` API, because that relies on one global "active run" that
  concurrent Send branches would race on. Logging happens strictly after `sandbox.run` returns
  — CLAUDE.md's sandbox guardrail runs training code with no network, so nothing inside the
  container could reach a tracking server anyway — and a tracking failure is caught and
  recorded as an error, never allowed to fail an otherwise-successful experiment.
