/**
 * Tolerant parsing of the half-written JSON that arrives in `toolcall_delta`.
 *
 * Tool arguments stream in as raw JSON text, so until `toolcall_end` the buffer is a truncated
 * document: `{"path":"a.ts","edits":[{"oldText":"const x`. `JSON.parse` rejects every prefix, which
 * is why tool cards could only show the raw text while the call was being generated.
 *
 * The repair strategy is deliberately conservative:
 *
 * - A truncated **string** is completed, because that is the value being typed and showing it
 *   growing is the entire point (a diff filling in line by line).
 * - Any other truncated member — a half-written number, `tru`, a key with no value — is **dropped**,
 *   because a wrong value is worse than a missing one and the next delta will supply it anyway.
 *
 * Callers get plain `unknown` values and must tolerate every field being absent.
 */

/** A container open at some point during the scan. */
interface Frame {
  type: "object" | "array";
  /** Index just past the `{`/`[`, or just past the last `,` — where the current member begins. */
  memberStart: number;
  /** Object frames only: whether the current member's `:` has been seen. */
  hasColon: boolean;
}

interface Scan {
  frames: Frame[];
  inString: boolean;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Walks the buffer once, recording open containers and whether it ends inside a string. */
function scanJson(text: string): Scan {
  const frames: Frame[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      frames.push({
        type: char === "{" ? "object" : "array",
        memberStart: index + 1,
        hasColon: false,
      });
    } else if (char === "}" || char === "]") {
      frames.pop();
    } else if (char === ",") {
      const frame = frames[frames.length - 1];
      if (frame) {
        frame.memberStart = index + 1;
        frame.hasColon = false;
      }
    } else if (char === ":") {
      const frame = frames[frames.length - 1];
      if (frame) frame.hasColon = true;
    }
  }

  return { frames, inString };
}

/** Appends the closers that would balance `frames`, innermost first. */
function close(text: string, frames: Frame[]): string {
  let out = text;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    out += frames[index].type === "object" ? "}" : "]";
  }
  return out;
}

/** Drops a trailing comma (and whitespace) left behind after truncating a member. */
function trimDanglingComma(text: string): string {
  return text.replace(/[\s,]+$/, "");
}

/**
 * Repair attempts in decreasing fidelity: first keep the partial string, then progressively discard
 * the innermost incomplete member and its enclosing frames.
 */
function* repairCandidates(text: string, scan: Scan): Generator<string> {
  const { frames, inString } = scan;

  if (inString) {
    // A trailing `\` or half-written `\uXXXX` would make the closing quote invalid.
    const body = text.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
    const innermost = frames[frames.length - 1];
    // A closed-off *key* is not a value; `{"a":1,"b` must become `{"a":1}`, not `{"a":1,"b":}`.
    if (innermost?.type === "object" && !innermost.hasColon) {
      const dropped = trimDanglingComma(text.slice(0, innermost.memberStart));
      // Dropping the key can empty the container entirely. An `{}` stranded at the end of an array
      // would render as a blank row, so fall through and let the next candidate drop the container.
      const emptied = dropped.endsWith("{") || dropped.endsWith("[");
      if (!emptied || frames.length === 1) yield close(dropped, frames);
    } else {
      yield close(`${body}"`, frames);
    }
  } else {
    yield close(trimDanglingComma(text), frames);
  }

  for (let depth = frames.length - 1; depth >= 0; depth -= 1) {
    const kept = frames.slice(0, depth + 1);
    const truncated = trimDanglingComma(text.slice(0, frames[depth].memberStart));
    // Same reasoning as above: a nested container left with no members is noise, not data.
    if (depth > 0 && (truncated.endsWith("{") || truncated.endsWith("["))) continue;
    yield close(truncated, kept);
  }
}

/**
 * Parses a possibly-truncated JSON object, returning whatever fields are already complete.
 *
 * Returns `undefined` when nothing usable can be recovered — including for a buffer that has not
 * yet reached its opening `{`, since tool arguments are always objects.
 */
export function parsePartialJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const scan = scanJson(trimmed);
  for (const candidate of repairCandidates(trimmed, scan)) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * The arguments to render for a tool card: the settled arguments once pi has parsed them, or the
 * best-effort reading of the bytes streamed so far.
 */
export function readableArgs(entry: {
  args?: Record<string, unknown>;
  partialArgs?: string;
}): Record<string, unknown> | undefined {
  return entry.args ?? parsePartialJson(entry.partialArgs);
}
