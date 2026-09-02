/**
 * Atomic bracketed tokens in the composer text: `[Image N]` attachment markers and
 * `[Pasted N: M chars]` blocks standing in for large pastes.
 *
 * Both are inserted as one object, so they also edit as one: a single Backspace or Delete removes
 * the whole token, and the left/right arrow keys step over it instead of into it — mirroring how
 * `@file` mentions behave (see `mentions.ts`). Pasted bodies live in the pane cache alongside
 * images so a tab switch does not lose them; `expandPastes` restores the full text on send.
 */

/** Pastes at least this many characters become a placeholder rather than literal text. */
export const PASTE_THRESHOLD = 200;

/** A large paste held out of the prompt text, identified by its placeholder. */
export interface AttachedPaste {
  /** `[Pasted N: M chars]`, unique per pane draft. */
  placeholder: string;
  /** The full pasted text, expanded back into the message on send. */
  text: string;
}

/** Matches either atomic token: an image marker or a paste block. */
const TOKEN_PATTERN = /\[(?:Image \d+|Pasted \d+: \d+ chars)]/g;

/** The highest `[Pasted N: …]` number already in the draft, so numbering never collides. */
function nextPasteNumber(pastes: readonly AttachedPaste[]): number {
  return pastes.reduce(
    (highest, paste) => Math.max(highest, Number(/\[Pasted (\d+):/.exec(paste.placeholder)?.[1] ?? 0)),
    0,
  );
}

/** Wraps each pasted body in a unique, count-bearing placeholder. */
export function makePastes(
  pastes: readonly AttachedPaste[],
  added: readonly string[],
): AttachedPaste[] {
  let counter = nextPasteNumber(pastes);
  return added.map((text) => {
    counter += 1;
    return { placeholder: `[Pasted ${counter}: ${text.length} chars]`, text };
  });
}

/** Restores the full pasted text everywhere its placeholder still appears. */
export function expandPastes(text: string, pastes: readonly AttachedPaste[]): string {
  return pastes.reduce(
    (expanded, paste) => expanded.split(paste.placeholder).join(paste.text),
    text,
  );
}

/**
 * The token the caret sits at the end of — or inside — for a backwards Backspace or a left arrow
 * step. Includes one adjacent space on either side, so removal does not leave doubles behind.
 */
export function tokenSpanBefore(
  text: string,
  caret: number,
): { start: number; end: number; token: string } | null {
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < caret && caret <= end) {
      const padded = start > 0 && text[start - 1] === " " && (end === text.length || text[end] === " ");
      return { start: padded ? start - 1 : start, end, token: match[0] };
    }
  }
  return null;
}

/** The token the caret sits at the start of — or inside — for a forward Delete or right arrow. */
export function tokenSpanAfter(
  text: string,
  caret: number,
): { start: number; end: number; token: string } | null {
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= caret && caret < end) return { start, end, token: match[0] };
  }
  return null;
}
