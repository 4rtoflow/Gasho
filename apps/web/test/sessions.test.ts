import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { worktreesByLastUse } from "../src/lib/sessions.ts";

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/repo",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});
const machine = (id: string, sessions: SessionInfo[]): MachineInfo => ({ id, name: id, connected: true, lastSeen: 0, sessions });

test("sessions are grouped by machine and worktree, the worktree used last first, and its tabs in the order they started", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const feat = { path: "/src/app-x", repo: "/src/app", branch: "feat/x" };
  const list = worktreesByLastUse([
    machine("mac", [
      session("a", { cwd: "/src/app/web", worktree: app, startedAt: 20, lastActivityAt: 300 }),
      session("b", { cwd: "/src/app", worktree: app, startedAt: 10, lastActivityAt: 100 }),
      session("c", { cwd: "/src/app-x", worktree: feat, startedAt: 30, lastActivityAt: 400 }),
    ]),
    // The same folder on another working server is another worktree.
    machine("ubuntu", [session("d", { cwd: "/src/app", worktree: app, startedAt: 40, lastActivityAt: 200 })]),
  ]);
  assert.deepEqual(
    list.map((w) => `${w.machine.id} ${w.label}: ${w.sessions.map((s) => s.sessionId).join(",")}`),
    ["mac feat/x: c", "mac main: b,a", "ubuntu main: d"],
  );
});

test("a worktree is named by its branch, else its folder, and its repository by GitHub, else the repository's folder", () => {
  const github = { owner: "4rtoflow", name: "Gasho", url: "https://github.com/4rtoflow/Gasho" };
  const list = worktreesByLastUse([
    machine("mac", [
      session("gh", { cwd: "/w/gasho", worktree: { path: "/w/gasho", repo: "/w/gasho", branch: "main" }, github, lastActivityAt: 5 }),
      session("detached", { cwd: "/w/lib-old", worktree: { path: "/w/lib-old", repo: "/w/lib.git" }, lastActivityAt: 4 }),
      // A folder that is not in a repository, or a gasho-daemon older than 0.15.0: the session's folder.
      session("plain", { cwd: "/w/notes", lastActivityAt: 3 }),
      session("rc", { cwd: "/w/other", lastActivityAt: 9, managed: undefined }),
    ]),
  ]);
  assert.deepEqual(
    list.map((w) => [w.label, w.repo]),
    [
      ["main", "Gasho"],
      ["lib-old", "lib"],
      ["notes", undefined],
    ],
  );
});
