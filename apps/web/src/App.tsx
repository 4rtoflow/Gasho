import { Home, KeyRound, Plus } from "lucide-react";
import { useState, type ReactElement } from "react";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { SessionActionDialog, SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarSection } from "@/components/ui/sidebar";
import { sessionLabel } from "@/lib/format";
import { DESKTOP, useMediaQuery } from "@/lib/media";
import { go, useRoute, type SessionPanel } from "@/lib/route";
import { notificationShown, sessionsByLastUse } from "@/lib/sessions";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DevicesView } from "@/views/devices";
import { GitHubItemPanel } from "@/views/github-item";
import { GitHubListPanel } from "@/views/github-list";
import { GraphPanel } from "@/views/graph";
import { HomeView } from "@/views/home";
import { LaunchDialog } from "@/views/launch";
import { PairView } from "@/views/pair";
import { SessionView } from "@/views/session";

const SEP = "\u001f";

/** Gasho's logo: 🙏 (合掌, gasshō). The collapsed sidebar shows the logo alone. */
export const LOGO = "🙏";

function Brand() {
  const { collapsed } = useSidebar();
  return (
    <div className="flex items-center gap-2 px-2.5 text-base font-semibold tracking-tight">
      <span aria-hidden className="font-emoji text-lg leading-none">
        {LOGO}
      </span>
      {!collapsed && <span>Gasho</span>}
    </div>
  );
}

/** A panel of a session (see SidePanel): beside it on a computer (`docked`), in its place on a phone. */
function PanelView({ machine, sessionId, panel, docked }: { machine: string; sessionId: string; panel: SessionPanel; docked: boolean }) {
  // Back to the session, replacing the panel in the history.
  const close = () => go({ name: "session", machine, sessionId }, { replace: true });
  if (panel.kind === "graph") return <GraphPanel machine={machine} sessionId={sessionId} repo={panel.repo} docked={docked} onClose={close} />;
  if (panel.number !== undefined) {
    return (
      <GitHubItemPanel
        key={`${panel.kind}/${panel.number}`}
        machine={machine}
        sessionId={sessionId}
        kind={panel.kind}
        number={panel.number}
        repo={panel.repo}
        docked={docked}
        onClose={close}
      />
    );
  }
  return <GitHubListPanel machine={machine} sessionId={sessionId} kind={panel.kind} repo={panel.repo} docked={docked} onClose={close} />;
}

function Connection({ connected, deviceName }: { connected: boolean; deviceName?: string }) {
  const { collapsed } = useSidebar();
  return (
    <div
      className="flex items-center gap-2 px-2.5 text-xs text-muted-foreground"
      title={connected ? "Gasho サーバーに接続中" : "Gasho サーバーに再接続しています"}
    >
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
      {!collapsed && (
        <span className="truncate">
          {connected ? "接続中" : "再接続中…"}
          {deviceName && ` · ${deviceName}`}
        </span>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-sm text-muted-foreground">{children}</div>;
}

export function App() {
  const route = useRoute();
  const { auth, me, machines, notifications, connected } = useAppState();
  const [mobileOpen, setMobileOpen] = useState(false);
  // What was picked from a session's menu in the sidebar (rename, fork, remove); its dialog is open meanwhile.
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  // The dialog that starts a new session, opened from the "＋" of the sidebar's session list.
  const [launchOpen, setLaunchOpen] = useState(false);
  const desktop = useMediaQuery(DESKTOP);

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines)).length;
  // The sessions of all working servers in one list, the one used last first.
  const sessions = sessionsByLastUse(machines);
  const sections: SidebarSection[] = [
    {
      items: [
        { id: "home", label: "ホーム", icon: <Home />, badge: unread || undefined },
        { id: "devices", label: "端末", icon: <KeyRound /> },
      ],
    },
    {
      // Shown even without sessions, for its "＋".
      title: "セッション",
      action: { label: "新しいセッション", icon: <Plus />, onClick: () => setLaunchOpen(true) },
      items: sessions.map(({ machine: m, session: s }) => ({
        id: [m.id, s.sessionId].join(SEP),
        label: sessionLabel(s),
        icon: <StatusDot status={m.connected ? s.status : "unknown"} />,
        badge: !m.connected ? "オフライン" : s.status === "waiting" ? "確認" : undefined,
        // Right-click (a long press on a phone): rename, fork, remove.
        wrap: (button: ReactElement) => (
          <SessionContextMenu machine={m} session={s} onPick={setSessionAction}>
            {button}
          </SessionContextMenu>
        ),
      })),
    },
  ];
  const activeId = route.name === "session" ? [route.machine, route.sessionId].join(SEP) : route.name;
  const panel = route.name === "session" ? route.panel : undefined;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={(id) => {
          if (id === "home" || id === "devices") return go({ name: id });
          const [machine, sessionId] = id.split(SEP);
          if (machine && sessionId) go({ name: "session", machine, sessionId });
        }}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
        header={<Brand />}
        footer={<Connection connected={connected} deviceName={me?.name} />}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger onClick={() => setMobileOpen(true)} />
          <span className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden className="font-emoji">
              {LOGO}
            </span>
            Gasho
          </span>
          {/* The connection shows in the sidebar's footer; here only while it is down. */}
          {!connected && <span className="ml-auto text-xs text-red-400">再接続中…</span>}
          {route.name === "session" && !panel && <SessionHeaderToggle className={cn("-mr-1", connected && "ml-auto")} />}
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {route.name === "home" && <HomeView />}
            {route.name === "devices" && <DevicesView />}
            {route.name === "session" && (desktop || !panel) && (
              <SessionView key={`${route.machine}/${route.sessionId}`} machine={route.machine} sessionId={route.sessionId} panel={panel} />
            )}
            {route.name === "session" && !desktop && panel && (
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked={false} />
            )}
          </main>
          {route.name === "session" && desktop && panel && (
            <aside className="w-[clamp(380px,40vw,620px)] shrink-0 border-l border-border bg-background">
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked />
            </aside>
          )}
        </div>
      </div>
      <SessionActionDialog request={sessionAction} onClose={() => setSessionAction(null)} onNavigate={() => setMobileOpen(false)} />
      <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} onLaunched={() => setMobileOpen(false)} />
    </div>
  );
}
