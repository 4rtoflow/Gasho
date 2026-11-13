import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptEntry } from "@gasho/protocol";
import { pendingShown, recorded, SENT_GRACE_MS, type PendingMessage } from "../src/lib/pending.ts";

const message = (text: string, extra: Partial<PendingMessage> = {}): PendingMessage => ({
  id: "p1",
  text,
  files: [],
  after: 2,
  state: "sending",
  at: 1_000,
  ...extra,
});
const entry = (role: TranscriptEntry["role"], text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `${role}-${text}`,
  role,
  blocks: [{ type: "text", text }],
  ...extra,
});

test("a message is recorded once an entry after the ones the conversation had when it was sent holds it", () => {
  const p = message("テストを直して\nCI も通して");
  const before = [entry("user", "テストを直して\nCI も通して"), entry("assistant", "直しました")];
  // The same text sent earlier does not count.
  assert.equal(recorded(p, before, 0), false);
  // /model switched the model first: its notes come before the message.
  const after = [...before, entry("system", "/model"), entry("system", "Set model to Opus 5.5 for this session only")];
  assert.equal(recorded(p, after, 0), false);
  // Claude Code may lay out the spaces and line breaks differently.
  assert.equal(recorded(p, [...after, entry("user", "テストを直して CI も通して")], 0), true);
  // An older page loaded since puts entries before the ones loaded then: entries[0] is now entry 8 of the
  // conversation, and the message was sent when it had 12.
  const sent = message("テストを直して\nCI も通して", { after: 12 });
  const loaded = [entry("user", "前の話"), entry("assistant", "前の返事"), ...after, entry("user", "テストを直して\nCI も通して")];
  assert.equal(recorded(sent, loaded, 8), true);
  assert.equal(recorded(sent, loaded.slice(0, 6), 8), false);
});

test("tool results, a subagent's messages and Claude's replies do not count as the message", () => {
  const p = message("ls を見て", { after: 0 });
  assert.equal(recorded(p, [entry("assistant", "ls を見て")], 0), false);
  assert.equal(recorded(p, [entry("user", "ls を見て", { isSidechain: true })], 0), false);
  const result: TranscriptEntry = { uuid: "r", role: "user", blocks: [{ type: "tool_result", toolUseId: "t", content: "ls を見て", isError: false }] };
  assert.equal(recorded(p, [result], 0), false);
});

test("files sent alone, shell commands and slash commands are recognized as Claude Code records them", () => {
  const files = message("", { after: 0, files: ["a.png"] });
  assert.equal(recorded(files, [entry("user", "@/home/u/.local/share/gasho/attachments/s1/20261113T100000-1-a.png")], 0), true);
  assert.equal(recorded(files, [entry("user", "別の話")], 0), false);
  // A text with files: the text, then the files' paths.
  const both = message("この画像を見て", { after: 0, files: ["a.png"] });
  assert.equal(recorded(both, [entry("user", "この画像を見て\n\n@/x/gasho/attachments/s1/1-a.png")], 0), true);
  const shell = message("!git status", { after: 0 });
  assert.equal(recorded(shell, [entry("user", "<bash-input>git status</bash-input>")], 0), true);
  const slash = message("/effort ultracode on", { after: 0 });
  assert.equal(recorded(slash, [entry("system", "/effort ultracode on")], 0), true);
  // A note is the message only for a slash command, and only when it starts with it.
  assert.equal(recorded(message("ok", { after: 0 }), [entry("system", "Kept model as Opus 5.5 (token budget ok)")], 0), false);
  assert.equal(recorded(slash, [entry("system", "Ultracode on: /effort ultracode on")], 0), false);
});

test("a message waiting on the working server is shown while the session has messages waiting there", () => {
  const queued = message("あとで", { state: "queued", at: 1_000 });
  assert.equal(pendingShown(queued, [], 0, 1, 1_000 + 10 * SENT_GRACE_MS), true);
  // No count seen: for a while after it was queued.
  assert.equal(pendingShown(queued, [], 0, 0, 1_000 + SENT_GRACE_MS - 1), true);
  assert.equal(pendingShown(queued, [], 0, 0, 1_000 + SENT_GRACE_MS), false);
  // Sending and sent ones are shown until the conversation shows them (a sent one is removed after a while).
  assert.equal(pendingShown(message("あとで"), [], 0, 0, 1_000 + 10 * SENT_GRACE_MS), true);
  assert.equal(pendingShown(message("あとで", { after: 0 }), [entry("user", "あとで")], 0, 0, 1_000), false);
});
