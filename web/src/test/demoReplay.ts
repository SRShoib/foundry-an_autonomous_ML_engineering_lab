import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Replay } from "../api/types";
import { parseReplayJsonl } from "../replay/loadReplay";

/** Where the committed demo recording lives: web/public/replays, served statically by Vite and
 * Caddy so the console replays with the API stopped. Read from disk here because tests run in
 * Node, but parsed by the same parseReplayJsonl the browser uses. */
export const DEMO_REPLAY_PATH = resolve(
  import.meta.dirname,
  "../../public/replays/demo-churn-leaky.jsonl",
);

export function demoReplayText(): string {
  return readFileSync(DEMO_REPLAY_PATH, "utf8");
}

export function loadDemoReplay(): Replay {
  return parseReplayJsonl(demoReplayText());
}
