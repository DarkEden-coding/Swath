/**
 * Prompt composer: text, image attachments, `@file` completion and the `/command` palette.
 *
 * Slash commands are sent to pi as ordinary prompts — pi expands extension commands, skills and
 * prompt templates itself, so the palette only needs to help the user type the name.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PiCommand, PiImageContent, PiThinkingLevel } from "../../../../shared/ipc/piRpc";
import type { TerminalClipboardPayload } from "../../../../shared/types";
import type { AttachedImage } from "./piPaneCache";
import { mentionsForPane, rememberMention } from "./piPaneCache";
import { expandMentions, mentionLabels, mentionSpanAfter, mentionSpanBefore } from "./mentions";
import { usePiRoots } from "./PiRootsContext";

/** Maximum attachments accepted per message. */
const MAX_IMAGES = 8;

interface ComposerProps {
  paneId: string;
  cwd: string;
  commands: PiCommand[];
  streaming: boolean;
  thinkingLevel?: PiThinkingLevel;
  value: string;
  images: AttachedImage[];
  onChange: (value: string) => void;
  onImagesChange: (images: AttachedImage[]) => void;
  onSubmit: (message: string, images: PiImageContent[]) => void;
  onCycleModel: () => void;
  onCycleThinking: () => void;
}

/**
 * Attachment bookkeeping mirroring the pi `clipboard-image-paste` extension: each image gets an
 * `[Image N]` placeholder in the prompt text, and deleting the placeholder detaches the image.
 * That extension is inert under `--mode rpc` (stdout carries the protocol, not a TUI), so the
 * composer reimplements its contract here.
 */
export function attachImages(
  text: string,
  images: AttachedImage[],
  added: PiImageContent[],
): { text: string; images: AttachedImage[] } {
  let counter = images.reduce(
    (highest, image) =>
      Math.max(highest, Number(/\[Image (\d+)]/.exec(image.placeholder)?.[1] ?? 0)),
    0,
  );
  const attached = added.slice(0, MAX_IMAGES - images.length).map((image) => {
    counter += 1;
    return { ...image, placeholder: `[Image ${counter}]` };
  });
  if (attached.length === 0) return { text, images };
  const nextText = attached.reduce(
    (accumulated, image) =>
      accumulated && !accumulated.endsWith(" ")
        ? `${accumulated} ${image.placeholder}`
        : `${accumulated}${image.placeholder}`,
    text,
  );
  return { text: nextText, images: [...images, ...attached] };
}

/** Removes the placeholder at the end of the prompt together with its image, or returns null. */
export function removeTrailingImage(
  text: string,
  images: AttachedImage[],
): { text: string; images: AttachedImage[] } | null {
  const trimmed = text.trimEnd();
  const image = images.find((candidate) => trimmed.endsWith(candidate.placeholder));
  if (!image) return null;
  return {
    text: trimmed.slice(0, trimmed.length - image.placeholder.length).trimEnd(),
    images: images.filter((candidate) => candidate !== image),
  };
}

