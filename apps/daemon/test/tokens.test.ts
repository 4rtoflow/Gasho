import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TokenCounter, usageOfLine } from "../src/tokens.ts";

const reply = (id: string, at: string, usage: Record<string, number>, extra = "") =>
  `${JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage, content: [{ type: "text", text: `はい${extra}` }] } })}\n`;

test("a reply's usage is read from its transcript line; other lines record none", () => {
  const line = reply("m1", "2026-11-12T10:15:00Z", { input_tokens: 2, output_tokens: 738, cache_creation_input_tokens: 3101, cache_read_input_tokens: 45541 });
  assert.deepEqual(usageOfLine(line.trim()), {
    id: "m1",
    at: Date.parse("2026-11-12T10:15:00Z"),
    usage: { input: 2, output: 738, cacheWrite: 3101, cacheRead: 45541 },
  });
  assert.equal(usageOfLine(JSON.stringify({ type: "user", message: { usage: {} } })), undefined);
  assert.equal(usageOfLine('{"type":"assistant","usage": broken'), undefined);
});

test("tokens are counted once per reply, across the session's transcript and its subagents', as they are written", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  const transcript = path.join(dir, "s1.jsonl");
  const workflow = path.join(dir, "s1", "subagents", "workflows", "wf_1");
  await fs.mkdir(workflow, { recursive: true });
  const u = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  });
  // A reply written as two records (one per content block) repeats its usage.
  await fs.writeFile(transcript, reply("m1", "2026-11-12T10:15:00Z", u(1, 10, 100, 1000)) + reply("m1", "2026-11-12T10:15:01Z", u(1, 10, 100, 1000)));
  await fs.writeFile(path.join(dir, "s1", "subagents", "agent-a.jsonl"), reply("a1", "2026-11-12T11:00:00Z", u(2, 20, 0, 0)));
  await fs.writeFile(path.join(workflow, "agent-b.jsonl"), reply("b1", "2026-11-12T11:30:00Z", u(3, 30, 0, 300)));
  const c = new TokenCounter(transcript);
  assert.equal(await c.update(), true);
  assert.deepEqual(c.totals(), { input: 6, output: 60, cacheWrite: 100, cacheRead: 1300 });
  assert.equal(await c.update(), false);
  // A reply written in two pieces, split inside a character, counts once the line is whole.
  const more = Buffer.from(reply("m2", "2026-11-12T12:05:00Z", u(4, 40, 0, 0), "（続き）"));
  const cut = more.indexOf(Buffer.from("続")) + 1;
  await fs.appendFile(transcript, more.subarray(0, cut));
  await c.update();
  assert.equal(c.totals().output, 60);
  await fs.appendFile(transcript, more.subarray(cut));
  assert.equal(await c.update(), true);
  assert.equal(c.totals().output, 100);
  // Per hour, within the last 48 hours.
  const hours = c.hours(Date.parse("2026-11-12T12:30:00Z"));
  assert.deepEqual(
    hours.map(([h, x]) => [new Date(h).toISOString().slice(11, 16), x.output]),
    [
      ["10:00", 10],
      ["11:00", 50],
      ["12:00", 40],
    ],
  );
  assert.deepEqual(c.hours(Date.parse("2026-11-15T00:00:00Z")), []);
  await fs.rm(dir, { recursive: true, force: true });
});
