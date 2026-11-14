// The names Gasho's screen provides for "@gasho/plugin-sdk" at run time (GashoSdk in index.ts). A plugin's build
// replaces its imports of "@gasho/plugin-sdk" with these, read from what Gasho puts on globalThis; Gasho checks that it
// provides every one of them. Plain JavaScript, so that the build command can read it without TypeScript.
export const SDK_EXPORTS = [
  "definePlugin",
  "useMachines",
  "useSessionContext",
  "useDaemonReady",
  "useRequest",
  "useCall",
  "useSetting",
  "usePluginState",
  "useNavigation",
  "useSendInput",
  "useLaunchSession",
  "useNow",
  "githubRepos",
  "panelRepo",
  "relativeTime",
  "cn",
  "Page",
  "Panel",
  "PANEL_BUTTON",
  "RepoTabs",
  "Tile",
  "Markdown",
  "RelativeTime",
];

/** The version of the plugin API that this SDK describes (gasho-plugin.json `api`). */
export const PLUGIN_API = "1.1";
