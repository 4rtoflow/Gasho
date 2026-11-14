import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compactSummaryText,
  emptyMeta,
  modelLabel,
  parseRecord,
  pastConversations,
  projectDirName,
  readTranscript,
  toUrlSessionId,
  TranscriptTail,
  unwrapPasted,
} from "../src/transcript.ts";

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

test("long texts are sent whole: an answer with diagrams, a message sent from Gasho; only a runaway text is cut", () => {
  const textOf = (e: ReturnType<typeof parseRecord>): string | undefined => {
    const b = e?.blocks[0];
    return b?.type === "text" ? b.text : undefined;
  };
  // An answer with diagrams and tables: one of 8,229 characters was cut at 4,000, in the middle of a diagram.
  const answer = "│ 図の行 │\n".repeat(1000);
  const a = parseRecord({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: answer }] } }, emptyMeta());
  assert.equal(textOf(a), answer);
  // Gasho sends messages of up to 20,000 characters.
  const message = "あ".repeat(20000);
  const u = parseRecord({ type: "user", uuid: "u1", message: { role: "user", content: message } }, emptyMeta());
  assert.equal(textOf(u), message);
  // Past 40,000 characters, the rest is left out and how much is noted.
  const runaway = "x".repeat(40010);
  const r = parseRecord({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: runaway }] } }, emptyMeta());
  assert.equal(textOf(r), `${"x".repeat(40000)}… (+10 chars)`);
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

// Records as Claude Code v2.1.322 writes them.
test("slash commands and their output become notes, and a model switch updates the session's model", () => {
  const meta = emptyMeta();
  const command = parseRecord(
    {
      type: "user",
      uuid: "c1",
      message: {
        role: "user",
        content: "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>",
      },
    },
    meta,
  );
  assert.deepEqual(command?.role, "system");
  assert.deepEqual(command?.blocks, [{ type: "text", text: "/model sonnet" }]);
  const output = parseRecord(
    { type: "user", uuid: "c2", message: { role: "user", content: "<local-command-stdout>Set model to `Haiku 5.5` for this session only</local-command-stdout>" } },
    meta,
  );
  assert.deepEqual(output?.role, "system");
  assert.deepEqual(output?.blocks, [{ type: "text", text: "Set model to `Haiku 5.5` for this session only" }]);
  assert.equal(meta.model, "Haiku 5.5");
  parseRecord({ type: "user", uuid: "c3", message: { role: "user", content: "<local-command-stdout>Kept model as `Haiku 5.5`</local-command-stdout>" } }, meta);
  assert.equal(meta.model, "Haiku 5.5");
});

test("the model comes from the model attachment and from replies, but not from subagents", () => {
  const meta = emptyMeta();
  parseRecord({ type: "attachment", attachment: { type: "model", identity: { modelId: "claude-opus-5-5", marketingName: "Opus 5.5" } } }, meta);
  assert.equal(meta.model, "Opus 5.5");
  parseRecord({ type: "assistant", uuid: "a1", isSidechain: true, message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "x" }] } }, meta);
  assert.equal(meta.model, "Opus 5.5");
  parseRecord({ type: "assistant", uuid: "a2", message: { model: "claude-fable-5-1", content: [{ type: "text", text: "y" }] } }, meta);
  assert.equal(meta.model, "Fable 5.1");
  parseRecord({ type: "assistant", uuid: "a3", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } }, meta);
  assert.equal(meta.model, "Fable 5.1");
  assert.equal(modelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("gpt-x"), "gpt-x");
});

test("text pasted into Claude Code is shown without its wrapper", () => {
  const entry = parseRecord(
    { type: "user", uuid: "p1", message: { role: "user", content: '\n\n<pasted_content id="9546">\n一行目\n\n@/home/rg/x.png\n</pasted_content>' } },
    emptyMeta(),
  );
  assert.deepEqual(entry?.blocks, [{ type: "text", text: "一行目\n\n@/home/rg/x.png" }]);
  assert.equal(unwrapPasted("前 <pasted_content id=\"1\">中</pasted_content> 後"), "前 中 後");
  // Claude Code v2.1.322 repeats the id in the closing tag.
  assert.equal(unwrapPasted('<pasted_content id="9546">\n一行目\n@/x.png\n</pasted_content id="9546">'), "一行目\n@/x.png");
});

