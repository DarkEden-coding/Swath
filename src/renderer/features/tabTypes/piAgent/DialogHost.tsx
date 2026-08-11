/**
 * Renders blocking `extension_ui_request` dialogs.
 *
 * This is what makes `/memories`, `/todo` and `/parallel-agents` work — those extensions drive
 * their entire UI through select/confirm/input/editor. It also answers `project_trust` at
 * startup, which otherwise blocks the session in an untrusted directory.
 */

import { useState } from "react";
import { AskQuestionsDialog } from "./AskQuestionsDialog";
import { parseAskQuestionsTitle } from "./askQuestions";
import type { PiDialog } from "./eventReducer";

interface DialogHostProps {
  dialog: PiDialog | undefined;
  /** Workspace directory, used to resolve images attached to `ask_user_questions`. */
  cwd: string;
  onAnswer: (
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: true },
  ) => void;
}

/**
 * Callers must pass `key={dialog?.id}` so each dialog gets a fresh draft rather than
 * inheriting the previous one's text.
 */
export function DialogHost({ dialog, cwd, onAnswer }: DialogHostProps): JSX.Element | null {
  const [draft, setDraft] = useState(dialog?.method === "editor" ? (dialog.prefill ?? "") : "");
  const [selected, setSelected] = useState(0);

  if (!dialog) return null;

  const cancel = (): void => onAnswer(dialog.id, { cancelled: true });

  // `ask_user_questions` tunnels its whole question set through a select title, because pi's
  // RPC protocol has no richer dialog method. See `askQuestions.ts`.
  const askQuestions = dialog.method === "select" ? parseAskQuestionsTitle(dialog.title) : null;
  if (askQuestions) {
    return (
      <AskQuestionsDialog
        questions={askQuestions}
        cwd={cwd}
        onSubmit={(value) => onAnswer(dialog.id, { value })}
        onCancel={cancel}
      />
    );
  }

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/50 p-4">
      <div
        className="w-full max-w-lg rounded border border-[var(--pi-purple)] bg-[var(--pi-page)] p-4 font-mono shadow-lg outline-none"
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (dialog.method !== "select" || dialog.options.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setSelected((value) => (value + delta + dialog.options.length) % dialog.options.length);
          } else if (event.key === "Enter" && dialog.options[selected]) {
            event.preventDefault();
            onAnswer(dialog.id, { value: dialog.options[selected] });
          }
        }}
      >
        {dialog.title ? (
          <div className="mb-3 text-sm font-semibold text-[var(--pi-blue)]">{dialog.title}</div>
        ) : null}

        {dialog.method === "confirm" ? (
          <>
            {dialog.message ? (
              <p className="mb-4 text-[13px] text-[var(--pi-muted)]">{dialog.message}</p>
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
            {dialog.options.map((option, index) => (
              <button
                key={option}
                type="button"
                className={`rounded border px-3 py-1.5 text-left text-[12px] ${
                  index === selected
                    ? "border-[var(--pi-purple)] bg-[#172235] text-[var(--pi-text)]"
                    : "border-[var(--pi-border)] text-[var(--pi-text)]"
                }`}
                onMouseEnter={() => setSelected(index)}
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
              className="mb-3 h-32 w-full resize-none rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] p-2 text-[12px] text-[var(--pi-text)] outline-none focus:border-[var(--pi-purple)]"
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
