import { useId } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

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
import type { AblationGroup } from "./ablations";

const WIDTH = 300;
const HEIGHT = 180;

/** docs/design-plan.md §6: "small multiples, one compact chart per ablation, rather than one large
 * combined chart — the ablations are independent comparisons and overlaying them would imply a
 * relationship that isn't there." Reshapes `ablations.ts`'s AblationGroup[] (already grouped by
 * category, e.g. one dataset or one agent role, each carrying up to two labelled series) into the
 * wide rows Recharts' grouped bars expect. Fixed width/height, not ResponsiveContainer, for the
 * same reason report/LeaderboardChart.tsx is: deterministic in jsdom and in M9f's screenshots. */
export function AblationChart({ groups }: { groups: readonly AblationGroup[] }) {
  // Scopes this chart instance's gradient ids — several AblationChart small multiples mount on
  // the same /eval page, and SVG <linearGradient> ids are global to the document.
  const gradientId = useId();
  if (groups.length === 0) return null;
  const seriesLabels = [...new Set(groups.flatMap((group) => group.series.map((s) => s.label)))];
  const data = groups.map((group) => ({
    category: group.category,
    ...Object.fromEntries(group.series.map((s) => [s.label, s.value])),
  }));

  return (
    <BarChart width={WIDTH} height={HEIGHT} data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <defs>
        {seriesLabels.map((label, index) => {
          const color = CHART_SERIES[index % CHART_SERIES.length] ?? CHART_SERIES[0];
          return (
            <linearGradient key={label} id={`${gradientId}-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor={color} stopOpacity={0.55} />
            </linearGradient>
          );
        })}
      </defs>
      <CartesianGrid stroke={CHART_GRID} vertical={false} />
      <XAxis dataKey="category" tick={{ ...CHART_TICK, fontSize: 10 }} axisLine={{ stroke: CHART_GRID }} tickLine={false} />
      <YAxis tick={{ ...CHART_TICK, fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
      <Tooltip
        cursor={CHART_CURSOR}
        contentStyle={CHART_TOOLTIP_STYLE}
        labelStyle={CHART_TOOLTIP_LABEL_STYLE}
        itemStyle={CHART_TOOLTIP_ITEM_STYLE}
      />
      <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-muted)" }} height={20} />
      {seriesLabels.map((label, index) => (
        <Bar
          key={label}
          dataKey={label}
          fill={`url(#${gradientId}-${index})`}
          radius={[2, 2, 0, 0]}
          animationDuration={CHART_ANIMATION_DURATION_MS}
          animationEasing={CHART_ANIMATION_EASING}
        />
      ))}
    </BarChart>
  );
}
