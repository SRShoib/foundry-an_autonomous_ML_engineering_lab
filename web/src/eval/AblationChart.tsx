import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";

import type { AblationGroup } from "./ablations";

const WIDTH = 300;
const HEIGHT = 180;
const SERIES_COLOR = ["var(--status-info)", "var(--status-idle)"] as const;

/** docs/design-plan.md §6: "small multiples, one compact chart per ablation, rather than one large
 * combined chart — the ablations are independent comparisons and overlaying them would imply a
 * relationship that isn't there." Reshapes `ablations.ts`'s AblationGroup[] (already grouped by
 * category, e.g. one dataset or one agent role, each carrying up to two labelled series) into the
 * wide rows Recharts' grouped bars expect. Fixed width/height, not ResponsiveContainer, for the
 * same reason report/LeaderboardChart.tsx is: deterministic in jsdom and in M9f's screenshots. */
export function AblationChart({ groups }: { groups: readonly AblationGroup[] }) {
  if (groups.length === 0) return null;
  const seriesLabels = [...new Set(groups.flatMap((group) => group.series.map((s) => s.label)))];
  const data = groups.map((group) => ({
    category: group.category,
    ...Object.fromEntries(group.series.map((s) => [s.label, s.value])),
  }));

  return (
    <BarChart width={WIDTH} height={HEIGHT} data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="var(--line-hairline)" vertical={false} />
      <XAxis
        dataKey="category"
        tick={{ fill: "var(--text-muted)", fontSize: 10 }}
        axisLine={{ stroke: "var(--line-hairline)" }}
        tickLine={false}
      />
      <YAxis tick={{ fill: "var(--text-muted)", fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
      <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-muted)" }} height={20} />
      {seriesLabels.map((label, index) => (
        <Bar
          key={label}
          dataKey={label}
          fill={SERIES_COLOR[index % SERIES_COLOR.length] ?? SERIES_COLOR[0]}
          radius={[2, 2, 0, 0]}
        />
      ))}
    </BarChart>
  );
}
