/** The rail's "cost by team" list (docs/design-plan.md §5). `RunStatus.cost_by_agent` is keyed by
 * `CostEntry.agent_role` (foundry/models.py: `Literal["principal", "red_team", "worker",
 * "sandbox"]`), confirmed against the committed demo recording's own totals. The rail label reads
 * "workers", plural, for the `worker` role — every other role's label is its key verbatim. */
export interface CostRow {
  id: string;
  label: string;
  usd: number;
}

const AGENT_LABELS: readonly { id: string; label: string }[] = [
  { id: "principal", label: "principal" },
  { id: "worker", label: "workers" },
  { id: "red_team", label: "red team" },
  { id: "sandbox", label: "sandbox" },
];

/** Zero-fills every known role so rows never appear and shift position as spend starts (§2: state
 * lives at a stable position). An unrecognised key — a future agent role the console doesn't know
 * about yet — is appended rather than dropped, so a cost is never silently hidden. */
export function costRows(costByAgent: Record<string, number>): CostRow[] {
  const known = new Set(AGENT_LABELS.map((agent) => agent.id));
  const rows = AGENT_LABELS.map(({ id, label }) => ({ id, label, usd: costByAgent[id] ?? 0 }));
  const unknown = Object.keys(costByAgent)
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({ id, label: id, usd: costByAgent[id] ?? 0 }));
  return [...rows, ...unknown];
}
