export async function copyTerminalSelection(selection: string | undefined): Promise<void> {
  if (selection) await navigator.clipboard.writeText(selection);
}

export async function readTerminalPastePayload(): Promise<string> {
  await window.swath.permissions.ensureTerminalPaste();
  const payload = await window.swath.clipboard.readForTerminal();
  return payload.text;
}
