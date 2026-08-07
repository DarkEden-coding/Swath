/**
 * `/resume` picker: the pi sessions recorded for this pane's session directory.
 *
 * pi's RPC protocol has no "list sessions" command — the TUI's `--resume` reads the session
 * directory directly — so the host walks the same directory and Swath renders the result. The
 * directory comes from `get_state`'s `sessionFile`, which avoids reimplementing pi's cwd → dir
 * encoding.
 */

import { useEffect, useState } from "react";
import type { PiSessionInfo } from "../../../../shared/ipc/piRpc";

/** The session directory pi is using, derived from the file it reported for this session. */
export function sessionDirOf(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  const cut = Math.max(sessionFile.lastIndexOf("/"), sessionFile.lastIndexOf("\\"));
  return cut > 0 ? sessionFile.slice(0, cut) : undefined;
}

function formatWhen(modified: number): string {
  const minutes = Math.round((Date.now() - modified) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

interface SessionListProps {
  paneId: string;
  sessionDir: string | undefined;
  /** Session file currently open, so it can be marked. */
  currentFile: string | undefined;
  onPick: (sessionPath: string) => void;
  onClose: () => void;
}

export function SessionList({
  paneId,
  sessionDir,
  currentFile,
  onPick,
  onClose,
}: SessionListProps): JSX.Element {
  const [sessions, setSessions] = useState<PiSessionInfo[] | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const error = sessionDir ? failure : "pi has not reported a session directory yet.";

  useEffect(() => {
    if (!sessionDir) return;
    let live = true;
    void window.swath.pi
      .rpc({ op: "sessions", paneId, dir: sessionDir })
      .then((result) => {
        if (!live) return;
        setSessions((result as { sessions?: PiSessionInfo[] })?.sessions ?? []);
      })
      .catch((cause: unknown) => {
        if (live) setFailure(String(cause));
      });
    return () => {
      live = false;
    };
  }, [paneId, sessionDir]);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-swath-border bg-swath-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-swath-border px-2 py-1">
        <span className="font-mono text-[11px] text-swath-text">resume session</span>
        <button
          type="button"
          className="font-mono text-[11px] text-swath-muted hover:text-swath-text"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <div className="px-2 py-2 text-[11px] text-[var(--pi-red)]">{error}</div>
        ) : sessions === null ? (
          <div className="px-2 py-2 text-[11px] text-swath-muted">Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-swath-muted">No previous sessions here.</div>
        ) : (
          sessions.map((session) => {
            const current = session.path === currentFile;
            return (
              <button
                key={session.path}
                type="button"
                title={session.path}
                disabled={current}
                className={`block w-full px-2 py-1 text-left font-mono text-[11px] hover:bg-[#1f2a37] ${
                  current ? "text-swath-accent" : "text-swath-muted hover:text-swath-text"
                }`}
                onClick={() => onPick(session.path)}
              >
                <div className="flex justify-between gap-2">
                  <span className="truncate">
                    {current ? "● " : ""}
                    {session.name || session.preview || session.id}
                  </span>
                  <span className="shrink-0 opacity-70">{formatWhen(session.modified)}</span>
                </div>
                {session.name && session.preview ? (
                  <div className="truncate opacity-60">{session.preview}</div>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      <div className="shrink-0 border-t border-swath-border px-2 py-1 text-[10px] text-swath-muted">
        Click a session to continue it in this pane.
      </div>
    </div>
  );
}
