import { describe, expect, it, vi } from "vitest";

import { loadReplay, parseReplayJsonl, ReplayLoadError } from "./loadReplay";
import { demoReplayText } from "../test/demoReplay";

describe("parseReplayJsonl", () => {
  it("parses the committed recording into a header and its frames", () => {
    const replay = parseReplayJsonl(demoReplayText());
    expect(replay.header.name).toBe("demo-churn-leaky");
    expect(replay.header.n_frames).toBe(replay.frames.length);
    expect(replay.frames.length).toBeGreaterThan(20);
    expect(replay.frames[0]?.event.seq).toBe(0);
  });

  it("does not leak the file-format `kind` tag into the typed header or frames", () => {
    const replay = parseReplayJsonl(demoReplayText());
    expect("kind" in replay.header).toBe(false);
    expect("kind" in (replay.frames[0] ?? {})).toBe(false);
  });

  it("trusts frames over the header of an interrupted recording", () => {
    const lines = demoReplayText().trimEnd().split("\n");
    const header = {
      ...JSON.parse(lines[0] ?? "{}"),
      n_frames: 0,
      duration_s: 0,
      final_status: null,
    };
    const interrupted = [JSON.stringify(header), ...lines.slice(1)].join("\n");
    const replay = parseReplayJsonl(interrupted);
    expect(replay.header.n_frames).toBe(lines.length - 1);
    expect(replay.header.duration_s).toBe(replay.frames.at(-1)?.t_offset_s);
  });

  it("names the problem rather than throwing a bare SyntaxError", () => {
    expect(() => parseReplayJsonl("not json")).toThrow(/line 1 is not valid JSON/);
    expect(() => parseReplayJsonl("")).toThrow(/no header/);
    expect(() => parseReplayJsonl('{"kind":"mystery"}')).toThrow(/unexpected kind/);
  });

  it("refuses a format version it does not understand", () => {
    const header = { ...JSON.parse(demoReplayText().split("\n")[0] ?? "{}"), version: 99 };
    expect(() => parseReplayJsonl(JSON.stringify(header))).toThrow(/version 99 is not supported/);
  });
});

describe("loadReplay", () => {
  const ok = (body: string) => vi.fn(async () => new Response(body, { status: 200 }));

  it("fetches the file straight from /replays, never through the API", async () => {
    const fetchFn = ok(demoReplayText());
    const replay = await loadReplay("demo-churn-leaky", fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith("/replays/demo-churn-leaky.jsonl", {});
    expect(replay.frames.length).toBeGreaterThan(0);
  });

  it("names the fix when the recording does not exist (a 404)", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(loadReplay("missing", fetchFn as unknown as typeof fetch)).rejects.toThrow(
      /make record-replay/,
    );
  });

  it("recognises the index.html fallback a dev server answers a missing file with", async () => {
    // Vite and Caddy both serve index.html, status 200, for an unknown path.
    const fetchFn = ok("<!doctype html><html><body>console</body></html>");
    const error = await loadReplay("missing", fetchFn as unknown as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReplayLoadError);
    expect((error as Error).message).toContain('No recorded run named "missing"');
  });

  it.each(["../secret", "a/b", ".hidden", "", "x".repeat(65), "a..b"])(
    "rejects the unsafe name %j before making any request",
    async (name) => {
      const fetchFn = ok("{}");
      await expect(loadReplay(name, fetchFn as unknown as typeof fetch)).rejects.toThrow(
        /not a valid replay name/,
      );
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});
