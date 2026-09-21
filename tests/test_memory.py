"""Tests for foundry/tools/memory.py. Every write/search call also works with no store at all
(run_context() returns None both when no store was compiled in and when called completely outside
any graph invocation) — the same offline-degradable shape foundry/tools/tracker.py already uses
for a missing MLflow server, proven here without needing a graph."""

from __future__ import annotations

from datetime import datetime, timedelta

from langgraph.store.memory import InMemoryStore

from foundry.models import Lesson
from foundry.tools import memory


def _lesson(dataset_ref: str = "churn", **overrides: object) -> Lesson:
    defaults: dict[str, object] = {
        "dataset_ref": dataset_ref,
        "task_type": "binary_classification",
        "text": "gradient_boosting reached roc_auc=0.93",
        "best_model_family": "gradient_boosting",
        "best_metric_name": "roc_auc",
        "best_metric_value": 0.93,
    }
    defaults.update(overrides)
    return Lesson(**defaults)  # type: ignore[arg-type]


def test_run_context_returns_none_outside_any_graph_invocation() -> None:
    """langgraph.config.get_store() raises RuntimeError entirely outside a Pregel run — verified
    against the installed LangGraph 1.2.9 — run_context() must swallow that, not propagate it,
    since every node-level unit test in this codebase calls node functions directly."""
    assert memory.run_context() is None


def test_write_is_a_no_op_with_no_store() -> None:
    memory.write(_lesson())  # must not raise


def test_search_returns_empty_list_with_no_store() -> None:
    assert memory.search("churn") == []


def test_write_then_search_round_trips_through_an_explicit_store() -> None:
    store = InMemoryStore()
    lesson = _lesson()
    memory.write(lesson, store=store)

    results = memory.search("churn", store=store)
    assert len(results) == 1
    assert results[0] == lesson


def test_search_is_scoped_per_dataset_ref() -> None:
    store = InMemoryStore()
    memory.write(_lesson(dataset_ref="churn"), store=store)
    memory.write(_lesson(dataset_ref="churn_leaky"), store=store)

    assert [lesson.dataset_ref for lesson in memory.search("churn", store=store)] == ["churn"]
    assert [lesson.dataset_ref for lesson in memory.search("churn_leaky", store=store)] == [
        "churn_leaky"
    ]
    assert memory.search("some_other_dataset", store=store) == []


def test_search_orders_newest_first_and_respects_the_limit() -> None:
    store = InMemoryStore()
    now = datetime.now()
    oldest = _lesson(text="oldest", created_at=now - timedelta(hours=2))
    middle = _lesson(text="middle", created_at=now - timedelta(hours=1))
    newest = _lesson(text="newest", created_at=now)
    for lesson in (oldest, newest, middle):  # written out of order
        memory.write(lesson, store=store)

    results = memory.search("churn", store=store, limit=2)
    assert [lesson.text for lesson in results] == ["newest", "middle"]


def test_search_skips_malformed_records_instead_of_raising() -> None:
    """A cross-run store may genuinely hold a record an older schema wrote — a real system
    boundary (CLAUDE.md), not defensive padding: memory.search must degrade, never crash a run
    over a stale record."""
    store = InMemoryStore()
    memory.write(_lesson(text="valid"), store=store)
    store.put(("foundry", "lessons", "churn"), "malformed", {"not": "a valid lesson"})

    results = memory.search("churn", store=store)
    assert [lesson.text for lesson in results] == ["valid"]
