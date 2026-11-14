// The build command's tools (gasho-plugin build) and the React the plugins' parts run with, at the versions Gasho's
// screen is built with (apps/web/package.json). scripts/pack.ts puts them in the SDK's package.json, and the release
// (scripts/release.ts at the repository's root) publishes a new SDK when they change.
type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export const BUILD_TOOLS = ["vite", "@vitejs/plugin-react", "@tailwindcss/vite", "tailwindcss"];

export function sdkDependencies(web: PackageJson): { dependencies: Record<string, string>; peerDependencies: Record<string, string> } {
  const tools: Record<string, string | undefined> = { ...web.dependencies, ...web.devDependencies };
  const dependencies = Object.fromEntries(BUILD_TOOLS.map((n) => [n, tools[n] ?? ""]));
  if (Object.values(dependencies).some((v) => !v)) throw new Error("a build tool is missing from apps/web/package.json");
  if (!tools.react) throw new Error("react is missing from apps/web/package.json");
  return { dependencies, peerDependencies: { react: tools.react } };
}
