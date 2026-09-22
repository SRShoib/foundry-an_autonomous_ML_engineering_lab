import { describe, expect, it } from "vitest";

import { SseParser, type SseMessage } from "./parseSse";

function parseAll(...chunks: string[]): SseMessage[] {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

const WIRE =
  'data: {"seq":0,"kind":"node"}\n\n' +
  ": ping\n\n" +
  'data: {"seq":1,"kind":"interrupt"}\n\n' +
  'data: {"seq":2,"kind":"done"}\n\n';

describe("SseParser", () => {
  it("parses foundry's wire format: bare `data:` frames plus `: ping` keepalives", () => {
    expect(parseAll(WIRE).map((m) => JSON.parse(m.data))).toEqual([
      { seq: 0, kind: "node" },
      { seq: 1, kind: "interrupt" },
      { seq: 2, kind: "done" },
    ]);
  });

  it("returns the same messages however the network splits the bytes", () => {
    const expected = parseAll(WIRE);
    // every possible single split point, including inside a field name and between the two \n
    for (let cut = 0; cut <= WIRE.length; cut++) {
      expect(parseAll(WIRE.slice(0, cut), WIRE.slice(cut))).toEqual(expected);
    }
    // and the worst case: one character per read
    expect(parseAll(...WIRE.split(""))).toEqual(expected);
  });

  it("does not emit a message until its terminating blank line arrives", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"seq":0}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([{ data: '{"seq":0}' }]);
  });

  it("joins multi-line data with newlines", () => {
    expect(parseAll("data: a\ndata: b\ndata: c\n\n")).toEqual([{ data: "a\nb\nc" }]);
  });

  it("handles CRLF and lone CR line endings, even when CRLF is split across reads", () => {
    expect(parseAll("data: x\r\n\r\n")).toEqual([{ data: "x" }]);
    expect(parseAll("data: x\r", "\n\r", "\n")).toEqual([{ data: "x" }]);
    expect(parseAll("data: x\r\rdata: y\n\n")).toEqual([{ data: "x" }, { data: "y" }]);
  });

  it("holds a trailing lone CR back, since it may be the first half of CRLF", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\r\r")).toEqual([]); // cannot yet tell \r from \r\n
    expect(parser.push("data: y\n\n")).toEqual([{ data: "x" }, { data: "y" }]);
  });

  it("reads event, id and retry fields even though foundry does not currently send them", () => {
    expect(parseAll("event: tick\nid: 7\nretry: 1500\ndata: hi\n\n")).toEqual([
      { data: "hi", event: "tick", id: "7", retry: 1500 },
    ]);
  });

  it("ignores comments, unknown fields, a bad retry, and events with no data", () => {
    expect(parseAll(": just a comment\nfoo: bar\nretry: soon\n\n")).toEqual([]);
    expect(parseAll("event: orphan\n\ndata: real\n\n")).toEqual([{ data: "real" }]);
  });

  it("strips exactly one leading space from a value, as the spec says", () => {
    expect(parseAll("data:  two spaces\n\n")).toEqual([{ data: " two spaces" }]);
    expect(parseAll("data:none\n\n")).toEqual([{ data: "none" }]);
  });

  it("keeps a colon inside the value", () => {
    expect(parseAll('data: {"summary":"principal -> data_team: go"}\n\n')[0]?.data).toBe(
      '{"summary":"principal -> data_team: go"}',
    );
  });

  it("carries a partial trailing message until it completes", () => {
    const parser = new SseParser();
    expect(parser.push("data: par")).toEqual([]);
    expect(parser.push("tial\n\n")).toEqual([{ data: "partial" }]);
  });
});
