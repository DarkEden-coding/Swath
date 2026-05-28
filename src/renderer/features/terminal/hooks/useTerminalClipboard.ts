export async function readTerminalPastePayload(): Promise<string> {
  const payload = await window.swath.clipboard.readForTerminal();
  return payload.text;
}
