import { systemPreferences } from "electron";
import type { TerminalPastePermissionStatus } from "../../shared/types";

export function ensureTerminalPastePermissions(): TerminalPastePermissionStatus {
  if (process.platform !== "darwin") return { accessibility: "unavailable" };
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  if (granted) return { accessibility: "granted" };
  systemPreferences.isTrustedAccessibilityClient(true);
  return { accessibility: "prompted" };
}
