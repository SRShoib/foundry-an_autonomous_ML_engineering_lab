/** docs/design-plan.md §3.1 (revised M9h): each agent team owns one vivid hue, shown as an icon chip
 * (15% tint), a feed/roster row wash (8%) and the team label — never in the leaderboard or any
 * table. Every team also carries a text label AND a distinct icon, so hue is redundant encoding
 * (WCAG 1.4.1): a colour-blind operator still knows who acted from the label and icon alone. The
 * runner/red-team pair is the one that matters most, and a flask and a shield-alert read apart in
 * greyscale.
 *
 * `ActivityEvent.node` is `string | null` in the generated schema (app/events.py's node names are
 * not a closed enum on the wire), so this module is the one place a raw node string becomes a known
 * team — everything else imports `TeamId`, never a literal like `"red_team"`.
 */
import { BrainCircuit, Compass, Database, FileText, FlaskConical, ShieldAlert, type LucideIcon } from "lucide-react";

import type { ActivityEvent } from "../api/types";
import { WASH } from "../lib/wash";

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
  /** M9h: the team's lucide icon. Decorative beside the label, but it is what tells runner from red
   * team apart without colour. */
  Icon: LucideIcon;
  /** M9h: an icon chip — a 15% tint with the icon in the team colour. Verified to AA as a graphic. */
  chip: string;
  /** M9h: an 8% row wash. Verified against label, secondary and muted text on every ground a feed
   * or roster row sits on (styles/tokens.contrast.test.ts, TEAM_WASH_ALPHA). */
  wash: string;
}

export const TEAM_META: Record<TeamId, TeamMeta> = {
  principal: {
    label: "principal", glyph: "●", railBg: "bg-team-principal", text: "text-team-principal", railWidth: "thin",
    Icon: Compass, chip: "bg-team-principal/15 text-team-principal", wash: WASH.principal,
  },
  data_team: {
    label: "data", glyph: "●", railBg: "bg-team-data", text: "text-team-data", railWidth: "thin",
    Icon: Database, chip: "bg-team-data/15 text-team-data", wash: WASH.data,
  },
  modeling_team: {
    label: "modeling", glyph: "●", railBg: "bg-team-modeling", text: "text-team-modeling", railWidth: "thin",
    Icon: BrainCircuit, chip: "bg-team-modeling/15 text-team-modeling", wash: WASH.modeling,
  },
  experiment_runner: {
    label: "runner", glyph: "●", railBg: "bg-team-runner", text: "text-team-runner", railWidth: "thin",
    Icon: FlaskConical, chip: "bg-team-runner/15 text-team-runner", wash: WASH.runner,
  },
  red_team: {
    label: "red team", glyph: "●", railBg: "bg-team-redteam", text: "text-team-redteam", railWidth: "thick",
    Icon: ShieldAlert, chip: "bg-team-redteam/15 text-team-redteam", wash: WASH.redteam,
  },
  reporter: {
    label: "reporter", glyph: "●", railBg: "bg-team-reporter", text: "text-team-reporter", railWidth: "thin",
    Icon: FileText, chip: "bg-team-reporter/15 text-team-reporter", wash: WASH.reporter,
  },
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
