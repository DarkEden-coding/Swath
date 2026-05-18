export async function readTerminalPastePayload(): Promise<string> {
  await window.swath.permissions.ensureTerminalPaste();
  const payload = await window.swath.clipboard.readForTerminal();
  return payload.text;
}
