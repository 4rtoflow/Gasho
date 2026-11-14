import { motion } from "framer-motion";
import { Home, KeyRound, ListRestart, Plus, Puzzle, Settings } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { SessionStatus } from "@gasho/protocol";
import { ResizeHandle } from "@/components/resize-handle";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { RepoFilter } from "@/components/repo-filter";
import { ReposDialog } from "@/components/repos-dialog";
import { SessionActionDialog, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarSection } from "@/components/ui/sidebar";
import { useChoice } from "@/lib/flag";
import { sessionLabel } from "@/lib/format";
import { DESKTOP, useMediaQuery, useWindowWidth } from "@/lib/media";
import { arrangeSessions, rememberSessions, reorderShown, useSavedOrder } from "@/lib/order";
import { updateCount } from "@/lib/plugin-catalog";
import { go, isOldGitHubLink, useRoute, type SessionPanel } from "@/lib/route";
import { rememberWorktrees, useRememberedWorktrees } from "@/lib/remembered-worktrees";
import {
  notificationShown,
  rememberedOf,
  repoChoices,
  repoKeyOf,
  sessionToOpen,
  worktreeId,
  worktreeKey,
  worktreesByLastUse,
  type WorktreeSessions,
} from "@/lib/sessions";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, clampPanelWidth, defaultPanelWidth, usePanelWidth } from "@/lib/widths";
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
import { WorktreeView } from "@/views/worktree";

/** Where this browser keeps the order the sidebar's worktrees were dragged into, and the repository they are narrowed to. */
const WORKTREE_ORDER_KEY = "gasho.worktreeOrder";
const WORKTREE_REPO_KEY = "gasho.worktreeRepo";

/** A worktree's status in the sidebar: that of its most pressing session. */
function worktreeStatus(w: WorktreeSessions): SessionStatus {
  if (!w.machine.connected) return "unknown";
  return (["waiting", "busy", "idle"] as const).find((st) => w.sessions.some((s) => s.status === st)) ?? "unknown";
}

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

