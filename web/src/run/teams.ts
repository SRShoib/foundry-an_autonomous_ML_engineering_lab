/** docs/design-plan.md §3.1: each agent team owns one desaturated hue, used only as a rail and a
 * glyph — never a fill, never in a table. Every team also carries a text label, so hue is
 * redundant encoding (WCAG 1.4.1): a colour-blind operator, or one on the light theme's "datasheet"
 * palette, still knows who acted from the label and glyph alone.
 *
 * `ActivityEvent.node` is `string | null` in the generated schema (app/events.py's node names are
 * not a closed enum on the wire), so this module is the one place a raw node string becomes a known
 * team — everything else imports `TeamId`, never a literal like `"red_team"`.
 */
import type { ActivityEvent } from "../api/types";

export type TeamId =
  | "principal"
  | "data_team"
  | "modeling_team"
  | "experiment_runner"
  | "red_team"
  | "reporter";

export const TEAM_ORDER: readonly TeamId[] = [
  "principal",
  "data_team",
  "modeling_team",
  "experiment_runner",
  "red_team",
  "reporter",
];

export interface TeamMeta {
  label: string;
  /** aria-hidden glyph shown beside the label; never the only carrier of identity. */
  glyph: string;
  /** Tailwind class for the feed's left rail and small dots. */
  railBg: string;
  /** Tailwind class for text/icons that need the team hue (rare — tables never do, §3.1). */
  text: string;
  /** The rail is 5px only for red_team (design-plan §5's "▐" vs "▌"); 3px everywhere else. */
  railWidth: "thin" | "thick";
}

export const TEAM_META: Record<TeamId, TeamMeta> = {
  principal: { label: "principal", glyph: "●", railBg: "bg-team-principal", text: "text-team-principal", railWidth: "thin" },
  data_team: { label: "data", glyph: "●", railBg: "bg-team-data", text: "text-team-data", railWidth: "thin" },
  modeling_team: { label: "modeling", glyph: "●", railBg: "bg-team-modeling", text: "text-team-modeling", railWidth: "thin" },
  experiment_runner: { label: "runner", glyph: "●", railBg: "bg-team-runner", text: "text-team-runner", railWidth: "thin" },
  red_team: { label: "red team", glyph: "●", railBg: "bg-team-redteam", text: "text-team-redteam", railWidth: "thick" },
  reporter: { label: "reporter", glyph: "●", railBg: "bg-team-reporter", text: "text-team-reporter", railWidth: "thin" },
};

const NODE_TO_TEAM: Record<string, TeamId> = {
  principal: "principal",
  data_team: "data_team",
  modeling_team: "modeling_team",
  experiment_runner: "experiment_runner",
  red_team: "red_team",
  reporter: "reporter",
};

/** `final_gate`, `lesson_writer`, and every non-`node` event kind (`interrupt`, `done`, `error`)
 * resolve to `null` — they are not a team's own turn, and render in the status ramp instead. */
export function teamForNode(node: string | null): TeamId | null {
  if (node === null) return null;
  return NODE_TO_TEAM[node] ?? null;
}

export function teamForEvent(event: Pick<ActivityEvent, "node">): TeamId | null {
  return teamForNode(event.node);
}
