import { formatPathPaste } from "../../../utils/terminalPaste";

export async function readTerminalPastePayload(shellCommand?: string): Promise<string> {
  const payload = await window.swath.clipboard.readForTerminal();
  if (payload.text) return payload.text;
  return payload.imagePath ? formatPathPaste([payload.imagePath], shellCommand) : "";
}
