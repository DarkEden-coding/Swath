import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { attachSwathAdapterIfMissing } from "./viteBrowserTpm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installErrorLog } from "./lib/errorLog";
import { App } from "./App";

installErrorLog();
attachSwathAdapterIfMissing();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="Swath" critical>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
