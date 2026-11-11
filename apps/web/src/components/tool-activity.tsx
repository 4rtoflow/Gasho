// Shows the tool calls of a session with easyui.site's AIAgentActivity.
import { useMemo } from "react";
import type { TranscriptEntry } from "@gasho/protocol";
import { AIAgentActivity, type ActivityStatus, type ActivityType, type AgentActivityItemData } from "@/components/ui/ai-agent-activity";
import { clockTime } from "@/lib/format";
import { toolSummary } from "./transcript";

const MAX_ITEMS = 100;

function activityType(tool: string): ActivityType {
  if (tool === "Bash" || tool === "PowerShell") return "code_execution";
  if (tool === "Read") return "reading";
  if (tool === "Grep" || tool === "Glob" || tool === "WebSearch" || tool === "ToolSearch") return "searching";
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "writing";
  if (tool === "WebFetch" || tool.startsWith("mcp__")) return "api_request";
  return "tool_execution";
}

export function toolActivities(entries: TranscriptEntry[], busy: boolean): AgentActivityItemData[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const e of entries) {
    for (const b of e.blocks) {
      if (b.type === "tool_result" && b.toolUseId) results.set(b.toolUseId, { content: b.content, isError: b.isError });
    }
  }
  const items: AgentActivityItemData[] = [];
  for (const e of entries) {
    for (const b of e.blocks) {
      if (b.type !== "tool_use") continue;
      const r = b.id ? results.get(b.id) : undefined;
      const status: ActivityStatus = r ? (r.isError ? "error" : "success") : busy ? "running" : "pending";
      items.push({
        id: b.id ?? `${e.uuid}-${items.length}`,
        type: activityType(b.name),
        title: b.name,
        description: b.summary ?? toolSummary(b.input),
        status,
        timestamp: clockTime(e.ts),
        details: { input: b.input, output: r?.content },
      });
    }
  }
  // Only the newest call can still be running; older calls without a result were cut off or interrupted.
  for (let i = 0; i < items.length - 1; i++) {
    const item = items[i];
    if (item && item.status === "running") item.status = "cancelled";
  }
  return items.slice(-MAX_ITEMS);
}

export function ToolActivity({ entries, busy, agentName }: { entries: TranscriptEntry[]; busy: boolean; agentName: string }) {
  const activities = useMemo(() => toolActivities(entries, busy), [entries, busy]);
  if (activities.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">読み込んだ範囲にツールの実行はありません</p>;
  }
  return <AIAgentActivity activities={activities} isRunning={busy} title="ツールの実行" agentName={agentName} />;
}
