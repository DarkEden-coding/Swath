/**
 * `@file` mentions in the composer.
 *
 * A mention shows the shortest thing that still identifies the file — a path from its own
 * project's root — while pi receives what it can actually resolve. For a file in another folder of
 * a project group that is an absolute path, so the two differ and the composer expands mentions on
 * send. The label is also treated as one object by the editing keys: a mention is inserted whole,
 * so it deletes whole.
 */

import { displayPath } from "./PiRootsContext";

/** How a candidate reads in the composer: relative to the project folder that owns it. */
export function mentionLabel(roots: readonly string[], file: string): string {
  return displayPath(roots, file) ?? file;
}

/**
 * Labels for a candidate list, keeping every label unique.
 *
 * Two group folders can share a basename, which would make one label stand for two different
 * files; the loser keeps its absolute path, which is unambiguous by construction.
 */
export function mentionLabels(
  roots: readonly string[],
  files: readonly string[],
): Map<string, string> {
  const byLabel = new Map<string, string>();
  for (const file of files) {
    const label = mentionLabel(roots, file);
    const claimed = byLabel.get(label);
    if (claimed === undefined) {
      byLabel.set(label, file);
      continue;
    }
    if (claimed !== file) byLabel.set(file, file);
  }
  return byLabel;
}

/** Escapes a label for use inside a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites every mention pi could not resolve into the path it can.
 *
 * Longest labels first: `web/src/index.ts` must win over a shorter label that prefixes it.
 */
export function expandMentions(text: string, paths: ReadonlyMap<string, string>): string {
  const expandable = [...paths.entries()]
    .filter(([label, path]) => label !== path)
    .sort(([a], [b]) => b.length - a.length);
  return expandable.reduce(
    (accumulated, [label, path]) =>
      accumulated.replace(new RegExp(`(^|\\s)@${escape(label)}(?=\\s|$)`, "g"), `$1@${path}`),
    text,
  );
}

/** True when `text` ends with a mention: a known label, or an unbroken run after `@`. */
function mentionStartInEnding(text: string, labels: Iterable<string>): number | null {
  let best: number | null = null;
  for (const label of labels) {
    if (!text.endsWith(`@${label}`)) continue;
    const start = text.length - label.length - 1;
    if (start === 0 || /\s/.test(text[start - 1]!)) best = Math.min(best ?? start, start);
  }
  if (best !== null) return best;
  // A hand-typed mention has no label to match, but it is still one word.
  const match = /(^|\s)@[^\s]+$/.exec(text);
  return match ? match.index + match[1].length : null;
}

/**
 * The mention the caret sits at the end of, including the single space the composer pads it with,
 * so one Backspace removes the whole thing rather than one character of a path.
 */
export function mentionSpanBefore(
  text: string,
  caret: number,
  labels: Iterable<string>,
): { start: number; end: number } | null {
  const labelList = [...labels];
  const padded = text[caret - 1] === " ";
  const end = padded ? caret - 1 : caret;
  const start = mentionStartInEnding(text.slice(0, end), labelList);
  if (start === null) return null;
  return { start, end: caret };
}

/** The mention starting at the caret, for a forward Delete. */
export function mentionSpanAfter(
  text: string,
  caret: number,
  labels: Iterable<string>,
): { start: number; end: number } | null {
  if (text[caret] !== "@") return null;
  if (caret > 0 && !/\s/.test(text[caret - 1]!)) return null;
  const after = text.slice(caret + 1);
  let length: number | null = null;
  for (const label of labels) {
    if (!after.startsWith(label)) continue;
    const next = after[label.length];
    if (next === undefined || /\s/.test(next)) length = Math.max(length ?? 0, label.length);
  }
  if (length === null) {
    const match = /^[^\s]+/.exec(after);
    if (!match) return null;
    length = match[0].length;
  }
  const end = caret + 1 + length;
  return { start: caret, end: text[end] === " " ? end + 1 : end };
}
