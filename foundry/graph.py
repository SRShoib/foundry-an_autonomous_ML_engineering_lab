"""Graph assembly (SPEC M3: "V1 graph... Postgres checkpointing on"). Every team node routes
via Command(goto=...) — including back to `principal` — so the only STATIC edges this graph
needs are START -> principal, reporter -> final_gate -> END (M6), and (M4)
experiment_runner -> principal; everything else is dynamic routing, validated at compile time by
each node's Command[Literal[...]] return annotation (verified against the installed LangGraph
1.2.9 source: a typo'd goto target raises at .compile(), it is not a silent failure).

experiment_runner gets the one static edge because M4 reaches it only via Send fan-out from
foundry/teams/principal.py — a node reached solely by Send has no incoming edge to declare, but
its own always-the-same destination is exactly foundry/teams/reporter.py's situation ("a single,
static destination"), so it returns a plain dict rather than a self-directed Command (verified:
a Send-only-reached node with a plain-dict return and a static outgoing add_edge behaves
identically to one that returns Command(goto=...)).

recursion_limit defaults to 10007 in LangGraph 1.2.9 — effectively unbounded — so run_config
sets a real cap; a routing bug then fails fast with GraphRecursionError instead of running for
minutes.

build_graph also allowlists foundry.models' types with the checkpointer's msgpack serde.
LangGraph's default is permissive for unregistered external types (a warning, not an error) but
says so explicitly will change in a future release (see
langgraph.checkpoint.serde.jsonplus.JsonPlusSerializer's docstring) — every FoundryState field
typed as a foundry.models class would otherwise start failing to deserialize on that upgrade.
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from foundry.config import settings
from foundry.gates import final_gate
from foundry.state import FoundryState
from foundry.teams.data_team import data_team_node
from foundry.teams.experiment_runner import experiment_runner
from foundry.teams.modeling_team import experiment_planner
from foundry.teams.principal import principal
from foundry.teams.red_team import red_team_node
from foundry.teams.reporter import reporter

# Every foundry.models type that a FoundryState field holds directly (or in a list) and that
# therefore passes through the checkpointer's msgpack serde.
ALLOWED_MSGPACK_MODULES: tuple[tuple[str, str], ...] = (
    ("foundry.models", "DataProfile"),
    ("foundry.models", "LeakageFinding"),
    ("foundry.models", "CleaningPlan"),
    ("foundry.models", "CVStrategy"),
    ("foundry.models", "ExperimentSpec"),
    ("foundry.models", "ExperimentResult"),
    ("foundry.models", "LeaderboardEntry"),
    ("foundry.models", "CostEntry"),
    ("foundry.models", "RedTeamFinding"),
    ("foundry.models", "HumanDecision"),
)


def configure_serde(checkpointer: BaseCheckpointSaver) -> BaseCheckpointSaver:
    checkpointer.serde = JsonPlusSerializer(allowed_msgpack_modules=ALLOWED_MSGPACK_MODULES)
    return checkpointer


def build_graph(checkpointer: BaseCheckpointSaver | None = None) -> CompiledStateGraph:
    if checkpointer is not None:
        configure_serde(checkpointer)

    builder = StateGraph(FoundryState)
    builder.add_node("principal", principal)
    builder.add_node("data_team", data_team_node)
    builder.add_node("experiment_planner", experiment_planner)
    # experiment_runner is reached only via Send (foundry/teams/principal.py's fan-out) with a
    # RunnerInput payload, never pulled with the full FoundryState — narrower than add_node's
    # declared signature expects, but exactly LangGraph's documented map-reduce pattern.
    builder.add_node("experiment_runner", experiment_runner)  # pyright: ignore[reportArgumentType]
    builder.add_node("red_team", red_team_node)
    builder.add_node("reporter", reporter)
    # M6: a real interrupt() gate between reporter and END (SPEC: "sign-off on the winning model
    # + report before finalize") — a plain add_edge here, mirroring reporter's own "a single,
    # static destination" wiring, since final_gate always goes to END regardless of the human's
    # decision (see foundry/gates.py's module docstring for why the decline case doesn't loop).
    builder.add_node("final_gate", final_gate)

    builder.add_edge(START, "principal")
    builder.add_edge("experiment_runner", "principal")
    builder.add_edge("reporter", "final_gate")
    builder.add_edge("final_gate", END)

    return builder.compile(checkpointer=checkpointer)


def initial_state(*, goal: str, dataset_ref: str, budget_usd: float) -> FoundryState:
    return {
        "goal": goal,
        "dataset_ref": dataset_ref,
        "budget_usd": budget_usd,
        "spent_usd": 0.0,
        "data_profile": None,
        "leakage_findings": [],
        "cleaning_plan": None,
        "cv_strategy": None,
        "experiment_plan": [],
        "experiments": [],
        "leaderboard": [],
        "invalidations": [],
        "audited_experiments": [],
        "costs": [],
        "lessons": [],
        "report_md": None,
        "model_card_md": None,
        "human_decisions": [],
        "errors": [],
        "iteration_count": 0,
        "next_team": None,
        "stop_reason": None,
    }


def run_config(thread_id: str) -> RunnableConfig:
    return {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": settings.graph_recursion_limit,
        # Bounds how many Send-fanned-out experiment_runner branches (each a real docker
        # container) LangGraph's BackgroundExecutor runs concurrently in one superstep —
        # verified against langchain_core.runnables.config.get_executor_for_config, which reads
        # this key straight into ThreadPoolExecutor(max_workers=...).
        "max_concurrency": settings.graph_max_concurrency,
    }
