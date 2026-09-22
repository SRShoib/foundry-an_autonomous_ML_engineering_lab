/** A Server-Sent Events parser (https://html.spec.whatwg.org/multipage/server-sent-events.html),
 * written against plain strings so it needs no TextDecoderStream and tests under jsdom.
 *
 * Why not the browser's EventSource: foundry's stream is FINITE by design — it ends at every
 * approval pause and at completion (app/runs.py) — and EventSource treats a normal end as an error
 * and reconnects forever, with no way to say "this one was expected". The console reads the stream
 * with fetch() and its own reconnect policy, which needs its own parser.
 *
 * Chunk boundaries are arbitrary: a network read can split a message, a line, or a CRLF pair.
 * `push` therefore buffers anything incomplete and only ever returns whole messages.
 */

export interface SseMessage {
  data: string;
  /** Absent when the server sends none (foundry's does not). */
  event?: string;
  id?: string;
  retry?: number;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseMessage[] {
    const input = this.buffer + chunk;
    const messages: SseMessage[] = [];
    let lineStart = 0;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch !== "\n" && ch !== "\r") continue;
      // A trailing "\r" may be the first half of "\r\n"; wait for the next chunk to know.
      if (ch === "\r" && i === input.length - 1) break;

      const line = input.slice(lineStart, i);
      if (ch === "\r" && input[i + 1] === "\n") i++;
      lineStart = i + 1;

      const message = this.processLine(line);
      if (message) messages.push(message);
    }

    this.buffer = input.slice(lineStart);
    return messages;
  }

  private processLine(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined; // comment — foundry's keepalive is `: ping`

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored, per spec
    }
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    const hasData = this.data.length > 0;
    const message: SseMessage | undefined = hasData ? { data: this.data.join("\n") } : undefined;
    if (message) {
      if (this.event !== undefined) message.event = this.event;
      if (this.id !== undefined) message.id = this.id;
      if (this.retry !== undefined) message.retry = this.retry;
    }
    // Per spec `id` persists across events; data and event do not.
    this.data = [];
    this.event = undefined;
    this.retry = undefined;
    return message;
  }
}
