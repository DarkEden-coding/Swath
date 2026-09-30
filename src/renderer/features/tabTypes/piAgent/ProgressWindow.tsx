import { useCallback, useLayoutEffect, useRef } from "react";
import type { PiProgressMessage } from "./progressMessages";

interface ProgressWindowProps {
  messages: readonly PiProgressMessage[];
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}

/** Keeps the bottom pinned, or offsets a retained item when older messages leave the bounded list. */
export function progressScrollTop(
  following: boolean,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  anchorDelta = 0,
): number {
  const bottom = Math.max(0, scrollHeight - clientHeight);
  return following ? bottom : Math.max(0, Math.min(bottom, scrollTop + anchorDelta));
}

/** Keeps agent updates separate from the transcript without taking focus from the composer. */
export function ProgressWindow({
  messages,
  hidden,
  onHiddenChange,
}: ProgressWindowProps): JSX.Element | null {
  const scrollRef = useRef<HTMLOListElement>(null);
  const followingRef = useRef(true);
  const savedScrollTopRef = useRef(0);
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  const hasMessages = messages.length > 0;

  /** Restores the same visible item after updates, wrapping, resizing, or showing the window. */
  const alignList = useCallback((): void => {
    const node = scrollRef.current;
    if (!node) return;
    const anchor = anchorRef.current;
    const retained = anchor
      ? Array.from(node.children).find(
          (item) => (item as HTMLElement).dataset.progressId === anchor.id,
        )
      : undefined;
    const anchorDelta =
      retained && anchor
        ? retained.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
        : 0;
    node.scrollTop = progressScrollTop(
      followingRef.current,
      retained ? node.scrollTop : savedScrollTopRef.current,
      node.scrollHeight,
      node.clientHeight,
      anchorDelta,
    );
    savedScrollTopRef.current = node.scrollTop;
  }, []);

  useLayoutEffect(alignList, [alignList, messages, hidden]);
  useLayoutEffect(() => {
    if (!hasMessages) {
      followingRef.current = true;
      savedScrollTopRef.current = 0;
      anchorRef.current = null;
    }
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(alignList);
    observer.observe(node);
    return () => observer.disconnect();
  }, [alignList, hidden, hasMessages]);

  if (!hasMessages) return null;
  if (hidden) {
    return (
      <button
        type="button"
        className="absolute right-3 top-3 z-20 rounded-lg border border-[var(--pi-border-muted)] bg-[var(--pi-surface)] px-3 py-2 text-xs text-[var(--pi-muted)] shadow-lg hover:text-[var(--pi-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pi-purple)]"
        aria-label={`Show progress, ${messages.length} updates`}
        aria-expanded={false}
        onClick={() => onHiddenChange(false)}
      >
        Progress · {messages.length}
      </button>
    );
  }
  return (
    <section
      aria-label="Agent progress"
      className="absolute right-3 top-3 z-20 flex max-h-[60%] w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-[var(--pi-border-muted)] bg-[var(--pi-surface)] text-xs text-[var(--pi-text)] shadow-xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pi-border-muted)] px-3 py-2">
        <h2 className="font-medium">
          Progress <span className="text-[var(--pi-dim)]">· {messages.length}</span>
        </h2>
        <button
          type="button"
          className="rounded px-1 text-[var(--pi-muted)] hover:text-[var(--pi-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pi-purple)]"
          aria-label="Hide progress"
          aria-expanded={true}
          onClick={() => onHiddenChange(true)}
        >
          Hide
        </button>
      </div>
      <ol
        ref={scrollRef}
        aria-label="Progress updates, oldest first"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          followingRef.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
          savedScrollTopRef.current = node.scrollTop;
          const top = node.getBoundingClientRect().top;
          const visible = Array.from(node.children).find(
            (item) => item.getBoundingClientRect().bottom > top,
          );
          anchorRef.current =
            !followingRef.current && visible
              ? {
                  id: (visible as HTMLElement).dataset.progressId!,
                  offset: visible.getBoundingClientRect().top - top,
                }
              : null;
        }}
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 overflow-auto overscroll-contain px-3 [overflow-anchor:none]"
      >
        {messages.map((entry) => (
          <li
            key={entry.id}
            data-progress-id={entry.id}
            className="border-b border-[var(--pi-border-muted)] py-2 last:border-b-0"
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
              <span
                className={
                  entry.role === "user"
                    ? "font-medium text-[var(--pi-cyan)]"
                    : "text-[var(--pi-muted)]"
                }
              >
                {entry.role === "user" ? "You" : "Agent"}
              </span>
              <time
                dateTime={new Date(entry.timestamp).toISOString()}
                className="text-[var(--pi-dim)]"
              >
                {new Date(entry.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.message}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
