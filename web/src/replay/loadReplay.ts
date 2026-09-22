import type { Replay, ReplayFrame, ReplayHeader, ReplayLine } from "../api/types";

/** The only replay format this build understands (app/replay.py's REPLAY_FORMAT_VERSION). */
export const SUPPORTED_REPLAY_VERSION = 1;

/** Mirrors app/replay.py's safe_replay_name so the URL a replay is fetched from can only ever name
 * a file in the replays directory. */
const REPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class ReplayLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayLoadError";
  }
}

/** Parses app/replay.py's JSONL: the header on line 1, then one frame per line. An interrupted
 * recording (a header with no closing rewrite) is still readable — the frames are trusted over the
 * header's counters, exactly as replay_from_jsonl does. */
export function parseReplayJsonl(text: string): Replay {
  let header: ReplayHeader | undefined;
  const frames: ReplayFrame[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    let line: ReplayLine;
    try {
      line = JSON.parse(raw) as ReplayLine;
    } catch {
      throw new ReplayLoadError(`replay line ${index + 1} is not valid JSON`);
    }
    if (line.kind === "header" && header === undefined) {
      const { kind: _kind, ...rest } = line;
      header = rest;
    } else if (line.kind === "frame") {
      const { kind: _kind, ...rest } = line;
      frames.push(rest);
    } else {
      throw new ReplayLoadError(`replay line ${index + 1} has an unexpected kind`);
    }
  });

  if (header === undefined) throw new ReplayLoadError("replay has no header line");
  if (header.version !== SUPPORTED_REPLAY_VERSION) {
    throw new ReplayLoadError(
      `replay format version ${header.version} is not supported (this build reads version ${SUPPORTED_REPLAY_VERSION})`,
    );
  }
  const last = frames.at(-1);
  return {
    header: {
      ...header,
      n_frames: frames.length,
      duration_s: Math.max(header.duration_s, last?.t_offset_s ?? 0),
    },
    frames,
  };
}

/** Fetches a committed recording straight from web/public/replays, NOT through the API: replay must
 * work with the API stopped (SPEC: "zero API calls"). */
export async function loadReplay(
  name: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Replay> {
  if (!REPLAY_NAME.test(name) || name.includes("..")) {
    throw new ReplayLoadError(`"${name}" is not a valid replay name`);
  }
  const missing = new ReplayLoadError(
    `No recorded run named "${name}". Recordings live in web/public/replays; make one with \`make record-replay\`.`,
  );

  const response = await fetchFn(`/replays/${name}.jsonl`, signal ? { signal } : {});
  if (!response.ok) throw missing;
  const text = await response.text();
  // Vite's dev server and Caddy both fall back to index.html for unknown paths, with a 200 —
  // so a missing recording arrives as HTML, not as a 404.
  if (text.trimStart().startsWith("<")) throw missing;
  return parseReplayJsonl(text);
}
