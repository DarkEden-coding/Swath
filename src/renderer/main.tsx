import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { attachViteBrowserTpmIfMissing } from "./viteBrowserTpm";
import { App } from "./App";

attachViteBrowserTpmIfMissing();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