/** Images still referenced by the prompt; the rest were detached by editing their placeholder. */
export function imagesForText(text: string, images: AttachedImage[]): AttachedImage[] {
  return images.filter((image) => text.includes(image.placeholder));
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

/** Returns image files exposed through either WebKit clipboard collection. */
export function clipboardImageFiles(data: Pick<DataTransfer, "files" | "items">): File[] {
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  if (files.length) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
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
  images,
  onChange,
  onImagesChange,
  onSubmit,
  onCycleModel,
  onCycleThinking,
}: ComposerProps): JSX.Element {
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
  // `@` offers the whole project: this folder, and every other folder of its group.
  const roots = usePiRoots(cwd);
  useEffect(() => {
    if (!needsFiles || files.length > 0) return;
    void window.swath.pi
      .rpc({ op: "files", paneId, cwd, paths: roots })
      .then((result) => {
        const list = (result as { files?: string[] } | null)?.files;
        if (Array.isArray(list)) setFiles(list);
      })
      .catch(() => setFiles([]));
  }, [needsFiles, files.length, paneId, cwd, roots]);

  // Candidates read as a path from their own project's root; pi is given the resolvable path on
  // send. Mentions inserted earlier stay known even after the file list is dropped on a remount.
  const labelToPath = useMemo(() => mentionLabels(roots, files), [roots, files]);
  // Rebuilt each render on purpose: the per-pane registry is mutable, and both maps are small.
  const knownMentions = new Map([...mentionsForPane(paneId), ...labelToPath]);

  const suggestions = useMemo(() => {
    if (!token) return [];
    const query = token.query.toLowerCase();
    if (token.kind === "/") {
      return commands
        .filter((command) => command.name.toLowerCase().includes(query))
        .slice(0, 10)
        .map((command) => ({ label: command.name, hint: command.description }));
    }
    return [...labelToPath.keys()]
      .filter((label) => label.toLowerCase().includes(query))
      .slice(0, 10)
      .map((label) => ({ label, hint: "" }));
  }, [token, commands, labelToPath]);

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
    const path = labelToPath.get(label);
    if (token.kind === "@" && path !== undefined) rememberMention(paneId, label, path);
    const next = `${value.slice(0, token.start)}${token.kind}${label} ${value.slice(caret)}`;
    onChange(next);
    inputRef.current?.focus();
  };

  /** Attaches images and appends their placeholders, kept in one place so both stay in sync. */
  const attach = (added: PiImageContent[]): void => {
    if (added.length === 0) return;
    const next = attachImages(value, images, added);
    onChange(next.text);
    onImagesChange(next.images);
    inputRef.current?.focus();
  };

  const addImages = async (list: FileList | File[]): Promise<void> => {
    const converted = await Promise.all(Array.from(list).map(fileToImage));
    attach(converted.filter((image): image is PiImageContent => image !== null));
  };

  /**
   * Reads the OS clipboard directly. The app menu binds Cmd/Ctrl+V to a custom item (see
   * `src-tauri/src/menu.rs`), so the webview never receives a native paste event for the
   * shortcut — this is the only paste path for the keyboard, not just an image fallback.
   */
  const pasteFromNativeClipboard = async (): Promise<void> => {
    try {
      const payload = await window.swath.clipboard.readForTerminal();
      const image = clipboardImageToPng(payload);
      if (image) {
        attach([image]);
        return;
      }
      if (payload.hasImage) {
        console.error("Clipboard image could not be decoded", {
          width: payload.imageWidth,
          height: payload.imageHeight,
          bytes: payload.imageData?.length,
        });
      }
      if (payload.text) insertText(payload.text);
    } catch (error) {
      console.error("Unable to paste clipboard contents", error);
    }
  };

  const insertText = (text: string): void => {
    const input = inputRef.current;
    const current = value;
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    onChange(current.slice(0, start) + text + current.slice(end));
    setCaret(start + text.length);
    input?.focus();
  };

  // Cmd/Ctrl+V arrives as an app-menu command, never as a DOM paste event. Only the focused
  // composer may claim it, so a background pi tab does not steal the terminal's paste.
  useEffect(() => {
    const onMenuPaste = (): void => {
      if (document.activeElement !== inputRef.current) return;
      void pasteFromNativeClipboard();
    };
    window.addEventListener("swath:terminal-paste", onMenuPaste);
    return () => window.removeEventListener("swath:terminal-paste", onMenuPaste);
  }, [pasteFromNativeClipboard]);

  // Editing a placeholder out of the prompt detaches its image, so the strip only previews
  // what the next message will actually carry.
  const attachedInPrompt = imagesForText(value, images);

  const submit = (): void => {
    const message = expandMentions(value.trim(), knownMentions);
    const attached = imagesForText(message, images);
    if (!message && attached.length === 0) return;
    onSubmit(message, attached);
    onImagesChange([]);
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

      {attachedInPrompt.length > 0 ? (
        <div className="pi-image-previews" aria-label="Image attachments">
          {attachedInPrompt.map((image) => (
            <button
              key={image.placeholder}
              type="button"
              title={`Remove ${image.placeholder}`}
              className="pi-image-preview"
              onClick={() => {
                onChange(value.replace(image.placeholder, "").replace(/ {2,}/g, " ").trimEnd());
                onImagesChange(images.filter((candidate) => candidate !== image));
              }}
            >
              <img src={imagePreviewSource(image)} alt={image.placeholder} />
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
          // Reached by context-menu paste; the keyboard shortcut goes through the menu command.
          const pasted = clipboardImageFiles(event.clipboardData);
          if (pasted.length > 0) {
            event.preventDefault();
            void addImages(pasted);
            return;
          }
          const hasImageItem = Array.from(event.clipboardData.items).some((item) =>
            item.type.startsWith("image/"),
          );
          if (hasImageItem || !event.clipboardData.getData("text/plain")) {
            event.preventDefault();
            void pasteFromNativeClipboard();
          }
        }}
        onKeyDown={(event) => {
          // Backspace at the end of the prompt detaches the trailing image, as pi's TUI does.
          if (
            event.key === "Backspace" &&
            event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
            event.currentTarget.selectionStart === value.length
          ) {
            const next = removeTrailingImage(value, images);
            if (next) {
              event.preventDefault();
              onChange(next.text);
              onImagesChange(next.images);
              return;
            }
          }
          // A mention was inserted as one object, so it deletes as one: a single Backspace or
          // Delete takes the whole path rather than one character of it.
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            event.currentTarget.selectionStart === event.currentTarget.selectionEnd
          ) {
            const caret = event.currentTarget.selectionStart ?? 0;
            const span =
              event.key === "Backspace"
                ? mentionSpanBefore(value, caret, knownMentions.keys())
                : mentionSpanAfter(value, caret, knownMentions.keys());
            if (span) {
              event.preventDefault();
              onChange(value.slice(0, span.start) + value.slice(span.end));
              setCaret(span.start);
              window.requestAnimationFrame(() =>
                inputRef.current?.setSelectionRange(span.start, span.start),
              );
              return;
            }
          }
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
