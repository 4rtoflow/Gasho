import { Home, KeyRound } from "lucide-react";
import { useState } from "react";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarSection } from "@/components/ui/sidebar";
import { sessionLabel } from "@/lib/format";
import { go, useRoute } from "@/lib/route";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DevicesView } from "@/views/devices";
import { GraphView } from "@/views/graph";
import { HomeView } from "@/views/home";
import { PairView } from "@/views/pair";
import { SessionView } from "@/views/session";

const SEP = "\u001f";

function Brand() {
  const { collapsed } = useSidebar();
  return <div className="px-2.5 text-base font-semibold tracking-tight">{collapsed ? "G" : "Gasho"}</div>;
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

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read).length;
  const sections: SidebarSection[] = [
    {
      items: [
        { id: "home", label: "ホーム", icon: <Home />, badge: unread || undefined },
        { id: "devices", label: "端末", icon: <KeyRound /> },
      ],
    },
    ...machines.map((m) => ({
      title: m.connected ? m.name : `${m.name}（オフライン）`,
      items: m.sessions.map((s) => ({
        id: [m.id, s.sessionId].join(SEP),
        label: sessionLabel(s),
        icon: <StatusDot status={m.connected ? s.status : "unknown"} />,
        badge: m.connected && s.status === "waiting" ? "確認" : undefined,
      })),
    })),
  ];
  const activeId = route.name === "session" || route.name === "graph" ? [route.machine, route.sessionId].join(SEP) : route.name;

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
          <span className="font-semibold">Gasho</span>
          {/* The connection shows in the sidebar's footer; here only while it is down. */}
          {!connected && <span className="ml-auto text-xs text-red-400">再接続中…</span>}
          {route.name === "session" && <SessionHeaderToggle className={cn("-mr-1", connected && "ml-auto")} />}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          {route.name === "home" && <HomeView />}
          {route.name === "devices" && <DevicesView />}
          {route.name === "session" && (
            <SessionView key={`${route.machine}/${route.sessionId}`} machine={route.machine} sessionId={route.sessionId} />
          )}
          {route.name === "graph" && <GraphView key={`${route.machine}/${route.sessionId}`} machine={route.machine} sessionId={route.sessionId} />}
        </main>
      </div>
    </div>
  );
}
