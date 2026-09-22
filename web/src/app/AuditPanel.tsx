import { motion } from "motion/react";

import type { RedTeamFinding, RunStatus } from "../api/types";
import { EmptyState } from "../components/states/EmptyState";
import { Panel } from "../components/ui/Panel";
import { invalidatedFindings } from "../run/invalidations";
import type { Choreography } from "./useInvalidationChoreography";

/** §8's "audit tool's actual measured evidence", picked by category — never a number the code
 * floor did not itself measure (foundry/teams/red_team.py's `_apply_floor` only has a code floor
 * for these three categories; seed_hacking and improper_cv are LLM-judgment calls with nothing
 * code-measured behind them, so they show the verdict's own reasoning instead of inventing a
 * figure). Exported for direct unit testing, independent of rendering. */
export function evidenceHeadline(finding: RedTeamFinding): { label: string; value: string } | null {
  // Loose check deliberately: the type promises `evidence` is always at least `null`, but a
  // committed replay recorded before M9d added the field is a static JSONL that predates the
  // promise and omits the key entirely, which reads back as `undefined` at runtime (GateDialog.tsx
  // and ExperimentDrawer.tsx guard the same class of skew against their own new fields).
  const evidence = finding.evidence;
  if (evidence == null) return null;
  switch (finding.category) {
    case "leakage":
      return evidence.worst_column === null || evidence.worst_column_target_auc === null
        ? null
        : { label: evidence.worst_column, value: `AUC ${evidence.worst_column_target_auc.toFixed(4)}` };
    case "contamination":
      return { label: "duplicate rows", value: `${(evidence.duplicate_row_rate * 100).toFixed(1)}%` };
    case "validation_overfitting":
      return { label: evidence.reported_metric_name, value: evidence.reported_metric_value.toFixed(4) };
    case "seed_hacking":
    case "improper_cv":
      return null;
  }
}

function CompactRow({ finding, onOpen }: { finding: RedTeamFinding; onOpen: (id: string) => void }) {
  return (
    <li className="border-b border-line-hairline py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => onOpen(finding.experiment_id)}
        aria-label={`Open experiment ${finding.experiment_id}`}
        className="-mx-2 flex w-full items-baseline gap-3 rounded-control px-2 text-left transition-colors duration-(--dur-quick) ease-out hover:bg-surface-raised"
      >
        <span aria-hidden="true" className="num w-5 text-sm text-status-danger">
          ⊘
        </span>
        <span className="num flex-1 truncate text-sm text-fg">{finding.experiment_id}</span>
        <span className="text-sm text-fg-secondary">{finding.category.replace(/_/g, " ")}</span>
      </button>
    </li>
  );
}

/** The moment itself (§8, 700–1400ms window and its resting state): the category at
 * --text-display — "the only use of that size on this screen" — the measured evidence beside it,
 * and the recommendation. `data-audit-entry` is the connector's landing point. */
function ExpandedEntry({ finding, onOpen }: { finding: RedTeamFinding; onOpen: (id: string) => void }) {
  const headline = evidenceHeadline(finding);
  return (
    <li data-audit-entry={finding.experiment_id} className="flex flex-col gap-2 border-b border-line-hairline pb-3">
      <button
        type="button"
        onClick={() => onOpen(finding.experiment_id)}
        aria-label={`Open experiment ${finding.experiment_id}`}
        className="num text-left text-sm text-fg-secondary underline-offset-2 transition-colors duration-(--dur-quick) ease-out hover:text-fg hover:underline"
      >
        {finding.experiment_id}
      </button>
      <p className="text-display font-medium text-status-danger">{finding.category.replace(/_/g, " ")}</p>
      {headline !== null && (
        <p className="text-sm text-fg-secondary">
          {headline.label} <span className="num text-fg">{headline.value}</span>
        </p>
      )}
      {headline === null && <p className="text-sm text-fg-secondary">{finding.explanation}</p>}
      <p className="text-sm text-fg-secondary">{finding.recommendation}</p>
      <p className="text-xs text-fg-muted">excluded from ranking</p>
    </li>
  );
}

interface AuditPanelProps {
  status: RunStatus | null;
  choreography: Choreography;
  onOpen: (experimentId: string) => void;
}

/** The dock's audit panel (§5, §6, §8) — replaces M9c's skeleton stand-in. The current
 * choreography's finding (while its own sequence is in "connect" or "finding") gets the
 * headline moment; every other invalidated finding, including ones that already had their own
 * moment earlier, is a compact row — §8's display size is a moment, not a resting list style. */
export function AuditPanel({ status, choreography, onOpen }: AuditPanelProps) {
  const invalidated = invalidatedFindings(status?.invalidations ?? []);
  const activeId =
    choreography.phase === "connect" || choreography.phase === "finding" ? choreography.finding?.experiment_id : undefined;

  return (
    <Panel title="audit" meta={invalidated.length === 0 ? undefined : <span className="num">{invalidated.length} invalidated</span>}>
      {invalidated.length === 0 ? (
        <EmptyState
          title="No invalidations"
          hint={
            (status?.invalidations.length ?? 0) === 0
              ? "The red team audits every cleared experiment before it can rank."
              : "Every audited experiment has cleared so far."
          }
        />
      ) : (
        <>
          {/* §8: "a single 2px --team-redteam rule runs along the top... and fades across the
              full 1400ms". Keyed by the sequence's own finding so a FRESH invalidation always
              restarts the fade; rendered only while a sequence is active, so an idle mount (a
              page load with pre-existing invalidations) never plays it. */}
          {choreography.phase !== "idle" && (
            <motion.div
              key={choreography.finding?.experiment_id}
              aria-hidden="true"
              className="mb-2 h-0.5 bg-team-redteam"
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 1.4 }}
            />
          )}
          <ol aria-label="Invalidated experiments" className="flex flex-col">
            {invalidated.map((finding) =>
              finding.experiment_id === activeId ? (
                <ExpandedEntry key={finding.experiment_id} finding={finding} onOpen={onOpen} />
              ) : (
                <CompactRow key={finding.experiment_id} finding={finding} onOpen={onOpen} />
              ),
            )}
          </ol>
        </>
      )}
    </Panel>
  );
}
