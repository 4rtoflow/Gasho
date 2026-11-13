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

/** "entry:<key>" or "commands:<call ids>", to compare the shape at a glance. */
const shape = (list: TranscriptItem[]): string[] =>
  list.map((i) => (i.kind === "entry" ? `entry:${i.key}` : `commands:${i.calls.map((c) => c.id).join(",")}`));

test("Bash calls in a row become one item, with the results between them; one call alone stays as it is", () => {
  const list = items([text("t1", "user"), call("a"), result("a"), call("b"), result("b"), call("c"), result("c"), text("t2"), call("d"), result("d")]);
  assert.deepEqual(shape(list), ["entry:t1", "commands:a,b,c", "entry:t2", "entry:u-d"]);
  // The group is keyed by its first call, so it keeps its key (and stays open) while calls are added.
  assert.equal(list[1]?.key, "commands:u-a");
  const later = items([text("t1", "user"), call("a"), result("a"), call("b"), result("b"), call("c"), result("c"), call("e")]);
  assert.deepEqual(shape(later), ["entry:t1", "commands:a,b,c,e"]);
  assert.equal(later[1]?.key, "commands:u-a");
});

test("calls made at once, before their results, are put together too", () => {
  assert.deepEqual(shape(items([call("a"), call("b"), call("c"), result("a"), result("b"), result("c")])), ["commands:a,b,c"]);
});

test("other tools, text and an interruption end the row; only Bash calls are put together", () => {
  const list = items([
    call("a"),
    result("a"),
    call("r", "Read"),
    result("r"),
    call("b"),
    result("b"),
    call("c"),
    result("c"),
    { uuid: "stop", role: "user", interrupted: true, blocks: [{ type: "text", text: "[Request interrupted by user]" }] },
    call("e", "Edit"),
    result("e"),
    call("f", "Edit"),
    result("f"),
  ]);
  assert.deepEqual(shape(list), ["entry:u-a", "entry:u-r", "commands:b,c", "entry:stop", "entry:u-e", "entry:u-f"]);
});

test("results whose calls are on an older page are shown on their own, before the calls that follow", () => {
  const list = items([result("old1"), result("old2"), call("a"), result("a"), call("b"), result("b")]);
  assert.deepEqual(shape(list), ["entry:r-old1", "entry:r-old2", "commands:a,b"]);
});

test("calls of a subagent are not put together with the session's own calls", () => {
  const side = { isSidechain: true };
  const list = items([call("a"), result("a"), call("b", "Bash", side), result("b", side), call("c", "Bash", side), result("c", side)]);
  assert.deepEqual(shape(list), ["entry:u-a", "commands:b,c"]);
  assert.equal(list[1]?.kind === "commands" && list[1].isSidechain, true);
});

test("entries without a uuid are keyed by their place in the whole transcript", () => {
  const list = items([{ ...text("x"), uuid: "" }, { ...call("a"), uuid: "" }, result("a"), { ...call("b"), uuid: "" }], 40);
  assert.deepEqual(
    list.map((i) => i.key),
    ["i40", "commands:i41"],
  );
});
