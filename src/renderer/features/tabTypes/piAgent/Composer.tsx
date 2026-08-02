/**
 * Prompt composer: text, image attachments, `@file` completion and the `/command` palette.
 *
 * Slash commands are sent to pi as ordinary prompts — pi expands extension commands, skills and
 * prompt templates itself, so the palette only needs to help the user type the name.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PiCommand, PiImageContent, PiThinkingLevel } from "../../../../shared/ipc/piRpc";
import type { TerminalClipboardPayload } from "../../../../shared/types";

/** Maximum attachments accepted per message. */
const MAX_IMAGES = 8;

interface ComposerProps {
  paneId: string;
  cwd: string;
  commands: PiCommand[];
  streaming: boolean;
  thinkingLevel?: PiThinkingLevel;
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

/** Encodes the native clipboard's RGBA pixels as the PNG payload Pi expects. */
function clipboardImageToPng(payload: TerminalClipboardPayload): PiImageContent | null {
  if (!payload.imageData || !payload.imageWidth || !payload.imageHeight) return null;
  const binary = atob(payload.imageData);
  const expectedLength = payload.imageWidth * payload.imageHeight * 4;
  if (binary.length !== expectedLength) return null;

  const pixels = new Uint8ClampedArray(expectedLength);
  for (let index = 0; index < binary.length; index += 1) pixels[index] = binary.charCodeAt(index);
  const canvas = document.createElement("canvas");
  canvas.width = payload.imageWidth;
  canvas.height = payload.imageHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(pixels, payload.imageWidth, payload.imageHeight), 0, 0);
  return {
    type: "image",
    data: canvas.toDataURL("image/png").split(",")[1],
    mimeType: "image/png",
  };
}

/** Returns a browser-safe source for an attached image preview. */
export function imagePreviewSource(image: PiImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function Composer({
  paneId,
  cwd,
  commands,
  streaming,
  thinkingLevel,
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

  // Grow with the prompt while keeping an empty composer to one text line.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0";
    input.style.height = `${input.scrollHeight}px`;
  }, [value]);

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

  /** Uses the same native clipboard reader as terminal paste when WebKit omits image files. */
  const addNativeClipboardImage = async (): Promise<void> => {
    try {
      const image = clipboardImageToPng(await window.swath.clipboard.readForTerminal());
      if (image) setImages((current) => [...current, image].slice(0, MAX_IMAGES));
    } catch (error) {
      console.error("Unable to paste clipboard image", error);
    }
  };

  const submit = (): void => {
    const message = value.trim();
    if (!message && images.length === 0) return;
    onSubmit(message, images);
    setImages([]);
  };

  return (
    <div
      className={`pi-composer shrink-0 ${dragging ? "bg-[#111b2a]" : ""}`}
      data-thinking={thinkingLevel ?? "medium"}
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
        <div className="mb-1 max-h-48 overflow-auto rounded border border-[var(--pi-border)] bg-[var(--pi-surface)]">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.label}
              type="button"
              className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] ${
                index === selected ? "bg-[#172235] text-[var(--pi-text)]" : "text-[var(--pi-muted)]"
              }`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => accept(suggestion.label)}
            >
              <span className="shrink-0 text-[var(--pi-text)]">{suggestion.label}</span>
              {suggestion.hint ? (
                <span className="truncate text-[11px]">{suggestion.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {images.length > 0 ? (
        <div className="pi-image-previews" aria-label="Image attachments">
          {images.map((image, index) => (
            <button
              key={`${image.data.slice(0, 24)}-${index}`}
              type="button"
              title="Remove image"
              className="pi-image-preview"
              onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
            >
              <img src={imagePreviewSource(image)} alt="" />
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        ref={inputRef}
        rows={1}
        placeholder={streaming ? "Queue a follow-up…" : "Message pi…   @file  /command"}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (images.length > 0) {
            event.preventDefault();
            void addImages(images);
            return;
          }
          if (!event.clipboardData.getData("text/plain")) {
            event.preventDefault();
            void addNativeClipboardImage();
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
