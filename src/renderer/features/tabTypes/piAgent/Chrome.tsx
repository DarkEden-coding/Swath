/**
 * Footer chrome: extension status chips, session stats, and the model / thinking pickers.
 *
 * Reproduces pi's TUI footer (`↑149k ↓22k … $1.615 … (openai-codex) gpt-5.6-terra • medium`),
 * which `setFooter` cannot deliver over RPC. Numbers come from `get_session_stats`; Swath only
 * formats them.
 */

import { useState } from "react";
import type { PiModel, PiSessionStats, PiThinkingLevel } from "../../../../shared/ipc/piRpc";
import { AnsiText } from "../../../lib/ansi";

/** Formats a token count the way pi's footer does (149000 → 149k). */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Formats a cost in dollars, keeping small amounts legible. */
export function formatCost(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(3)}`;
}

interface PickerProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  onPick: (value: T) => void;
}

function Picker<T extends string>({ label, options, onPick }: PickerProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className="hover:text-[var(--pi-text)]"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full right-0 z-20 mb-1 max-h-72 w-64 overflow-auto rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] py-1 shadow-lg">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="block w-full truncate px-2 py-1 text-left text-[11px] text-[var(--pi-muted)] hover:bg-[#172235] hover:text-[var(--pi-text)]"
                onClick={() => {
                  onPick(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

interface ChromeProps {
  cwd: string;
  status: Record<string, string>;
  stats: PiSessionStats | null;
  model: PiModel | null | undefined;
  models: PiModel[];
  thinkingLevel: PiThinkingLevel | undefined;
  thinkingLevels: PiThinkingLevel[];
  streaming: boolean;
  compacting: boolean;
  pendingCount: number;
  exited: boolean;
  onSetModel: (model: string) => void;
  onSetThinking: (level: PiThinkingLevel) => void;
  onAbort: () => void;
  onRestart: () => void;
}

export function Chrome({
  cwd,
  status,
  stats,
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  streaming,
  compacting,
  pendingCount,
  exited,
  onSetModel,
  onSetThinking,
  onAbort,
  onRestart,
}: ChromeProps): JSX.Element {
  const context = stats?.contextUsage;

  return (
    <div className="pi-agent-footer shrink-0">
      <div className="pi-footer-row">
        <span className="truncate" title={cwd}>
          {cwd}
        </span>
        {compacting ? <span>compacting…</span> : null}
        {pendingCount > 0 ? <span>queued:{pendingCount}</span> : null}
      </div>

      <div className="pi-footer-row">
        {stats ? (
          <span>
            ↑{formatTokens(stats.tokens.input)} ↓{formatTokens(stats.tokens.output)}
            {stats.tokens.cacheRead > 0 ? ` R${formatTokens(stats.tokens.cacheRead)}` : ""}
            {stats.tokens.cacheWrite > 0 ? ` W${formatTokens(stats.tokens.cacheWrite)}` : ""}{" "}
            {formatCost(stats.cost)}
            {context && context.contextWindow > 0 && context.percent !== null
              ? ` ${context.percent.toFixed(1)}%/${formatTokens(context.contextWindow)}`
              : ""}
          </span>
        ) : (
          <span />
        )}
        <div className="pi-footer-right flex shrink-0 items-center gap-3 text-[var(--pi-muted)]">
          <Picker
            label={model ? `(${model.provider}) ${model.name}` : "no model"}
            options={models.map((option) => ({
              value: `${option.provider}/${option.id}`,
              label: `${option.provider}/${option.id}`,
            }))}
            onPick={onSetModel}
          />
          <Picker
            label={`• ${thinkingLevel ?? "?"}`}
            options={thinkingLevels.map((level) => ({ value: level, label: level }))}
            onPick={onSetThinking}
          />
          {streaming ? (
            <button
              type="button"
              className="border border-[var(--pi-border)] px-2 hover:text-[var(--pi-text)]"
              onClick={onAbort}
            >
              stop
            </button>
          ) : null}
          {exited ? (
            <button
              type="button"
              className="border border-[var(--pi-border)] px-2 hover:text-[var(--pi-text)]"
              onClick={onRestart}
            >
              restart
            </button>
          ) : null}
        </div>
      </div>

      {Object.keys(status).length > 0 ? (
        <div className="pi-footer-row">
          {Object.entries(status).map(([key, text]) => (
            <AnsiText key={key} text={text} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
