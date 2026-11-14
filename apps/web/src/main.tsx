import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { start } from "./lib/store";
import "./plugins/theme";
import "./index.css";

void start();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
