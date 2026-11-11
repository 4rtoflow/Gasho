import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { emptyMeta, parseRecord, readTranscript, toUrlSessionId, TranscriptTail } from "../src/transcript.ts";

test("user text: interrupt marker, branch and timestamp", () => {
  const meta = emptyMeta();
  const e = parseRecord(
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-11-11T08:56:45.000Z",
      gitBranch: "main",
      message: { role: "user", content: "[Request interrupted by user]" },
    },
    meta,
  );
  assert.equal(e?.role, "user");
  assert.equal(e?.interrupted, true);
  assert.equal(meta.gitBranch, "main");
  assert.equal(meta.lastActivityAt, Date.parse("2026-11-11T08:56:45.000Z"));
});

test("assistant tool_use and user tool_result; thinking is dropped", () => {
  const meta = emptyMeta();
  const a = parseRecord(
    {
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "text", text: "実行します" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "touch perm-1.txt" } },
        ],
      },
    },
    meta,
  );
  assert.deepEqual(
    a?.blocks.map((b) => b.type),
    ["text", "tool_use"],
  );
  const use = a?.blocks[1];
  assert.ok(use?.type === "tool_use");
  assert.equal(use.summary, "touch perm-1.txt");

  // The summary is taken before the input is clipped, so long inputs still get one.
  const long = parseRecord(
    {
      type: "assistant",
      uuid: "a2",
      message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/x.ts", content: "a".repeat(5000) } }] },
    },
    meta,
  );
  const w = long?.blocks[0];
  assert.ok(w?.type === "tool_use");
  assert.equal(w.summary, "/x.ts");
  assert.ok(w.input.length < 2100);
  const r = parseRecord(
    {
      type: "user",
      uuid: "u2",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }], is_error: false }],
      },
    },
    meta,
  );
  assert.deepEqual(r?.blocks[0], { type: "tool_result", toolUseId: "toolu_1", content: "ok", isError: false });
});

test("metadata records update meta and are not entries", () => {
  const meta = emptyMeta();
  assert.equal(parseRecord({ type: "ai-title", aiTitle: "スマホからのテスト" }, meta), null);
  const pr = {
    type: "pr-link",
    prNumber: 5,
    prUrl: "https://github.com/4rtoflow/Nakamaba/pull/5",
    prRepository: "4rtoflow/Nakamaba",
  };
  parseRecord(pr, meta);
  parseRecord(pr, meta);
  parseRecord({ type: "bridge-session", bridgeSessionId: "cse_01ABC" }, meta);
  parseRecord({ type: "cost-state", totalCostUSD: 0.2 }, meta);
  assert.equal(meta.title, "スマホからのテスト");
  assert.equal(meta.prLinks.length, 1);
  assert.equal(meta.bridgeSessionId, "session_01ABC");
  assert.equal(meta.costUSD, 0.2);
});

test("isMeta records and account records are skipped", () => {
  const meta = emptyMeta();
  assert.equal(parseRecord({ type: "user", isMeta: true, message: { content: "caveat" } }, meta), null);
  assert.equal(parseRecord({ type: "session-owner", accountUuid: "x" }, meta), null);
});

test("toUrlSessionId maps cse_ to session_", () => {
  assert.equal(toUrlSessionId("cse_01X"), "session_01X");
  assert.equal(toUrlSessionId("session_01X"), "session_01X");
});

test("tail returns only complete lines, even when a multibyte character is split across writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "s.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ type: "user", uuid: "1", message: { content: "最初" } })}\n`);
    const { entries, consumed } = await readTranscript(file);
    assert.equal(entries.length, 1);

    const tail = new TranscriptTail(file, consumed);
    const meta = emptyMeta();
    const line = Buffer.from(
      `${JSON.stringify({ type: "assistant", uuid: "2", message: { content: [{ type: "text", text: "日本語の応答" }] } })}\n`,
    );
    const cut = line.indexOf(Buffer.from("本")) + 1; // inside the 3-byte character
    await fs.appendFile(file, line.subarray(0, cut));
    assert.deepEqual(await tail.poll(meta), []);
    await fs.appendFile(file, line.subarray(cut));
    const got = await tail.poll(meta);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0]?.blocks, [{ type: "text", text: "日本語の応答" }]);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("readTranscript ignores a partial last line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "s.jsonl");
    const full = `${JSON.stringify({ type: "user", uuid: "1", message: { content: "a" } })}\n`;
    await fs.writeFile(file, `${full}{"type":"user","uu`);
    const { entries, consumed } = await readTranscript(file);
    assert.equal(entries.length, 1);
    assert.equal(consumed, Buffer.byteLength(full));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
