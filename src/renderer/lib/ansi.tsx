/**
 * Minimal ANSI SGR parser for pi extension output.
 *
 * Only select-graphic-rendition is handled: extension widgets, status chips and tool output are
 * plain colored text, never cursor-addressed. Anything else is dropped rather than rendered.
 */

import type { CSSProperties, ReactElement } from "react";

export interface AnsiSpan {
  text: string;
  style: CSSProperties;
}

/** Standard 16-colour palette, matching typical dark-terminal rendering. */
const BASE_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

/** Resolves an xterm-256 index to a hex colour. */
function color256(index: number): string {
  if (index < 16) return BASE_COLORS[index];
  if (index < 232) {
    const n = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36) % 6];
    const g = steps[Math.floor(n / 6) % 6];
    const b = steps[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

/**
 * Consumes an extended colour sequence (`38;5;n` or `38;2;r;g;b`) starting at `i`,
 * which points at the `5` or `2` selector. Returns the colour and the last index consumed.
 */
function readExtendedColor(codes: number[], i: number): { color?: string; next: number } {
  const selector = codes[i];
  if (selector === 5 && i + 1 < codes.length) {
    return { color: color256(codes[i + 1]), next: i + 1 };
  }
  if (selector === 2 && i + 3 < codes.length) {
    return { color: `rgb(${codes[i + 1]},${codes[i + 2]},${codes[i + 3]})`, next: i + 3 };
  }
  return { next: i };
}

function applyCodes(style: CSSProperties, codes: number[]): CSSProperties {
  let next = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.fontWeight = "bold";
    else if (code === 2) next.opacity = 0.65;
    else if (code === 3) next.fontStyle = "italic";
    else if (code === 4) next.textDecoration = "underline";
    else if (code === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (code === 23) delete next.fontStyle;
    else if (code === 24) delete next.textDecoration;
    else if (code >= 30 && code <= 37) next.color = BASE_COLORS[code - 30];
    else if (code >= 90 && code <= 97) next.color = BASE_COLORS[code - 90 + 8];
    else if (code === 39) delete next.color;
    else if (code >= 40 && code <= 47) next.backgroundColor = BASE_COLORS[code - 40];
    else if (code >= 100 && code <= 107) next.backgroundColor = BASE_COLORS[code - 100 + 8];
    else if (code === 49) delete next.backgroundColor;
    else if (code === 38 || code === 48) {
      const { color, next: consumed } = readExtendedColor(codes, i + 1);
      if (color) {
        if (code === 38) next.color = color;
        else next.backgroundColor = color;
      }
      i = consumed;
    }
  }
  return next;
}

// SGR only; other CSI sequences are matched so they can be discarded.
// Built from a char code because a literal ESC is a control character in a regex literal.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)([A-Za-z])`, "g");

/** Splits ANSI-coded text into styled spans. */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: CSSProperties = {};
  let cursor = 0;

  ANSI_PATTERN.lastIndex = 0;
  let match = ANSI_PATTERN.exec(input);
  while (match !== null) {
    if (match.index > cursor) {
      spans.push({ text: input.slice(cursor, match.index), style });
    }
    if (match[2] === "m") {
      const codes = match[1]
        .split(";")
        .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
        .filter((code) => !Number.isNaN(code));
      style = applyCodes(style, codes.length ? codes : [0]);
    }
    cursor = match.index + match[0].length;
    match = ANSI_PATTERN.exec(input);
  }

  if (cursor < input.length) {
    spans.push({ text: input.slice(cursor), style });
  }
  return spans;
}

/** Renders ANSI-coded text as styled spans. */
export function AnsiText({ text, className }: { text: string; className?: string }): ReactElement {
  const spans = parseAnsi(text);
  return (
    <span className={className}>
      {spans.map((span, index) => (
        // Spans are positional within an immutable string; index is a stable key here.
        <span key={index} style={span.style}>
          {span.text}
        </span>
      ))}
    </span>
  );
}
