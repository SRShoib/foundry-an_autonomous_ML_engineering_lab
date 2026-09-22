import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import type { Replay } from "../api/types";
import { QueryErrorState } from "../components/states/ErrorState";
import { shortId } from "../lib/format";
import { loadReplay } from "../replay/loadReplay";
import { RunSourceProvider } from "../run/RunSourceContext";
import { createReplayRunSource } from "../run/replayRunSource";
import { useManagedRunSource } from "../run/useRunSource";
import { RunView, RunViewSkeleton } from "./RunView";

function ReplayPlayer({ replay }: { replay: Replay }) {
  const source = useManagedRunSource(() => createReplayRunSource(replay), replay.header.name);
  const { header } = replay;
  return (
    <RunSourceProvider source={source}>
      {/* The goal lives in the rail (§5), not the top bar — a live run has nowhere else to show it
          (RunStatus carries no goal at all), so RunView's own `goal` prop is where it belongs. */}
      <RunView
        goal={header.goal}
        meta={[
          { label: "dataset", value: header.task },
          { label: "run", value: shortId(header.thread_id) },
        ]}
      />
    </RunSourceProvider>
  );
}

/** Plays a committed recording. It is fetched straight from /replays — never through the API — so
 * this screen works with the API stopped, which is the whole point of replay mode. */
export function ReplayRoute() {
  const { name = "" } = useParams();
  const replay = useQuery({
    queryKey: ["replay", name],
    queryFn: ({ signal }) => loadReplay(name, fetch, signal),
    staleTime: Infinity,
    retry: false,
  });

  if (replay.isPending) return <RunViewSkeleton />;
  if (replay.isError) {
    return <RunViewSkeleton error={<QueryErrorState error={replay.error} title="Could not load this recording" />} />;
  }
  return <ReplayPlayer key={name} replay={replay.data} />;
}
