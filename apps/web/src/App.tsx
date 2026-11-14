import { motion } from "framer-motion";
import { Home, KeyRound, ListRestart, Plus, Puzzle, Settings } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { SessionActionDialog, SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarSection } from "@/components/ui/sidebar";
import { sessionLabel } from "@/lib/format";
import { DESKTOP, useMediaQuery } from "@/lib/media";
import { arrangeSessions, rememberSessions, useSavedOrder } from "@/lib/order";
import { go, isOldGitHubLink, useRoute, type SessionPanel } from "@/lib/route";
import { notificationShown, sessionsByLastUse } from "@/lib/sessions";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PluginBadgeProbes, PluginPageView, PluginPanelView, usePluginBadges } from "@/plugins/parts";
import { usePluginRegistry } from "@/plugins/registry";
import { DevicesView } from "@/views/devices";
import { FilePanel, FolderPanel } from "@/views/files";
import { GraphPanel } from "@/views/graph";
import { HomeView } from "@/views/home";
import { LaunchDialog } from "@/views/launch";
import { PairView } from "@/views/pair";
import { PluginsView } from "@/views/plugins";
import { SessionState, SessionView } from "@/views/session";
import { SettingsView } from "@/views/settings";

const SEP = "\u001f";
/** Where this browser keeps the order the sidebar's sessions were dragged into. */
const SESSION_ORDER_KEY = "gasho.sessionOrder";

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
  if (panel.kind === "plugin") return <PluginPanelView machine={machine} sessionId={sessionId} panel={panel} docked={docked} onClose={close} />;
  if (panel.kind === "graph") return <GraphPanel machine={machine} sessionId={sessionId} repo={panel.repo} docked={docked} onClose={close} />;
  // A folder or a file starts afresh when another one opens.
  if (panel.kind === "files") {
    const path = panel.path ?? "";
    return <FolderPanel key={path} machine={machine} sessionId={sessionId} path={path} docked={docked} onClose={close} />;
  }
  const path = panel.path ?? "";
  return <FilePanel key={path} machine={machine} sessionId={sessionId} path={path} docked={docked} onClose={close} />;
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
  // A link from before the GitHub plugin (…/issues, …/pull/<n>) opens the plugin's panel; the address bar gets its URL.
  useEffect(() => {
    if (isOldGitHubLink(location.hash)) go(route, { replace: true });
  }, [route]);
  const { auth, me, machines, notifications, connected } = useAppState();
  const [mobileOpen, setMobileOpen] = useState(false);
  // What was picked from a session's menu in the sidebar (rename, fork, remove); its dialog is open meanwhile.
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  // The dialog that starts a new session, opened from the "＋" of the sidebar's session list.
  const [launchOpen, setLaunchOpen] = useState(false);
  // The order the sidebar's sessions were dragged into (none: the one used last first).
  const [sessionOrder, setSessionOrder] = useSavedOrder(SESSION_ORDER_KEY);
  const desktop = useMediaQuery(DESKTOP);
  // The plugins' web parts (docs/plugins.md): their sidebar items and the badges their hooks give.
  const { parts } = usePluginRegistry();
  const badges = usePluginBadges();

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines)).length;
  // The sessions of all working servers in one list: the one used last first, or in the order they were dragged into
  // (sessions started or forked since then come first).
  const byId = new Map(sessionsByLastUse(machines).map((x) => [[x.machine.id, x.session.sessionId].join(SEP), x]));
  const sessions = arrangeSessions([...byId.keys()], sessionOrder).flatMap((id) => {
    const x = byId.get(id);
    return x ? [{ id, ...x }] : [];
  });
  // The plugins' sidebar items: between ホーム and 端末, in the plugins' order. Each opens a page of its plugin.
  const pluginItems = parts.flatMap(({ info, def }) =>
    (def.sidebar ?? []).map((item) => {
      const Icon = item.icon;
      const id = `plugin:${info.id}:${item.id}`;
      return { id, label: item.label, icon: <Icon />, badge: badges.get(id), plugin: info.id, page: item.page };
    }),
  );
  const sections: SidebarSection[] = [
    {
      items: [
        { id: "home", label: "ホーム", icon: <Home />, badge: unread || undefined },
        ...pluginItems.map(({ id, label, icon, badge }) => ({ id, label, icon, badge })),
        { id: "devices", label: "端末", icon: <KeyRound /> },
        { id: "plugins", label: "プラグイン", icon: <Puzzle /> },
        { id: "settings", label: "設定", icon: <Settings /> },
      ],
    },
    {
      // Shown even without sessions, for its "＋".
      title: "セッション",
      action: { label: "新しいセッション", icon: <Plus />, onClick: () => setLaunchOpen(true) },
      secondaryAction: sessionOrder
        ? { label: "最後に使った順に戻す", icon: <ListRestart />, onClick: () => setSessionOrder(undefined) }
        : undefined,
      sort: { onReorder: (ids) => setSessionOrder(rememberSessions(ids, sessionOrder)) },
      items: sessions.map(({ id, machine: m, session: s }) => ({
        id,
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
  const activeId =
    route.name === "session"
      ? [route.machine, route.sessionId].join(SEP)
      : route.name === "plugin"
        ? (pluginItems.find((i) => i.plugin === route.plugin && i.page.id === route.page)?.id ?? "")
        : route.name;
  const panel = route.name === "session" ? route.panel : undefined;
  // The session on a phone's screen (not while one of its panels takes the screen): the top bar shows its name and
  // state, and its header leaves them out (see SessionView), so the two bars become one.
  const onScreen = route.name === "session" && !panel ? byId.get(activeId) : undefined;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={(id) => {
          if (id === "home" || id === "devices" || id === "settings" || id === "plugins") return go({ name: id });
          const item = pluginItems.find((i) => i.id === id);
          if (item) return go({ name: "plugin", plugin: item.plugin, page: item.page.id, params: item.page.params ?? {} });
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
          {onScreen ? (
            <>
              <h1 className="min-w-0 truncate text-sm font-semibold">{sessionLabel(onScreen.session)}</h1>
              <SessionState machine={onScreen.machine} session={onScreen.session} />
            </>
          ) : (
            <span className="flex items-center gap-1.5 font-semibold">
              <span aria-hidden className="font-emoji">
                {LOGO}
              </span>
              Gasho
            </span>
          )}
          {/* The connection shows in the sidebar's footer; here only while it is down. */}
          {!connected && <span className="ml-auto shrink-0 text-xs text-red-400">再接続中…</span>}
          {onScreen && <SessionHeaderToggle className={cn("-mr-1", connected && "ml-auto")} />}
        </header>
        <div className="flex min-h-0 flex-1">
          {/* layoutScroll: the home screen's tiles slide to new places inside it, also while it scrolls. */}
          <motion.main layoutScroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {route.name === "home" && <HomeView />}
            {route.name === "devices" && <DevicesView />}
            {route.name === "settings" && <SettingsView />}
            {route.name === "plugins" && <PluginsView />}
            {route.name === "plugin" && <PluginPageView plugin={route.plugin} page={route.page} params={route.params} />}
            {route.name === "session" && (desktop || !panel) && (
              <SessionView key={`${route.machine}/${route.sessionId}`} machine={route.machine} sessionId={route.sessionId} panel={panel} />
            )}
            {route.name === "session" && !desktop && panel && (
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked={false} />
            )}
          </motion.main>
          {route.name === "session" && desktop && panel && (
            <aside className="w-[clamp(380px,40vw,620px)] shrink-0 border-l border-border bg-background">
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked />
            </aside>
          )}
        </div>
      </div>
      <PluginBadgeProbes />
      <SessionActionDialog request={sessionAction} onClose={() => setSessionAction(null)} onNavigate={() => setMobileOpen(false)} />
      <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} onLaunched={() => setMobileOpen(false)} />
    </div>
  );
}
