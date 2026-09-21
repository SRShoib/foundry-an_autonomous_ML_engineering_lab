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

## M9 — Operator console (frontend)

### Purpose
A real-time control room where a technical operator watches the agent teams (principal,
data, modeling, red team) work a live ML task, and steps in at two decision points:
the budget gate and final sign-off. It should feel like mission-control / flight-deck
software for monitoring concurrent processes, not a generic SaaS admin panel.

### Stack (verify current versions and APIs against official docs before coding)
- React + Vite + TypeScript (strict mode), in /web
- Tailwind CSS with design tokens as CSS variables (no raw hex values in components)
- Motion (motion.dev, formerly Framer Motion) for animation
- TanStack Query for server state
- Radix UI primitives for accessible dialogs/menus, fully restyled (must not look like
  default shadcn/ui)
- Recharts or visx for charts, themed with the tokens
- Live data: Server-Sent Events from FastAPI streaming LangGraph events. Generate
  TypeScript types from FastAPI's OpenAPI schema so the UI can't drift from the API.
- Vite dev proxy to /api; add a `web` service to docker-compose; add `make web`

### Screens
1. Runs home: past runs, and "Start a run" (dataset, goal, budget)
2. Live run view (the core screen): an activity feed with each agent team visually
   distinct, the current phase, a budget meter (spent vs cap), and a live leaderboard
3. Experiment detail drawer: spec, agent-written code, sandbox stdout/stderr, each
   self-debug attempt, metrics, and a link to the MLflow run
4. Approval gates (budget + final sign-off): show exactly what is being approved,
   projected cost, and context. Approve / Reject with confirmation. These must feel like
   deliberate, unhurried decision points, not a generic modal or toast.
5. Red-team finding: a distinct alert, linked to the experiment it invalidated, showing
   the evidence and remediation status. This is the system's core trust signal.
6. Report view: final report + model card as rendered markdown with plots
7. Eval results: the M8 ablation table and charts

### States (every screen)
Skeletons that match the real layout; empty states that tell the user what to do next;
error states that say what failed and how to fix it; a stream-disconnected state with
automatic reconnect.

### Replay mode
Record every run's event stream to JSONL. The UI can replay a recorded run at
1x/4x/16x with zero API calls (zero OpenAI spend). Use it for UI development and demos.
Ship one recorded demo run that includes the red team catching the booby-trapped dataset.

### Design direction
Dark theme primary, light theme supported. Avoid these AI-generated defaults:
- cream + terracotta palettes, or near-black + a single neon accent
- identical rounded cards with the same soft grey shadow everywhere
- gradient washes used as decoration
- ALL-CAPS tracked-out eyebrow labels
- middle-dot-joined meta strings, or → appended to buttons
- numbered markers on content that isn't actually a sequence
Spend boldness in one place. The design plan picks the single memorable moment
(recommended: the red-team intervention); everything else stays quiet and disciplined.

### Motion (purposeful, demo-worthy, never scattered)
- Feed entries arrive smoothly even at high event rates (batch updates; virtualize the list)
- Leaderboard rows reorder with layout animation when rankings change
- Red-team invalidation gets one orchestrated moment: the experiment is visibly flagged
  and the finding emerges linked to it
- Approval gates enter with a deliberate focus shift; confirming shows what changed
- The budget meter and key metrics animate their value changes
- No fade-slide-up on every section, no hover bounce on every card
- prefers-reduced-motion: swap to instant or opacity-only transitions
- Smooth at 60fps with no layout shift

### Quality floor
- WCAG AA contrast; full keyboard navigation; visible focus states
- Live feed announced via a throttled aria-live region
- Responsive down to 375px
- Lighthouse performance and accessibility scores of 90 or higher

### Verification
- Vitest for components and hooks
- Playwright end-to-end on replay mode: start run → feed streams → budget gate appears →
  approve → red-team finding shows → final sign-off → report renders
- Playwright screenshots of every screen (desktop 1440 / mobile 390, dark / light),
  critiqued before declaring done

### Stages (one per session, commit each)
- M9a: design plan only, no code. Save to docs/design-plan.md
- M9b: app shell, tokens, typed API client, SSE hook, replay mode
- M9c: live run view (feed, phase, budget meter, leaderboard)
- M9d: approval gates, red-team finding, experiment drawer
- M9e: runs home, report view, eval results
- M9f: motion + polish pass, e2e tests, screenshot critique

### Definition of done
`make up && make web` serves the console. The replay demo runs end to end with every
motion moment working. The Playwright e2e test passes. Lighthouse targets are met.
The README includes screenshots, a GIF of the red-team catch, and the design rationale.



