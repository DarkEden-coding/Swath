import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { attachSwathAdapterIfMissing } from "./viteBrowserTpm";
import { App } from "./App";

attachSwathAdapterIfMissing();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
