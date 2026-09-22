import type {
  DataProfile,
  ExperimentResult,
  RedTeamFinding,
  ReplayFrame,
  RunStatus,
} from "../api/types";

/** The TypeScript twin of app/replay.py's fold_frames, and it must stay exactly equivalent.
 *
 * A recorded frame's `status` is carry-forward ENCODED: five fields that rarely change (the
 * report, the model card, the data profile, and the append-only experiment and audit lists) are
 * blanked to `null` / `[]` whenever they are unchanged since the previous frame, which keeps a
 * recording at ~75 KB instead of ~750 KB. So `null` / `[]` here means "same as before", never
 * "the real value is empty" — sound only because those fields never return to empty once set.
 *
 * Folding restores one complete RunStatus per frame. Both implementations are asserted against the
 * same committed recording (fold.test.ts here, tests/test_demo_replay.py there): the last folded
 * status must equal `header.final_status`, so a disagreement between the two languages fails a
 * test on the real artifact rather than showing up as a wrong number on screen.
 */
export function foldFrames(frames: readonly ReplayFrame[]): RunStatus[] {
  let reportMd: string | null = null;
  let modelCardMd: string | null = null;
  let dataProfile: DataProfile | null = null;
  let experiments: ExperimentResult[] = [];
  let invalidations: RedTeamFinding[] = [];

  return frames.map(({ status }) => {
    if (status.report_md !== null) reportMd = status.report_md;
    if (status.model_card_md !== null) modelCardMd = status.model_card_md;
    if (status.data_profile !== null) dataProfile = status.data_profile;
    if (status.experiments.length > 0) experiments = status.experiments;
    if (status.invalidations.length > 0) invalidations = status.invalidations;

    return {
      ...status,
      report_md: reportMd,
      model_card_md: modelCardMd,
      data_profile: dataProfile,
      experiments,
      invalidations,
    };
  });
}
