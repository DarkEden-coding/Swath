/**
 * Prompt composer: text, image attachments, `@file` completion and the `/command` palette.
 *
 * Slash commands are sent to pi as ordinary prompts — pi expands extension commands, skills and
 * prompt templates itself, so the palette only needs to help the user type the name.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PiCommand, PiImageContent } from "../../../../shared/ipc/piRpc";

/** Maximum attachments accepted per message. */
const MAX_IMAGES = 8;

interface ComposerProps {
  paneId: string;
  cwd: string;
  commands: PiCommand[];
  streaming: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (message: string, images: PiImageContent[]) => void;
  onCycleModel: () => void;
  onCycleThinking: () => void;
}

/** The `@` or `/` token being typed at the caret, if any. Exported for testing. */
export function activeToken(
  text: string,
  caret: number,
): { kind: "@" | "/"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)([@/])([^\s]*)$/.exec(before);
  if (!match) return null;
  // `/` only opens the palette at the very start of the message, as in the TUI.
  if (match[2] === "/" && match.index + match[1].length !== 0) return null;
  return {
    kind: match[2] as "@" | "/",
    query: match[3],
    start: caret - match[3].length - 1,
  };
}

async function fileToImage(file: File): Promise<PiImageContent | null> {
  if (!file.type.startsWith("image/")) return null;
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { type: "image", data: btoa(binary), mimeType: file.type };
}

export function Composer({
  paneId,
  cwd,
  commands,
  streaming,
  value,
  onChange,
  onSubmit,
  onCycleModel,
  onCycleThinking,
}: ComposerProps): JSX.Element {
  const [images, setImages] = useState<PiImageContent[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The file list is only needed once the user types `@`, so it loads lazily.
  const token = activeToken(value, caret);
  const needsFiles = token?.kind === "@";
  useEffect(() => {
    if (!needsFiles || files.length > 0) return;
    void window.swath.pi
      .rpc({ op: "files", paneId, cwd })
      .then((result) => {
        const list = (result as { files?: string[] } | null)?.files;
        if (Array.isArray(list)) setFiles(list);
      })
      .catch(() => setFiles([]));
  }, [needsFiles, files.length, paneId, cwd]);

  const suggestions = useMemo(() => {
    if (!token) return [];
    const query = token.query.toLowerCase();
    if (token.kind === "/") {
      return commands
        .filter((command) => command.name.toLowerCase().includes(query))
        .slice(0, 10)
        .map((command) => ({ label: command.name, hint: command.description }));
    }
    return files
      .filter((file) => file.toLowerCase().includes(query))
      .slice(0, 10)
      .map((file) => ({ label: file, hint: "" }));
  }, [token, commands, files]);

  // Reset the selection whenever the query changes, adjusted during render rather than in an
  // effect. Also clamped, so a shrinking list can never leave the highlight out of range.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setHighlight(0);
  }
  const selected = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const accept = (label: string): void => {
    if (!token) return;
    const next = `${value.slice(0, token.start)}${token.kind}${label} ${value.slice(caret)}`;
    onChange(next);
    inputRef.current?.focus();
  };

  const addImages = async (list: FileList | File[]): Promise<void> => {
    const converted = await Promise.all(Array.from(list).map(fileToImage));
    const valid = converted.filter((image): image is PiImageContent => image !== null);
    if (valid.length) setImages((current) => [...current, ...valid].slice(0, MAX_IMAGES));
  };

  const submit = (): void => {
    const message = value.trim();
    if (!message && images.length === 0) return;
    onSubmit(message, images);
    setImages([]);
  };

  return (
    <div
      className={`shrink-0 border-t p-2 ${dragging ? "border-swath-accent bg-[#111b2a]" : "border-swath-border"}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addImages(event.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 ? (
        <div className="mb-1 max-h-48 overflow-auto rounded border border-swath-border bg-swath-panel">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.label}
              type="button"
              className={`flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono text-[12px] ${
                index === selected ? "bg-[#1f2a37] text-swath-text" : "text-swath-muted"
              }`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => accept(suggestion.label)}
            >
              <span className="shrink-0 text-swath-text">{suggestion.label}</span>
              {suggestion.hint ? (
                <span className="truncate text-[11px]">{suggestion.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {images.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {images.map((image, index) => (
            <button
              key={index}
              type="button"
              title="Remove attachment"
              className="rounded border border-swath-border px-2 py-0.5 font-mono text-[11px] text-swath-muted hover:border-swath-accent hover:text-swath-text"
              onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
            >
              image {index + 1} ✕
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        ref={inputRef}
        className="h-16 w-full resize-none rounded border border-swath-border bg-[#0d1117] p-2 font-mono text-[12px] text-swath-text outline-none focus:border-swath-accent"
        placeholder={streaming ? "Queue a follow-up…" : "Message pi…   @file  /command"}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          const items = Array.from(event.clipboardData.files);
          if (items.length) {
            event.preventDefault();
            void addImages(items);
          }
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key.toLowerCase() === "p") {
            event.preventDefault();
            onCycleModel();
            return;
          }
          if (event.shiftKey && event.key === "Tab") {
            event.preventDefault();
            onCycleThinking();
            return;
          }
          if (suggestions.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight(
                (current) => (Math.min(current, suggestions.length - 1) + 1) % suggestions.length,
              );
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight(
                (current) =>
                  (Math.min(current, suggestions.length - 1) - 1 + suggestions.length) %
                  suggestions.length,
              );
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault();
              accept(suggestions[selected].label);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
    </div>
  );
}
