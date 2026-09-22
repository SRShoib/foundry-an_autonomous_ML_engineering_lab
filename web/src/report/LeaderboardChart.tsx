import { useId } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import type { LeaderboardEntry } from "../api/types";
import { formatMetric } from "../lib/format";
import {
  CHART_ANIMATION_DURATION_MS,
  CHART_ANIMATION_EASING,
  CHART_CURSOR,
  CHART_GRID,
  CHART_SERIES,
  CHART_TICK,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  CHART_TOOLTIP_STYLE,
} from "../lib/chartTokens";

const WIDTH = 640;
const HEIGHT = 200;

/** docs/design-plan.md §6's "plots" for the report view. report_md embeds no images (verified
 * against foundry/teams/reporter.py's render_report — it is plain GFM tables and prose), so this
 * is the one chart, drawn client-side from RunStatus.leaderboard rather than authored server-side.
 * Fixed width/height, not ResponsiveContainer: a compact small multiple wants a fixed size anyway,
 * and it keeps the chart deterministic in jsdom and in M9f's screenshots. Exactly one chart here —
 * §7's "boldness spent once" stays on the red team, not this. */
export function LeaderboardChart({ leaderboard }: { leaderboard: readonly LeaderboardEntry[] }) {
  // Same gradient-id scoping concern as AblationChart.tsx, even though only one instance of this
  // chart is ever mounted — useId keeps the two files' pattern identical.
  const gradientId = useId();
  const sorted = [...leaderboard].sort((a, b) => a.rank - b.rank);
  const best = sorted[0];
  if (best === undefined) return null;
  const seriesColor = CHART_SERIES[0];

  return (
    <figure className="my-6 flex flex-col gap-2">
      {/* Fixed 640×200 internal geometry (see the docstring above), but `max-w-full` on the
       * generated .recharts-wrapper stops it overflowing the 375–390px mobile column: the wrapper's
       * own `viewBox` on its <svg> scales the whole drawing down uniformly once its box shrinks, so
       * nothing about the deterministic width/height passed to BarChart itself changes. */}
      <BarChart
        width={WIDTH}
        height={HEIGHT}
        data={sorted}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        className="max-w-full"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={seriesColor} stopOpacity={1} />
            <stop offset="100%" stopColor={seriesColor} stopOpacity={0.55} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={CHART_GRID} vertical={false} />
        <XAxis
          dataKey="experiment_id"
          tick={{ ...CHART_TICK, fontSize: 11 }}
          axisLine={{ stroke: CHART_GRID }}
          tickLine={false}
        />
        <YAxis
          tick={{ ...CHART_TICK, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={48}
          tickFormatter={(value: number) => value.toFixed(2)}
        />
        <Tooltip
          cursor={CHART_CURSOR}
          contentStyle={CHART_TOOLTIP_STYLE}
          labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          itemStyle={CHART_TOOLTIP_ITEM_STYLE}
        />
        <Bar
          dataKey="primary_metric_value"
          fill={`url(#${gradientId})`}
          radius={[2, 2, 0, 0]}
          animationDuration={CHART_ANIMATION_DURATION_MS}
          animationEasing={CHART_ANIMATION_EASING}
        />
      </BarChart>
      <figcaption className="text-xs text-fg-muted">
        {best.primary_metric_name} by experiment — best is {formatMetric(best.primary_metric_value)}
      </figcaption>
    </figure>
  );
}
