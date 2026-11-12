// "複数のリポジトリ…" in the session header: a popup listing the repositories inside the session's folder.
// Picking one opens it on GitHub.
import { ExternalLink } from "lucide-react";
import { Popover } from "radix-ui";
import type { SessionRepo } from "@gasho/protocol";
import { cn } from "@/lib/utils";

export function RepoPicker({ repos }: { repos: SessionRepo[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="リポジトリを選んで GitHub で開く"
          className="underline-offset-2 hover:text-foreground hover:underline data-[state=open]:text-foreground"
        >
          複数のリポジトリ…
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-surface p-1.5 text-sm shadow-xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">リポジトリ（{repos.length}）</p>
          <ul className="max-h-80 overflow-y-auto">
            {repos.map((r) => (
              <li key={r.path}>
                {r.github ? (
                  <Popover.Close asChild>
                    <a
                      href={r.github.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-raised"
                    >
                      <RepoText repo={r} />
                      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                    </a>
                  </Popover.Close>
                ) : (
                  <div className="flex items-center gap-2 px-2 py-1.5" title="GitHub のリモート（origin）がありません">
                    <RepoText repo={r} muted />
                    <span className="shrink-0 text-xs text-muted-foreground">GitHub なし</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RepoText({ repo: r, muted = false }: { repo: SessionRepo; muted?: boolean }) {
  const detail = [r.github && `${r.github.owner}/${r.github.name}`, r.branch].filter(Boolean).join(" · ");
  return (
    <span className="min-w-0 flex-1">
      <span className={cn("block truncate font-medium", muted ? "text-muted-foreground" : "text-foreground")}>{r.path}</span>
      {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}
