import { app } from "electron";

export function quitWhenAllWindowsClosed(): void {
  app.on("window-all-closed", () => app.quit());
}
