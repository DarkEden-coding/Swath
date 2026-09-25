import { useEffect, useState } from "react";

interface Terminal {
  id: string;
  command: string;
  status: string;
}
interface Snapshot {
  terminals: Terminal[];
  output: string | null;
}

/** Reads the extension's bounded log tail while the viewer is open. */
export function BackgroundTerminalViewer({
  paneId,
  onClose,
}: {
  paneId: string;
  onClose: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ terminals: [], output: null });
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const result = (await window.swath.pi.rpc({
          op: "backgroundTerminals",
          paneId,
          ...(selected ? { terminalId: selected } : {}),
        })) as Snapshot;
        if (!active) return;
        setSnapshot(result);
        setError("");
        if (!selected && result.terminals.length)
          setSelected(
            result.terminals.find((terminal) => terminal.status === "running")?.id ??
              result.terminals.at(-1)!.id,
          );
      } catch (reason) {
        if (active) setError(String(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [paneId, selected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Background terminals"
        className="flex h-[min(75vh,700px)] w-[min(90vw,1000px)] flex-col rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] p-4 text-[var(--pi-text)] shadow-xl"
      >
        <div className="mb-3 flex items-center gap-3">
          <strong>Background terminals</strong>
          <select
            aria-label="Terminal"
            className="min-w-0 flex-1 bg-[var(--pi-surface)]"
            value={selected ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!selected && <option value="">Select a terminal</option>}
            {snapshot.terminals.map((terminal) => (
              <option key={terminal.id} value={terminal.id}>
                {terminal.id} · {terminal.status} · {terminal.command}
              </option>
            ))}
          </select>
          <button type="button" onClick={onClose} aria-label="Close terminal viewer">
            ✕
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-[var(--pi-red)]">
            {error}
          </p>
        ) : null}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-3 font-mono text-xs">
          {snapshot.output ?? "No output yet"}
        </pre>
      </div>
    </div>
  );
}
