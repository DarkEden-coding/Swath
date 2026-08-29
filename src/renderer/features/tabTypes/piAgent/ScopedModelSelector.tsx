import { useMemo, useState } from "react";
import type { PiModel } from "../../../../shared/ipc/piRpc";

const STORAGE_KEY = "swath.piAgent.scopedModels";
const CHANGE_EVENT = "swath:pi-agent-scoped-models";

/** Returns the stable provider/model identifier used by pi's RPC commands. */
export function modelKey(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Loads Swath's global model scope. Missing or invalid storage means all models. */
export function loadScopedModelKeys(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

/** Persists Swath's global model scope and notifies other open pi panes. */
export function saveScopedModelKeys(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Keep the scope usable for this app session when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: keys }));
}

/** Event name used to synchronize the scope between mounted pi panes. */
export const scopedModelsChangeEvent = CHANGE_EVENT;

interface ScopedModelSelectorProps {
  models: PiModel[];
  selectedKeys: readonly string[];
  onSave: (keys: string[]) => void;
  onClose: () => void;
}

/** Selects the models shown and cycled by Swath's pi coding-agent UI. */
export function ScopedModelSelector({
  models,
  selectedKeys,
  onSave,
  onClose,
}: ScopedModelSelectorProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set(selectedKeys));
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? models.filter((model) => `${modelKey(model)} ${model.name}`.toLowerCase().includes(needle))
      : models;
  }, [models, query]);

  const toggle = (key: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/60 p-4">
      <div
        className="flex max-h-[min(44rem,90vh)] w-full max-w-2xl flex-col rounded border border-[var(--pi-purple)] bg-[var(--pi-page)] p-4 font-mono shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Scoped models"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--pi-blue)]">Scoped models</h2>
            <p className="mt-1 text-[11px] text-[var(--pi-muted)]">
              Used by Swath's model picker and cycle shortcut.
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-[var(--pi-muted)]">
            {selected.size} selected
          </span>
        </div>

        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search provider, model, or name"
          className="mb-3 w-full rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] px-3 py-2 text-xs text-[var(--pi-text)] outline-none focus:border-[var(--pi-purple)]"
        />

        <div className="mb-3 flex gap-2 text-[11px]">
          <button
            type="button"
            className="text-[var(--pi-blue)] hover:underline"
            onClick={() => setSelected(new Set(models.map(modelKey)))}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-[var(--pi-muted)] hover:text-[var(--pi-text)] hover:underline"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--pi-border)]">
          {filtered.map((model) => {
            const key = modelKey(model);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-start gap-3 border-b border-[var(--pi-border)] px-3 py-2 last:border-b-0 hover:bg-[#172235]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => toggle(key)}
                  className="mt-0.5 accent-[var(--pi-purple)]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs text-[var(--pi-text)]">{key}</span>
                  {model.name !== model.id ? (
                    <span className="block truncate text-[10px] text-[var(--pi-muted)]">
                      {model.name}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[var(--pi-muted)]">
              No models match "{query}".
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-swath-border px-3 py-1.5 text-xs text-swath-muted hover:text-swath-text"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1.5 text-xs text-swath-text disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onSave([...selected])}
          >
            Save scope
          </button>
        </div>
      </div>
    </div>
  );
}
