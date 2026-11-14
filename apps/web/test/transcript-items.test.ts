import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptEntry } from "@gasho/protocol";
import { transcriptItems, type TranscriptItem } from "../src/lib/transcript-items.ts";

// Claude Code records each tool call and each result as an entry of its own.
const call = (id: string, name = "Bash", extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `u-${id}`,
  role: "assistant",
  blocks: [{ type: "tool_use", id, name, input: "{}", summary: `${name} ${id}` }],
  ...extra,
});
const result = (id: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `r-${id}`,
  role: "user",
  blocks: [{ type: "tool_result", toolUseId: id, content: "", isError: false }],
  ...extra,
});
const text = (uuid: string, role: TranscriptEntry["role"] = "assistant"): TranscriptEntry => ({ uuid, role, blocks: [{ type: "text", text: uuid }] });

function items(entries: TranscriptEntry[], start = 0): TranscriptItem[] {
  const calls = new Set(entries.flatMap((e) => e.blocks.flatMap((b) => (b.type === "tool_use" && b.id ? [b.id] : []))));
  return transcriptItems(entries, start, (id) => Boolean(id && calls.has(id)));
}

/** "entry:<key>" or "tools:<call ids>", to compare the shape at a glance. */
const shape = (list: TranscriptItem[]): string[] =>
  list.map((i) => (i.kind === "entry" ? `entry:${i.key}` : `tools:${i.calls.map((c) => c.id).join(",")}`));

test("tool calls in a row become one item, with the results between them; one call alone stays as it is", () => {
  const list = items([text("t1", "user"), call("a"), result("a"), call("b"), result("b"), call("c"), result("c"), text("t2"), call("d"), result("d")]);
  assert.deepEqual(shape(list), ["entry:t1", "tools:a,b,c", "entry:t2", "entry:u-d"]);
  // The group is keyed by its first call, so it keeps its key (and stays open) while calls are added.
  assert.equal(list[1]?.key, "tools:u-a");
  const later = items([text("t1", "user"), call("a"), result("a"), call("b"), result("b"), call("c"), result("c"), call("e")]);
  assert.deepEqual(shape(later), ["entry:t1", "tools:a,b,c,e"]);
  assert.equal(later[1]?.key, "tools:u-a");
});

test("calls made at once, before their results, are put together too", () => {
  assert.deepEqual(shape(items([call("a"), call("b"), call("c"), result("a"), result("b"), result("c")])), ["tools:a,b,c"]);
});

test("calls of different tools in a row are put together too; text and an interruption end the row", () => {
  const list = items([
    call("a"),
    result("a"),
    call("r", "Read"),
    result("r"),
    call("b"),
    result("b"),
    text("t"),
    call("c", "Grep"),
    result("c"),
    { uuid: "stop", role: "user", interrupted: true, blocks: [{ type: "text", text: "[Request interrupted by user]" }] },
    call("e", "Edit"),
    result("e"),
    call("f", "Edit"),
    result("f"),
  ]);
  assert.deepEqual(shape(list), ["tools:a,r,b", "entry:t", "entry:u-c", "entry:stop", "tools:e,f"]);
});

test("results whose calls are on an older page are shown on their own, before the calls that follow", () => {
  const list = items([result("old1"), result("old2"), call("a"), result("a"), call("b"), result("b")]);
  assert.deepEqual(shape(list), ["entry:r-old1", "entry:r-old2", "tools:a,b"]);
});

test("calls of a subagent are not put together with the session's own calls", () => {
  const side = { isSidechain: true };
  const list = items([call("a"), result("a"), call("b", "Bash", side), result("b", side), call("c", "Bash", side), result("c", side)]);
  assert.deepEqual(shape(list), ["entry:u-a", "tools:b,c"]);
  assert.equal(list[1]?.kind === "tools" && list[1].isSidechain, true);
});

test("entries without a uuid are keyed by their place in the whole transcript", () => {
  const list = items([{ ...text("x"), uuid: "" }, { ...call("a"), uuid: "" }, result("a"), { ...call("b"), uuid: "" }], 40);
  assert.deepEqual(
    list.map((i) => i.key),
    ["i40", "tools:i41"],
  );
});

// A compaction is recorded as a mark and, right after it, the summary the conversation goes on from.
const mark = (uuid: string): TranscriptEntry => ({
  uuid,
  ts: "2026-11-13T16:47:18.040Z",
  role: "system",
  compaction: "mark",
  blocks: [{ type: "text", text: "Conversation compacted" }],
});
const summary = (uuid: string): TranscriptEntry => ({ uuid, role: "system", compaction: "summary", blocks: [{ type: "text", text: "## 依頼" }] });
const kinds = (list: TranscriptItem[]): string[] => list.map((i) => `${i.kind}:${i.key}`);

test("a compaction's mark and summary become one item, which ends a row of tool calls", () => {
  const list = items([call("a"), result("a"), call("b"), result("b"), mark("m"), summary("s"), call("c"), result("c"), call("d")]);
  assert.deepEqual(kinds(list), ["tools:tools:u-a", "compaction:compaction:s", "tools:tools:u-c"]);
  const item = list[1];
  assert.equal(item?.kind === "compaction" && item.summary, "## 依頼");
  assert.equal(item?.kind === "compaction" && item.ts, "2026-11-13T16:47:18.040Z");
});

test("a compaction split by a page, or without its summary yet, is still one item; it is keyed by its summary", () => {
  // The page with the mark is not loaded yet: the item keeps its key when it comes.
  assert.deepEqual(kinds(items([summary("s"), text("t", "user")])), ["compaction:compaction:s", "entry:t"]);
  // The summary is not recorded yet, or not loaded: the mark alone.
  const alone = items([text("t"), mark("m"), text("u", "user")]);
  assert.deepEqual(kinds(alone), ["entry:t", "compaction:compaction:m", "entry:u"]);
  assert.equal(alone[1]?.kind === "compaction" && alone[1].summary, undefined);
  // Without a uuid, by its place in the whole transcript.
  assert.deepEqual(kinds(items([mark(""), summary("")], 10)), ["compaction:compaction:i11"]);
});
