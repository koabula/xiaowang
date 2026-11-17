import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installPreviewBridge } from "./preview.ts";
import "./styles.css";
import "./workspace.css";
import "./message-composer.css";
import "./controls.css";

installPreviewBridge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
