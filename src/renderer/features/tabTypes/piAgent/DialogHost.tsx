/**
 * Renders blocking `extension_ui_request` dialogs.
 *
 * This is what makes `/memories`, `/todo` and `/parallel-agents` work — those extensions drive
 * their entire UI through select/confirm/input/editor. It also answers `project_trust` at
 * startup, which otherwise blocks the session in an untrusted directory.
 */

import { useState } from "react";
import type { PiDialog } from "./eventReducer";

interface DialogHostProps {
  dialog: PiDialog | undefined;
  onAnswer: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) => void;
}

/**
 * Callers must pass `key={dialog?.id}` so each dialog gets a fresh draft rather than
 * inheriting the previous one's text.
 */
export function DialogHost({ dialog, onAnswer }: DialogHostProps): JSX.Element | null {
  const [draft, setDraft] = useState(
    dialog?.method === "editor" ? (dialog.prefill ?? "") : "",
  );

  if (!dialog) return null;

  const cancel = (): void => onAnswer(dialog.id, { cancelled: true });

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded border border-swath-border-strong bg-swath-panel p-4 shadow-lg">
        {dialog.title ? (
          <div className="mb-3 text-sm font-semibold text-swath-text">{dialog.title}</div>
        ) : null}

        {dialog.method === "confirm" ? (
          <>
            {dialog.message ? (
              <p className="mb-4 text-[13px] text-swath-muted">{dialog.message}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-swath-border px-3 py-1 text-[12px] text-swath-muted hover:text-swath-text"
                onClick={() => onAnswer(dialog.id, { confirmed: false })}
              >
                No
              </button>
              <button
                type="button"
                className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1 text-[12px] text-swath-text"
                onClick={() => onAnswer(dialog.id, { confirmed: true })}
              >
                Yes
              </button>
            </div>
          </>
        ) : null}

        {dialog.method === "select" ? (
          <div className="flex max-h-80 flex-col gap-1 overflow-auto">
            {dialog.options.map((option) => (
              <button
                key={option}
                type="button"
                className="rounded border border-swath-border px-3 py-1.5 text-left font-mono text-[12px] text-swath-text hover:border-swath-accent hover:bg-[#1f2a37]"
                onClick={() => onAnswer(dialog.id, { value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {dialog.method === "input" || dialog.method === "editor" ? (
          <>
            <textarea
              autoFocus
              className="mb-3 h-32 w-full resize-none rounded border border-swath-border bg-[#0d1117] p-2 font-mono text-[12px] text-swath-text outline-none focus:border-swath-accent"
              placeholder={dialog.method === "input" ? (dialog.placeholder ?? "") : ""}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  onAnswer(dialog.id, { value: draft });
                }
                if (event.key === "Escape") cancel();
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-swath-border px-3 py-1 text-[12px] text-swath-muted hover:text-swath-text"
                onClick={cancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1 text-[12px] text-swath-text"
                onClick={() => onAnswer(dialog.id, { value: draft })}
              >
                Submit
              </button>
            </div>
          </>
        ) : null}

        {dialog.method === "select" ? (
          <button
            type="button"
            className="mt-3 w-full rounded border border-swath-border px-3 py-1 text-[12px] text-swath-muted hover:text-swath-text"
            onClick={cancel}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