test("commands recorded as system records are notes too", () => {
  const meta = emptyMeta();
  const entry = parseRecord(
    { type: "system", subtype: "local_command", uuid: "s1", content: "<local-command-stdout>Kept model as `Sonnet 5.5`</local-command-stdout>" },
    meta,
  );
  assert.deepEqual(entry?.blocks, [{ type: "text", text: "Kept model as `Sonnet 5.5`" }]);
  const command = parseRecord(
    { type: "system", subtype: "local_command", uuid: "s2", content: "<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args></command-args>" },
    meta,
  );
  assert.deepEqual(command?.blocks, [{ type: "text", text: "/model" }]);
});

test("the effort level comes from replies and from /effort and /model output; ultracode from /effort ultracode", () => {
  const meta = emptyMeta();
  parseRecord({ type: "assistant", uuid: "a", effort: "medium", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "はい" }] } }, meta);
  assert.equal(meta.effort, "medium");
  const out = (text: string) => parseRecord({ type: "user", uuid: text, message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } }, meta);
  out("Set effort level to high (saved as your default for new sessions): Comprehensive implementation");
  assert.equal(meta.effort, "high");
  out("Ultracode on (this session only): dynamic workflows on every task. Effort stays high.");
  assert.equal(meta.ultracode, true);
  out("Set model to `Sonnet 5.5 (default)` for this session only with `xhigh` effort");
  assert.equal(meta.effort, "xhigh");
  assert.equal(meta.model, "Sonnet 5.5 (default)");
  out("Ultracode off. Effort stays xhigh.");
  assert.equal(meta.ultracode, false);
  assert.equal(meta.effort, "xhigh");
});

test("session-only model switches are counted, so a new one can be told from earlier ones", () => {
  const meta = emptyMeta();
  const out = (text: string) => parseRecord({ type: "user", uuid: text, message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } }, meta);
  out("Set model to `Sonnet 5.5` and saved as your default for new sessions");
  assert.equal(meta.sessionSwitches, undefined);
  out("Set model to `Haiku 5.5` for this session only with `high` effort");
  out("Kept model as `Haiku 5.5`");
  out("Set model to `Sonnet 5.5 (default)` for this session only");
  assert.equal(meta.sessionSwitches, 2);
});

test("the name given with /rename or --name is recorded as custom-title, and the last one counts", () => {
  const meta = emptyMeta();
  assert.equal(parseRecord({ type: "custom-title", customTitle: "フォークの試し", sessionId: "s1" }, meta), null);
  assert.equal(meta.customTitle, "フォークの試し");
  parseRecord({ type: "custom-title", customTitle: "  調査 その2 " }, meta);
  assert.equal(meta.customTitle, "調査 その2");
  // Nothing usable: the name stays.
  parseRecord({ type: "custom-title", customTitle: "   " }, meta);
  parseRecord({ type: "custom-title" }, meta);
  assert.equal(meta.customTitle, "調査 その2");
  // The title Claude Code generates is another thing.
  parseRecord({ type: "ai-title", aiTitle: "テストの整理" }, meta);
  assert.equal(meta.customTitle, "調査 その2");
  assert.equal(meta.title, "テストの整理");
});

// Records as Claude Code v2.1.323 writes them when it compacts the conversation.
test("a compaction is a mark and a summary, not something the user said", () => {
  const meta = emptyMeta();
  const mark = parseRecord(
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      isMeta: false,
      uuid: "m1",
      timestamp: "2026-11-13T16:47:18.040Z",
      level: "info",
      compactMetadata: { trigger: "auto", preTokens: 237557 },
    },
    meta,
  );
  assert.deepEqual(mark, {
    uuid: "m1",
    ts: "2026-11-13T16:47:18.040Z",
    role: "system",
    blocks: [{ type: "text", text: "Conversation compacted" }],
    isSidechain: false,
    compaction: "mark",
  });
  const content =
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n" +
    "<system-reminder>\n<tools-used-before-summary>Bash, Read</tools-used-before-summary>\n</system-reminder>\n" +
    "Summary:\n## 依頼\n- 連続したツールをまとめる\n\n" +
    "If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /home/u/.claude/projects/x/s.jsonl\n" +
    "Continue the conversation from where it left off without asking the user any further questions.\n\n" +
    "The messages after this summary are the most recent messages from before compaction, kept verbatim.";
  const summary = parseRecord(
    { type: "user", uuid: "s1", parentUuid: "m1", isVisibleInTranscriptOnly: true, isCompactSummary: true, message: { role: "user", content } },
    meta,
  );
  assert.equal(summary?.role, "system");
  assert.equal(summary?.compaction, "summary");
  assert.deepEqual(summary?.blocks, [{ type: "text", text: "## 依頼\n- 連続したツールをまとめる" }]);
});

