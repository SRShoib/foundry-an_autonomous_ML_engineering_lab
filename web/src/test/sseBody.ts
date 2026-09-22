import type { ActivityEvent } from "../api/types";

const encoder = new TextEncoder();

/** foundry's wire format: bare `data: <json>` frames separated by a blank line. */
export function sseText(events: readonly ActivityEvent[], options: { keepalive?: boolean } = {}): string {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (options.keepalive) frames.splice(1, 0, ": ping\n\n"); // FastAPI's native SSE keepalive
  return frames.join("");
}

/** A finite stream that delivers `text` in `chunkSize`-byte reads — small sizes split frames, lines
 * and even multi-byte characters across reads, as a real network can. */
export function sseBody(text: string, chunkSize = Infinity): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Number.isFinite(chunkSize) ? offset + chunkSize : bytes.length;
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** A stream that delivers `text`, then fails — a dropped connection. */
export function brokenBody(text: string, message = "network down"): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (text) controller.enqueue(encoder.encode(text));
        return;
      }
      controller.error(new TypeError(message));
    },
  });
}

/** A stream that never produces anything and never ends, until the request is aborted. */
export function hangingBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
}
