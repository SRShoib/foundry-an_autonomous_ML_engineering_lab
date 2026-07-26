# foundry — an autonomous ML engineering lab

A hierarchical multi-agent system on LangGraph. Given a tabular dataset, a one-line goal, and
a budget, a principal agent supervises data, modeling, and red-team subgraphs to produce a
trained model, an experiment report, and a model card. See [SPEC.md](SPEC.md) for the full
architecture and milestone plan; see [CLAUDE.md](CLAUDE.md) for project conventions and
guardrails.

This repo is built one milestone at a time. **Status: M3 (V1 graph) complete.**

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
make test                    # pytest — unit tests always run; @pytest.mark.docker and
                              # @pytest.mark.postgres tests run too if the corresponding
                              # service is available, and skip automatically if not

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