/** A panel of a session beside it on a computer, its left edge dragged to change its width (lib/widths). */
function DockedPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [savedWidth, setSavedWidth] = usePanelWidth();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const windowWidth = useWindowWidth();
  // What the conversation and the panel share (the window but the sidebar), followed as the sidebar's width changes.
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const observer = new ResizeObserver(() => setRoom(row.clientWidth));
    observer.observe(row);
    setRoom(row.clientWidth);
    return () => observer.disconnect();
  }, []);
  const clampWidth = (w: number) => clampPanelWidth(w, room);
  const width = clampWidth(dragWidth ?? savedWidth ?? defaultPanelWidth(windowWidth));
  return (
    <aside ref={ref} style={{ width }} className="relative shrink-0 border-l border-border bg-background">
      {children}
      <ResizeHandle
        edge="left"
        label="パネルの幅"
        width={width}
        min={PANEL_WIDTH_MIN}
        max={clampWidth(PANEL_WIDTH_MAX)}
        clamp={clampWidth}
        onDrag={setDragWidth}
        onChange={setSavedWidth}
        onReset={() => setSavedWidth(null)}
      />
    </aside>
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
  const { auth, me, machines, notifications, connected, plugins, catalog } = useAppState();
  const [mobileOpen, setMobileOpen] = useState(false);
  // What was picked from a session tab's menu (rename, fork, remove); its dialog is open meanwhile.
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  // The dialog that starts a new session, opened from the "＋" of the sidebar's worktree list.
  const [launchOpen, setLaunchOpen] = useState(false);
  // The dialog that registers repositories, opened from the menu that narrows the sidebar's worktrees.
  const [reposOpen, setReposOpen] = useState(false);
  const [repoKey, setRepoKey] = useChoice(WORKTREE_REPO_KEY);
  // The order the sidebar's worktrees were dragged into (none: the one used last first).
  const [worktreeOrder, setWorktreeOrder] = useSavedOrder(WORKTREE_ORDER_KEY);
  const desktop = useMediaQuery(DESKTOP);
  // The plugins' web parts (docs/plugins.md): their sidebar items and the badges their hooks give.
  const { parts } = usePluginRegistry();
  const badges = usePluginBadges();
  // Every worktree with sessions is kept, so that it stays in the sidebar once they are gone.
  const remembered = useRememberedWorktrees();
  useEffect(() => rememberWorktrees(worktreesByLastUse(machines).flatMap((w) => (w.sessions.length > 0 ? [rememberedOf(w)] : []))), [machines]);

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines)).length;
  // The worktrees of all working servers in one list: the one used last first, then those without sessions, or in the
  // order they were dragged into (worktrees that got their first session since then come first).
  const byId = new Map(worktreesByLastUse(machines, remembered).map((w) => [w.id, w]));
  const worktrees = arrangeSessions([...byId.keys()], worktreeOrder).flatMap((id) => byId.get(id) ?? []);
  // Narrowed to one repository, while it is in the list (it may come back: its working server reconnects, say).
  const repos = repoChoices(worktrees);
  const narrowed = repos.find((r) => r.key === repoKey);
  const listed = narrowed ? worktrees.filter((w) => repoKeyOf(w) === narrowed.key) : worktrees;
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
        // The plugins that the catalog has a newer version of.
        { id: "plugins", label: "プラグイン", icon: <Puzzle />, badge: updateCount(plugins, catalog) || undefined },
        { id: "settings", label: "設定", icon: <Settings /> },
      ],
    },
    {
      // Shown even without sessions, for its "＋".
      title: narrowed ? `worktree · ${narrowed.name}` : "worktree",
      action: { label: "新しいセッション", icon: <Plus />, onClick: () => setLaunchOpen(true) },
      secondaryAction: worktreeOrder
        ? { label: "最後に使った順に戻す", icon: <ListRestart />, onClick: () => setWorktreeOrder(undefined) }
        : undefined,
      tools: (
        <RepoFilter
          choices={repos}
          picked={narrowed}
          onPick={setRepoKey}
          onRegister={() => setReposOpen(true)}
          machineNames={machines.length > 1}
        />
      ),
      sort: {
        onReorder: (ids) => setWorktreeOrder(rememberSessions(reorderShown(worktrees.map((w) => w.id), ids), worktreeOrder)),
      },
      items: listed.map((w) => ({
        id: w.id,
        label: w.label,
        // The working server too, when there are several.
        description: [w.repo, machines.length > 1 ? w.machine.name : undefined].filter(Boolean).join(" · ") || undefined,
        icon: <StatusDot status={worktreeStatus(w)} />,
        badge: !w.machine.connected ? "オフライン" : w.sessions.some((s) => s.status === "waiting") ? "確認" : undefined,
      })),
    },
  ];
  const openSession =
    route.name === "session" ? machines.find((m) => m.id === route.machine)?.sessions.find((s) => s.sessionId === route.sessionId) : undefined;
  const activeId =
    route.name === "session"
      ? openSession
        ? worktreeId(route.machine, openSession)
        : ""
      : route.name === "worktree"
        ? worktreeKey(route.machine, route.path)
        : route.name === "plugin"
        ? (pluginItems.find((i) => i.plugin === route.plugin && i.page.id === route.page)?.id ?? "")
        : route.name;
  const panel = route.name === "session" ? route.panel : undefined;
  // The session on a phone's screen (not while one of its panels takes the screen): the top bar shows its name and
  // state, and its header leaves them out (see SessionView), so the two bars become one.
  const onScreen = route.name === "session" && !panel && openSession?.managed ? openSession : undefined;
  const onScreenMachine = onScreen && machines.find((m) => m.id === (route.name === "session" ? route.machine : ""));

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={(id) => {
          if (id === "home" || id === "devices" || id === "settings" || id === "plugins") return go({ name: id });
          const item = pluginItems.find((i) => i.id === id);
          if (item) return go({ name: "plugin", plugin: item.plugin, page: item.page.id, params: item.page.params ?? {} });
          const w = worktrees.find((x) => x.id === id);
          if (!w) return;
          const s = sessionToOpen(w);
          go(s ? { name: "session", machine: w.machine.id, sessionId: s.sessionId } : { name: "worktree", machine: w.machine.id, path: w.path });
        }}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
        header={<Brand />}
        footer={<Connection connected={connected} deviceName={me?.name} />}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger onClick={() => setMobileOpen(true)} />
          {onScreen && onScreenMachine ? (
            <>
              <h1 className="min-w-0 truncate text-sm font-semibold">{sessionLabel(onScreen)}</h1>
              <SessionState machine={onScreenMachine} session={onScreen} />
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
            {route.name === "worktree" && (
              <WorktreeView
                key={worktreeKey(route.machine, route.path)}
                worktree={worktrees.find((w) => w.id === worktreeKey(route.machine, route.path))}
                view={route.view}
                onSessionAction={setSessionAction}
              />
            )}
            {route.name === "session" && (desktop || !panel) && (
              <SessionView
                key={`${route.machine}/${route.sessionId}`}
                machine={route.machine}
                sessionId={route.sessionId}
                panel={panel}
                onSessionAction={setSessionAction}
              />
            )}
            {route.name === "session" && !desktop && panel && (
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked={false} />
            )}
          </motion.main>
          {route.name === "session" && desktop && panel && (
            <DockedPanel>
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked />
            </DockedPanel>
          )}
        </div>
      </div>
      <PluginBadgeProbes />
      <SessionActionDialog request={sessionAction} onClose={() => setSessionAction(null)} />
      <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} onLaunched={() => setMobileOpen(false)} />
      <ReposDialog open={reposOpen} onClose={() => setReposOpen(false)} />
    </div>
  );
}
