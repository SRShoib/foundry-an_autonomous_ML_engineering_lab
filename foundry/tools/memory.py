"""Cross-thread lesson memory (SPEC: "memory.search(query) / memory.write(lesson) # LangGraph
Store, cross-thread"). Backs foundry/teams/lessons.py's lesson_writer (write, at run end) and
foundry/teams/modeling_team.py's literature scout (search, before planning).

Namespaced ("foundry", "lessons", dataset_ref) — cross-THREAD as SPEC requires (any run on the
same dataset sees every prior run's lessons, regardless of thread_id), but scoped per dataset so
churn_leaky's booby-trapped findings never bleed into churn's plan.

search() is deliberately never passed query=: verified against the installed LangGraph 1.2.9 that
a store with no embedding index configured does NOT raise on store.search(ns, query=...) — it
silently returns unranked results with score=None, which would look like semantic search while
doing nothing. Retrieval here is namespace-prefix plus explicit sort by Lesson.created_at instead,
so "most relevant" never quietly means "insertion order." That sort happens entirely in Python,
AFTER fetching: store.search()'s own `limit` truncates BEFORE any ordering is applied and is not
guaranteed to return newest-first, so passing the caller's cap straight through as the store-level
limit could silently drop the newest records instead of the oldest ones. search() therefore fetches
up to _FETCH_LIMIT items from the store, sorts them in Python, and only then slices to the caller's
cap.

run_context() is the one place that calls langgraph.config.get_store() — it returns None rather
than raising both when no store was compiled in (foundry/graph.py's build_graph(store=None), which
is also M8's memory on/off ablation switch) and when called completely outside any graph
invocation (get_store() itself raises RuntimeError there — every node-level unit test in this
codebase calls node functions directly, never through a compiled graph). Every caller in this
module treats "no store" as "no memory available," the same offline-degradable shape
foundry/tools/tracker.py already uses for a missing MLflow server."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from langgraph.config import get_store

from foundry.config import settings
from foundry.models import Lesson

if TYPE_CHECKING:
    from langgraph.store.base import BaseStore

_NAMESPACE_ROOT = "foundry"
_NAMESPACE_KIND = "lessons"
# Generously above any realistic per-dataset lesson count (one per completed run) — large enough
# that the Python-side sort below always sees every record in the namespace, never a store-level
# truncated subset.
_FETCH_LIMIT = 1000


def _namespace(dataset_ref: str) -> tuple[str, str, str]:
    return (_NAMESPACE_ROOT, _NAMESPACE_KIND, dataset_ref)


def run_context() -> BaseStore | None:
    try:
        return get_store()
    except RuntimeError:
        return None


def write(lesson: Lesson, *, store: BaseStore | None = None) -> None:
    """No-op when no store is available (see module docstring) — writing a lesson is
    observability for future runs, never load-bearing for the current one."""
    target = store if store is not None else run_context()
    if target is None:
        return
    key = f"{lesson.created_at.isoformat()}-{uuid.uuid4().hex[:8]}"
    target.put(_namespace(lesson.dataset_ref), key, lesson.model_dump(mode="json"))


def search(
    dataset_ref: str, *, store: BaseStore | None = None, limit: int | None = None
) -> list[Lesson]:
    """Every lesson recorded for dataset_ref, newest first. Returns [] when no store is
    available, or when every record in the namespace fails Lesson.model_validate (a cross-run
    store may genuinely hold a record an older schema wrote — a real system boundary, not
    defensive padding: malformed records are skipped, never allowed to raise)."""
    target = store if store is not None else run_context()
    if target is None:
        return []
    cap = limit if limit is not None else settings.memory_max_lessons
    items = target.search(_namespace(dataset_ref), limit=_FETCH_LIMIT)

    lessons: list[Lesson] = []
    for item in items:
        try:
            lessons.append(Lesson.model_validate(item.value))
        except Exception:  # noqa: BLE001 — a malformed record is skipped, never fatal
            continue
    lessons.sort(key=lambda lesson: lesson.created_at, reverse=True)
    return lessons[:cap]
