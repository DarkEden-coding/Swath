import { clipboard } from "electron";
import type { TerminalClipboardPayload } from "../../shared/types";

export async function readClipboardForTerminal(): Promise<TerminalClipboardPayload> {
  return { text: clipboard.readText(), imagePath: null };
}