test("the summary of a compaction keeps text of another shape, and lines it quotes", () => {
  assert.equal(compactSummaryText("  要約だけ  "), "要約だけ");
  const quoted = "Summary:\n- 次の行で終わる:\n\nIf you need specific details from before compaction (quoted)\n- 続き";
  assert.equal(
    compactSummaryText(`前置き\n${quoted}\n\nIf you need specific details from before compaction, read …`),
    "- 次の行で終わる:\n\nIf you need specific details from before compaction (quoted)\n- 続き",
  );
  // "Summary:" counts only near the start; later, it is part of the summary.
  const late = `${"x".repeat(3000)}\nSummary:\nmore`;
  assert.equal(compactSummaryText(late), late);
  // Claude Code v2.1.323 once left the model's closing tag in.
  assert.equal(compactSummaryText("前置き\nSummary:\n1. 依頼\n</summary>\n\nIf you need specific details from before compaction …"), "1. 依頼");
});

test("Claude's latest question is kept whole while it has no answer: its result or a new message clears it", () => {
  const meta = emptyMeta();
  const long = "x".repeat(3000);
  const input = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: long }, { label: "Blue" }] }] };
  const ask = (id: string, extra: Record<string, unknown> = {}) =>
    parseRecord(
      {
        type: "assistant",
        uuid: `a-${id}`,
        timestamp: "2026-11-14T07:53:36.089Z",
        message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input }] },
        ...extra,
      },
      meta,
    );
  const result = (id: string) =>
    parseRecord({ type: "user", uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "answered" }] } }, meta);

  const e = ask("toolu_1");
  // The entry shows the input clipped; the question is kept whole, to answer it by.
  assert.ok(e?.blocks[0]?.type === "tool_use" && e.blocks[0].input.length < 3000);
  assert.deepEqual(meta.question, { toolUseId: "toolu_1", input, at: Date.parse("2026-11-14T07:53:36.089Z") });
  // Another call's result leaves it; its own clears it.
  result("toolu_other");
  assert.equal(meta.question?.toolUseId, "toolu_1");
  result("toolu_1");
  assert.equal(meta.question, undefined);

  ask("toolu_2");
  parseRecord({ type: "user", uuid: "u", message: { role: "user", content: "やっぱり別の案で" } }, meta);
  assert.equal(meta.question, undefined);
  // A subagent's question is not the session's.
  ask("toolu_3", { isSidechain: true });
  assert.equal(meta.question, undefined);
});

test("past conversations: a folder's, by the folder their records give, the latest first, with their name or title", async () => {
  const claude = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  const write = async (folder: string, id: string, records: object[], mtime: number) => {
    const dir = path.join(claude, "projects", projectDirName(folder));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await fs.utimes(file, mtime, mtime);
  };
  const said = (cwd: string, text: string) => ({ type: "user", cwd, message: { role: "user", content: text } });
  await write("/w/app", "named", [said("/w/app", "最初の発言"), { type: "ai-title", aiTitle: "題" }, { type: "custom-title", customTitle: "付けた名前" }], 100);
  await write("/w/app", "titled", [said("/w/app", "最初の発言"), { type: "ai-title", aiTitle: "Claude Code の題" }], 300);
  await write("/w/app", "untitled", [{ type: "user", cwd: "/w/app", isMeta: true, message: { content: "<command-name>/x</command-name>" } }, said("/w/app", "<b>直して</b> ください")], 200);
  await write("/w/app/web", "inside", [said("/w/app/web", "画面")], 400);
  // "/w/app-x" has the same directory name as "/w/app/x": its records tell them apart.
  await write("/w/app-x", "other", [said("/w/app-x", "別の worktree")], 500);
  await write("/w/app", "empty", [{ type: "file-history-snapshot", cwd: "/w/app" }], 600);
  await write("/w/app", "running", [said("/w/app", "動いている")], 700);

  const open = new Set(["running"]);
  const top = await pastConversations(claude, "/w/app", { open });
  assert.deepEqual(
    top.map((c) => [c.sessionId, c.title]),
    [
      ["titled", "Claude Code の題"],
      ["untitled", "直して ください"],
      ["named", "付けた名前"],
    ],
  );
  const all = await pastConversations(claude, "/w/app", { open, subfolders: true });
  assert.deepEqual(
    all.map((c) => `${c.sessionId} ${c.cwd}`),
    ["inside /w/app/web", "titled /w/app", "untitled /w/app", "named /w/app"],
  );
  assert.equal(all[0]?.lastActivityAt, 400_000);
});
