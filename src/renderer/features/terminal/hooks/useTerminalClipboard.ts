export interface TerminalPastePayload {
  text: string;
  hasImage: boolean;
}

export async function readTerminalPastePayload(): Promise<TerminalPastePayload> {
  return window.swath.clipboard.readForTerminal();
}
