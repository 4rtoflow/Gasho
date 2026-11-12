import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.GASHO_HUB_DEV ?? "http://127.0.0.1:7740";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    // During development the UI is served by Vite; WebSocket traffic goes to gasho-hub.
    proxy: {
      "/ws": { target: hub, ws: true },
      "/api": { target: hub },
    },
  },
});
