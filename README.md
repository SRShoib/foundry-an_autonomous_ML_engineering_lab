# foundry — an autonomous ML engineering lab

A hierarchical multi-agent system on LangGraph. Given a tabular dataset, a one-line goal, and
a budget, a principal agent supervises data, modeling, and red-team subgraphs to produce a
trained model, an experiment report, and a model card. See [SPEC.md](SPEC.md) for the full
architecture and milestone plan; see [CLAUDE.md](CLAUDE.md) for project conventions and
guardrails.

This repo is built one milestone at a time. **Status: M2 (foundations) complete.**

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
make test                    # pytest — unit tests always run; @pytest.mark.docker tests
                              # (real sandbox isolation checks) run too if Docker + the
                              # sandbox image are available, and skip automatically if not

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
  LLM-authored (plans, findings, profiles) and code-authored (`ExperimentResult`, sandbox
  output) groups — the stub's canned-response registry only covers the former, so wiring an
  LLM to produce a metric fails loudly instead of silently.
