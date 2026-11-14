import type { GitHubRepo, SessionInfo, SessionStatus } from "@gasho/protocol";
import type { BadgeTone } from "@/components/ui/badge";

const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

export function relativeTime(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "-";
  const sec = (ms - now) / 1000;
  const abs = Math.abs(sec);
  if (abs < 45) return "たった今";
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86400), "day");
}

export function clockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  busy: "作業中",
  waiting: "確認待ち",
  idle: "待機中",
  unknown: "不明",
};

export const STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  busy: "success",
  waiting: "warning",
  idle: "neutral",
  unknown: "neutral",
};

/** What a waiting session waits for, from what `claude agents` says ("input needed": Claude's question, for one). */
export function waitingLabel(waitingFor: string | undefined): string | undefined {
  if (!waitingFor) return undefined;
  return { "permission prompt": "権限の確認", "input needed": "回答待ち" }[waitingFor] ?? waitingFor;
}

/** …and on the home screen, a question or a plan as such, when Gasho holds it (see PermissionRequestInfo). */
export function waitingText(s: SessionInfo): string {
  const requests = s.permissionRequests ?? [];
  const last = requests[requests.length - 1];
  if (last?.toolName === "AskUserQuestion") return "質問への回答を待っています";
  if (last?.toolName === "ExitPlanMode") return "計画の承認を待っています";
  return waitingLabel(s.waitingFor) ?? "確認を待っています";
}

export function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function sessionLabel(s: SessionInfo): string {
  // Sessions started from Gasho show the name the user gave them rather than the generated title.
  if (s.managed && s.name) return s.name;
  return s.title || s.name || basename(s.cwd) || s.sessionId.slice(0, 8);
}

export function repoLabel(s: SessionInfo): string {
  return s.github ? `${s.github.owner}/${s.github.name}` : basename(s.cwd);
}

/** Claude Code records "HEAD" outside git repositories; hide it there. */
export function branchLabel(s: SessionInfo): string | undefined {
  if (!s.gitBranch || (s.gitBranch === "HEAD" && !s.github)) return undefined;
  return s.gitBranch;
}

export function formatCost(usd: number | undefined): string | undefined {
  return usd === undefined ? undefined : `$${usd.toFixed(2)}`;
}

/** A branch on GitHub. Each path segment is encoded, so "feat/x" stays a path like GitHub's own links. */
export function githubTreeUrl(repo: GitHubRepo, branch: string): string {
  return `${repo.url}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

export function githubCommitUrl(repo: GitHubRepo, hash: string): string {
  return `${repo.url}/commit/${encodeURIComponent(hash)}`;
}
