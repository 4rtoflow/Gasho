import { Home } from "lucide-react";
import { useState } from "react";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarSection } from "@/components/ui/sidebar";
import { sessionLabel } from "@/lib/format";
import { go, useRoute } from "@/lib/route";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { HomeView } from "@/views/home";
import { SessionView } from "@/views/session";

const SEP = "\u001f";

function Brand() {
  const { collapsed } = useSidebar();
  return <div className="px-2.5 text-base font-semibold tracking-tight">{collapsed ? "G" : "Gasho"}</div>;
}

function Connection({ connected }: { connected: boolean }) {
  const { collapsed } = useSidebar();
  return (
    <div className="flex items-center gap-2 px-2.5 text-xs text-muted-foreground" title={connected ? "hub に接続中" : "hub に再接続しています"}>
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
      {!collapsed && (connected ? "接続中" : "再接続中…")}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { machines, notifications, connected } = useAppState();
  const [mobileOpen, setMobileOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;

  const sections: SidebarSection[] = [
    { items: [{ id: "home", label: "ホーム", icon: <Home />, badge: unread || undefined }] },
    ...machines.map((m) => ({
      title: m.connected ? m.name : `${m.name}（オフライン）`,
      items: m.sessions.map((s) => ({
        id: [m.name, s.sessionId].join(SEP),
        label: sessionLabel(s),
        icon: <StatusDot status={m.connected ? s.status : "unknown"} />,
        badge: m.connected && s.status === "waiting" ? "確認" : undefined,
      })),
    })),
  ];
  const activeId = route.name === "home" ? "home" : [route.machine, route.sessionId].join(SEP);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={(id) => {
          if (id === "home") return go({ name: "home" });
          const [machine, sessionId] = id.split(SEP);
          if (machine && sessionId) go({ name: "session", machine, sessionId });
        }}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
        header={<Brand />}
        footer={<Connection connected={connected} />}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger onClick={() => setMobileOpen(true)} />
          <span className="font-semibold">Gasho</span>
          <span className={cn("ml-auto size-2 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          {route.name === "home" ? (
            <HomeView />
          ) : (
            <SessionView key={`${route.machine}/${route.sessionId}`} machine={route.machine} sessionId={route.sessionId} />
          )}
        </main>
      </div>
    </div>
  );
}
