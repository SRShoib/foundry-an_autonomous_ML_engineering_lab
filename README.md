# foundry — an autonomous ML engineering lab

A hierarchical multi-agent system on LangGraph. Given a tabular dataset, a one-line goal, and
a budget, a principal agent supervises data, modeling, and red-team subgraphs to produce a
trained model, an experiment report, and a model card. See [SPEC.md](SPEC.md) for the full
architecture and milestone plan; see [CLAUDE.md](CLAUDE.md) for project conventions and
guardrails.

This repo is built one milestone at a time. **Status: M1 (scaffold) complete.**

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
make test                    # pytest (fast, no docker required)

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
