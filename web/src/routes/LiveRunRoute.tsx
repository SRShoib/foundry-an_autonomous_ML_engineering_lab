import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";

import { useApiClient } from "../api/ApiClientContext";
import { queryKeys } from "../api/queries";
import { shortId } from "../lib/format";
import { createLiveRunSource } from "../run/liveRunSource";
import { RunSourceProvider } from "../run/RunSourceContext";
import { useManagedRunSource } from "../run/useRunSource";
import { RunView } from "./RunView";

export function LiveRunRoute() {
  const { threadId = "" } = useParams();
  const api = useApiClient();
  const queryClient = useQueryClient();

  const source = useManagedRunSource(
    () =>
      createLiveRunSource(threadId, {
        api,
        // The query cache holds the one copy of the status, so a screen that reads it through
        // useRun() sees the same value the stream refreshed.
        onStatus: (status) => queryClient.setQueryData(queryKeys.run(threadId), status),
      }),
    threadId,
  );

  return (
    <RunSourceProvider source={source}>
      <RunView meta={[{ label: "run", value: shortId(threadId) }]} />
    </RunSourceProvider>
  );
}
