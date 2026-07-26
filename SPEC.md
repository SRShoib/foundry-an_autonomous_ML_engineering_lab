# SPEC — foundry: an autonomous ML engineering lab

## What this is
A hierarchical multi-agent system on LangGraph. Input: a tabular dataset (CSV) + a one-line
goal (e.g. "predict churn") + a budget. Output: a trained model, a reproducible experiment
report, and a model card. A principal agent supervises three team subgraphs (data, modeling,
red team) that share tools: a sandboxed code executor, an MLflow experiment tracker, a
cross-run memory store, and web search. Humans approve expensive runs and the final result.

## Stack (verify current APIs against official docs before coding — LangGraph 1.x changed
## import paths and the interrupt/Command API; don't trust memory)
- Python 3.11+, LangGraph 1.x, LangChain core, Pydantic v2
- Postgres checkpointer (durable execution, pause/resume, time-travel)
- MLflow (local, via docker-compose) for experiment tracking
- LangGraph persistent Store for cross-run memory
- Docker sandbox for ALL agent-written code: CPU/mem/time limits, NO network, mounted
  read-only data dir + writable scratch dir. Agent code never runs on the host.
- LangSmith tracing; FastAPI (start run, stream events, list pending approvals, resume)
- pytest, ruff, pyright, uv; docker-compose; .env.example; never hardcode secrets

## Architecture
State (TypedDict; reducers where branches run in parallel; Literal fields for routing):
- goal, dataset_ref (path/key only — raw data stays OUT of state), budget_usd, spent_usd
- data_profile, leakage_findings, cv_strategy
- experiment_plan: list[ExperimentSpec]
- experiments: Annotated[list[ExperimentResult], add]   # Send branches concatenate
- leaderboard (best runs), invalidations: list[RedTeamFinding]
- lessons: list[str] (distilled, written to Store at end of run)
- report_md, model_card_md, human_decisions, errors (add-reducer), iteration_count

Teams (each a SUBGRAPH with its own private state, mapped keys to parent):
1. principal — supervisor. Decomposes goal, allocates budget, routes handoffs via Command,
   loops teams, stops on: target metric hit, budget exhausted, or diminishing returns.
2. data_team — profiler (stats/schema/target-leakage scan) → cleaner → splitter (defensible
   CV strategy, stratification, no temporal leakage).
3. modeling_team — literature scout (web search + memory store → approach memos) →
   experiment planner (N ExperimentSpecs) → Send fan-out of experiment runners. Each runner
   is a ReAct agent with the sandbox tool: writes training code, executes, reads traceback,
   self-debugs (max k=3 attempts), logs params/metrics/artifacts to MLflow.
4. red_team — adversarial auditor of every leaderboard candidate: data leakage, train/test
   contamination, improper CV, validation overfitting, seed-hacking. Can mark an experiment
   INVALIDATED with a written finding; principal must route remediation or drop it.
5. reporter — experiment report + model card with plots, citing MLflow run IDs.

Human gates (real interrupt() backed by the checkpointer):
- budget gate: any single run projected > $X or total spend > 80% of budget pauses for approval
- final gate: sign-off on the winning model + report before finalize

## Tools (each a typed, tested module)
sandbox.run(code, files, limits) -> {stdout, stderr, artifacts, duration, exit}
tracker.log_run(...) / tracker.query_runs(...)
memory.search(query) / memory.write(lesson)        # LangGraph Store, cross-thread
web_search(query)                                   # literature scout only
cost_meter.check() -> spent vs cap                  # consulted before every LLM/sandbox call

## Non-negotiable guards
- Sandbox: no network, resource caps, host isolation. Enforced, not advisory.
- Hard per-run cost cap; principal loop max iterations; runner self-debug max k=3.
- Every structured LLM output = Pydantic model, validated, retry-on-parse-failure.
- Metrics computed deterministically by code in the sandbox, never free-form by an LLM.
- Cheap model for workers/runners; strong model ONLY for principal + red team. Make the
  model split configurable and log per-agent cost.

## Evaluation (first-class deliverable)
- Ship 3 small bundled tabular tasks (data + ground truth) so the repo runs offline.
- Harness: run the lab end-to-end per task; report final metric, cost, wall time, # invalid
  experiments caught by red team.
- Ablation scripts: red team on/off; memory on/off; multi-agent vs single monolithic agent;
  model-split vs uniform. Emit a README results table.
- Stretch: adapter to run MLE-bench Lite tasks and report percentile/medal + cost per task.

## Layout
foundry/{state.py, models.py, llm.py, tools/{sandbox.py, tracker.py, memory.py, search.py,
cost.py}, teams/{principal.py, data_team.py, modeling_team.py, red_team.py, reporter.py},
graph.py, eval/}; app/ (FastAPI); tests/; data/samples/; docker/; docker-compose.yml;
Makefile; README.md; .env.example

## Milestones (one at a time; verify + commit each; V1 = M1–M3 is already demo-able)
M1 scaffold: repo, uv, ruff+pyright, docker-compose (postgres, mlflow), sandbox image,
   Makefile, .env.example, smoke test.
M2 foundations: state + Pydantic models, LLM interface with a deterministic stub (graph
   runs with NO api keys), sandbox tool with enforced limits + tests proving isolation.
M3 V1 graph: principal + data_team + ONE experiment runner (ReAct self-debug) end-to-end
   on a sample CSV → trained model + basic report. Postgres checkpointing on.
M4 scale-out: MLflow tool, Send parallel runners, leaderboard, per-agent cost logging.
M5 red team: subgraph + invalidation authority + principal remediation routing + tests
   (include a booby-trapped leaky dataset it must catch).
M6 control: budget + final interrupt() gates, FastAPI endpoints, streamed activity feed.
M7 memory: Store-backed lessons written at run end, consulted by the literature scout;
   demonstrate run #2 differing because of run #1's lessons.
M8 eval: harness + ablations + README results table + design-decision writeup.

## Definition of done
`make up && make run TASK=churn` completes V1+; expensive runs pause for approval and
resume via the API; red team demonstrably catches the booby-trapped dataset; `make eval`
prints the metrics + ablation table; lint/types/tests pass; README explains key design
decisions (why hierarchical, why the red team, why the model split, why sandbox-only
execution) — reviewers read this file first.