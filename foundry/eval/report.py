"""Renders foundry/eval's TaskResult sweep into the four small tables SPEC's eval section asks
for (per-task metrics, and one table per named ablation), plus idempotent replacement of the
README's results region between two HTML comment markers — regenerated in place by
`python -m foundry.eval`, never hand-edited.
"""

from __future__ import annotations

from foundry.config import settings
from foundry.eval.harness import TaskResult
from foundry.tools.cost import MODEL_PRICING, usd_for_tokens

BEGIN_MARKER = "<!-- BEGIN EVAL RESULTS -->"
END_MARKER = "<!-- END EVAL RESULTS -->"


def _by_config(results: list[TaskResult], config: str) -> dict[str, TaskResult]:
    return {r.dataset_ref: r for r in results if r.config == config}


def _table(headers: list[str], rows: list[list[str]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return "\n".join(lines)


def _fmt_metric(value: float | None) -> str:
    return f"{value:.4f}" if value is not None else "—"


def render_per_task_table(results: list[TaskResult]) -> str:
    # SPEC: "report final metric, cost, wall time, # invalid experiments caught by red team."
    full = _by_config(results, "full")
    rows = [
        [
            dataset_ref,
            r.primary_metric_name,
            _fmt_metric(r.primary_metric_value),
            f"{r.target_value:.4f}",
            "yes" if r.target_met else "no",
            f"${r.cost_total_usd:.4f}",
            f"{r.wall_time_s:.1f}s",
            str(r.n_invalidated),
            str(r.stop_reason),
        ]
        for dataset_ref, r in full.items()
    ]
    headers = [
        "task", "metric", "value", "target", "target_met", "cost", "wall_time",
        "n_invalidated", "stop_reason",
    ]
    return _table(headers, rows)


def render_red_team_table(results: list[TaskResult]) -> str:
    """SPEC ablation: "red team on/off." full has the audit gate on; no_red_team never routes to
    red_team at all (foundry/teams/principal.py's settings.red_team_enabled check) — the
    headline row is churn_leaky, where n_invalidated should drop to 0 and the reported metric
    should jump to the un-audited, leaky value."""
    full, off = _by_config(results, "full"), _by_config(results, "no_red_team")
    rows = [
        [
            dataset_ref,
            _fmt_metric(full[dataset_ref].primary_metric_value),
            str(full[dataset_ref].n_invalidated),
            _fmt_metric(off[dataset_ref].primary_metric_value),
            str(off[dataset_ref].n_invalidated),
        ]
        for dataset_ref in full
        if dataset_ref in off
    ]
    headers = [
        "task", "full: metric", "full: n_invalidated", "no_red_team: metric",
        "no_red_team: n_invalidated",
    ]
    return _table(headers, rows)


def render_memory_table(results: list[TaskResult]) -> str:
    """SPEC ablation: "memory on/off," rendered as SPEC's own headline demonstration — "run #2
    differing because of run #1's lessons" (tests/test_graph.py's exact framing) — rather than a
    per-run on/off toggle, since the effect is inherently about the difference between two
    consecutive runs sharing a store."""
    run_1, run_2 = _by_config(results, "full"), _by_config(results, "memory_run_2")
    rows = []
    for dataset_ref in run_1:
        if dataset_ref not in run_2:
            continue
        first_1 = run_1[dataset_ref].first_model_family
        first_2 = run_2[dataset_ref].first_model_family
        differs = "yes" if first_1 != first_2 else "no"
        rows.append([dataset_ref, str(first_1), str(first_2), differs])
    return _table(
        ["task", "run #1: first family planned", "run #2: first family planned", "differs"], rows
    )


def render_monolith_table(results: list[TaskResult]) -> str:
    """SPEC ablation: "multi-agent vs single monolithic agent" (foundry/eval/monolith.py)."""
    full, mono = _by_config(results, "full"), _by_config(results, "monolith")
    rows = [
        [
            dataset_ref,
            _fmt_metric(full[dataset_ref].primary_metric_value),
            str(full[dataset_ref].n_invalidated),
            _fmt_metric(mono[dataset_ref].primary_metric_value),
        ]
        for dataset_ref in full
        if dataset_ref in mono
    ]
    return _table(
        [
            "task",
            "hierarchical: metric",
            "hierarchical: n_invalidated",
            "monolith: metric (unaudited)",
        ],
        rows,
    )


def _projected_usd(calls_by_agent: dict[str, int], role_model: dict[str, str]) -> float | None:
    total = 0.0
    for role, n_calls in calls_by_agent.items():
        model = role_model.get(role)
        if model is None or model not in MODEL_PRICING:
            return None  # StubClient path (model="stub") -- no real $/Mtok to project against
        total += n_calls * usd_for_tokens(
            model,
            input_tokens=settings.eval_nominal_input_tokens,
            output_tokens=settings.eval_nominal_output_tokens,
        )
    return round(total, 6)


def render_model_split_table(results: list[TaskResult]) -> str:
    """SPEC ablation: "model-split vs uniform." Offline (no ANTHROPIC_API_KEY), StubClient reports
    no real token usage — every call is priced at one flat rate (foundry/llm.py's MeteredClient),
    so the split and uniform configurations would show a zero cost difference despite making a
    genuinely different number of calls to each role. This table instead projects each
    configuration's REAL per-role call count (foundry/eval/harness.py::calls_by_agent) against
    foundry/tools/cost.py's published $/Mtok table at a fixed nominal token count per call
    (settings.eval_nominal_input_tokens/eval_nominal_output_tokens) -- code-computed from a real
    call pattern, never a measured spend. Labeled "projected" for exactly that reason."""
    split, uniform = _by_config(results, "full"), _by_config(results, "uniform_model")
    split_roles = {
        "principal": settings.principal_model,
        "red_team": settings.red_team_model,
        "worker": settings.worker_model,
    }
    uniform_roles = dict.fromkeys(split_roles, settings.worker_model)

    rows = []
    for dataset_ref in split:
        if dataset_ref not in uniform:
            continue
        split_calls = split[dataset_ref].calls_by_agent
        uniform_calls = uniform[dataset_ref].calls_by_agent
        split_usd = _projected_usd(split_calls, split_roles)
        uniform_usd = _projected_usd(uniform_calls, uniform_roles)
        rows.append(
            [
                dataset_ref,
                str(split_calls.get("principal", 0)),
                str(split_calls.get("red_team", 0)),
                str(split_calls.get("worker", 0)),
                f"${split_usd:.4f}" if split_usd is not None else "n/a (stub)",
                f"${uniform_usd:.4f}" if uniform_usd is not None else "n/a (stub)",
            ]
        )
    return _table(
        [
            "task",
            "principal calls",
            "red_team calls",
            "worker calls",
            "split: projected_usd*",
            "uniform: projected_usd*",
        ],
        rows,
    )


def render_all(results: list[TaskResult]) -> str:
    sections = [
        "### Per-task results",
        "",
        render_per_task_table(results),
        "",
        "### Ablation: red team on/off",
        "",
        render_red_team_table(results),
        "",
        "### Ablation: memory on/off",
        "",
        render_memory_table(results),
        "",
        "### Ablation: multi-agent vs. single monolithic agent",
        "",
        render_monolith_table(results),
        "",
        "### Ablation: model split vs. uniform",
        "",
        render_model_split_table(results),
        "",
        f"\\* projected: real per-role LLM call counts priced at published `$/Mtok` rates "
        f"({sorted(MODEL_PRICING)}) using a fixed nominal token count per call "
        f"({settings.eval_nominal_input_tokens} in / {settings.eval_nominal_output_tokens} out) — "
        "not a measured spend. A real spend difference requires ANTHROPIC_API_KEY set.",
    ]
    return "\n".join(sections)


def write_readme_results(readme_path: str, results: list[TaskResult]) -> None:
    """Idempotent: replaces everything between BEGIN_MARKER/END_MARKER (inclusive of the markers
    themselves) with a freshly rendered region, however many times this is called."""
    with open(readme_path, encoding="utf-8") as f:
        content = f.read()

    start = content.index(BEGIN_MARKER)
    end = content.index(END_MARKER) + len(END_MARKER)
    region = f"{BEGIN_MARKER}\n\n{render_all(results)}\n\n{END_MARKER}"
    new_content = content[:start] + region + content[end:]

    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(new_content)
