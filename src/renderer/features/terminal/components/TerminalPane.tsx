import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { AppSettings, ShellProfile } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { findPane } from "../../../domain/layout/layoutTree";
import { useUiStore } from "../../../state/uiStore";
import { terminalClient } from "../../../services/terminalClient";
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";
import { TerminalContextMenu } from "./TerminalContextMenu";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalViewport } from "./TerminalViewport";
import { TERMINAL_COL_RESERVE } from "../hooks/useTerminalInstance";
import { readTerminalPastePayload } from "../hooks/useTerminalClipboard";
import { createTerminalInputController, type TerminalInputController } from "../input/terminalInputController";
import { TERMINAL_SCROLLBACK_LINES } from "../../../../shared/memoryLimits";
import {
  captureTerminalScrollState,
  detachCachedTerminalElement,
  disposeCachedTerminal,
  exitStateSetters,
  restoreTerminalScrollState,
  startedSessions,
  terminalCache,
} from "../runtime/terminalCache";

const TERMINAL_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#0d1117",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
} as const;

function shellFor(settings: AppSettings): ShellProfile | null {
  return settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ?? settings.shellProfiles[0] ?? null;
}

function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return Object.fromEntries(env.map((item) => [item.name, item.value]));
  return env as Record<string, string>;
}

function removeForeignTerminalElements(host: HTMLElement, currentElement: HTMLElement | undefined): void {
  Array.from(host.children).forEach((child) => {
    if (child === currentElement) return;
    if (child.classList.contains("xterm")) host.removeChild(child);
  });
}

export function TerminalPane({ workspace, view, pane, settings }: PaneComponentProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const inputControllerRef = useRef<TerminalInputController | null>(null);
  const bannerSentRef = useRef(false);
  const dormantInputRef = useRef("");
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const webLinksDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [exited, setExited] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;

  const initialSettingsRef = useRef(settings);
  const initialShellProfileRef = useRef<ShellProfile | null>(shellFor(settings));

  const paneMeta = findPane(view.layout, paneId);
  const headerLine = paneMeta?.title ?? paneMeta?.metadata?.title ?? paneMeta?.promptLabel ?? `${workspace.name}`;
  const paneShellProfile = paneMeta?.shellProfile ?? paneMeta?.metadata?.shellProfile ?? initialShellProfileRef.current;

  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  useEffect(() => {
    bannerSentRef.current = false;
  }, [paneId, view.id]);

  useEffect(() => {
    if (!isActive) return;

    const host = hostRef.current;
    if (!host) return;

    if (startedSessions.has(paneId)) terminalClient.setStreaming(paneId, true);

    exitStateSetters.set(paneId, setExited);

    const cachedEntry = terminalCache.get(paneId);
    setExited(cachedEntry?.stopped ?? false);

    const terminal =
      cachedEntry?.terminal ??
      new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: initialSettingsRef.current.cursorBlink,
        cursorStyle: initialSettingsRef.current.cursorStyle,
        fontFamily: initialSettingsRef.current.fontFamily,
        fontSize: initialSettingsRef.current.fontSize,
        lineHeight: initialSettingsRef.current.lineHeight,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        theme: TERMINAL_THEME,
      });

    const fit = cachedEntry?.fit ?? new FitAddon();
    if (cachedEntry) {
      const terminalElement = terminal.element;
      removeForeignTerminalElements(host, terminalElement);
      if (terminalElement && terminalElement.parentElement !== host) host.appendChild(terminalElement);
    } else {
      removeForeignTerminalElements(host, undefined);
      terminal.loadAddon(fit);
      terminal.open(host);
    }

    termRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = null;
    inputControllerRef.current?.dispose();
    inputControllerRef.current = createTerminalInputController({
      terminal,
      shellProfile: paneShellProfile,
      readClipboard: readTerminalPastePayload,
      writeClipboardText: (text) => window.swath.clipboard.writeText(text),
      writeTerminalData: (data) => terminalClient.write(paneId, data),
      openSearch: () => setSearchOpen(true),
      platform: window.swath.platform,
      onPasteError: (error) => {
        console.error("Unable to read the clipboard", error);
        terminal.write("\r\n\x1b[31m[clipboard paste failed]\x1b[0m\r\n");
      },
    });

    const currentCwd = paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path;

    const startPty = (): void => {
      if (startedSessions.has(paneId) || !termRef.current) return;
      startedSessions.add(paneId);
      const entry = terminalCache.get(paneId);
      if (entry) entry.stopped = false;
      exitStateSetters.get(paneId)?.(false);
      terminalClient.create({
        sessionId: paneId,
        cwd: currentCwd,
        cols: termRef.current.cols,
        rows: termRef.current.rows,
        shellProfile: paneShellProfile,
        env: paneMeta?.env ?? normalizeEnv(paneMeta?.metadata?.env) ?? initialSettingsRef.current.globalEnv,
      });
    };

    const fitAndResize = (): void => {
      if (!termRef.current || !fitRef.current) return;
      const dimensions = fitRef.current.proposeDimensions();
      if (!dimensions) return;

      const cols = Math.max(2, dimensions.cols - TERMINAL_COL_RESERVE);
      if (terminal.cols !== cols || terminal.rows !== dimensions.rows) {
        terminal.resize(cols, dimensions.rows);
      }
      if (startedSessions.has(paneId)) terminalClient.resize({ sessionId: paneId, cols: terminal.cols, rows: terminal.rows });
    };

    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);

    requestAnimationFrame(() => {
      fitAndResize();
      if (cachedEntry) {
        restoreTerminalScrollState(cachedEntry);
        terminal.focus();
      } else if (startedSessions.has(paneId)) {
        void terminalClient.replay(paneId);
      } else {
        const prompt = `${currentCwd} % `;
        terminal.write(prompt);
        terminal.focus();
      }
    });

    const isDormantIgnoredInput = (data: string): boolean => data === "\x1b[3~";

    dormantInputRef.current = "";

    const disposable = cachedEntry
      ? null
      : terminal.onData((data) => {
          if (startedSessions.has(paneId)) {
            terminalClient.write(paneId, data);
            return;
          }

          if (!data || isDormantIgnoredInput(data)) return;

          if (data === "\r") {
            terminal.write("\r\x1b[K");
            startPty();
            terminalClient.write(paneId, dormantInputRef.current + "\r");
            dormantInputRef.current = "";
          } else if (data === "\x7f") {
            if (dormantInputRef.current.length > 0) {
              dormantInputRef.current = dormantInputRef.current.slice(0, -1);
              terminal.write("\b \b");
            }
          } else {
            dormantInputRef.current += data;
            terminal.write(data);
          }
        });
    const removeDataListener = cachedEntry ? null : terminalClient.onData((sessionId, data) => {
      if (sessionId !== paneId) return;
      terminal.write(data);
    });
    const removeExitListener = cachedEntry
      ? null
      : terminalClient.onExit((sessionId) => {
          if (sessionId !== paneId) return;
          startedSessions.delete(sessionId);
          exitStateSetters.get(paneId)?.(true);
          const entry = terminalCache.get(paneId);
          if (entry) entry.stopped = true;
          const message = "\r\n\x1b[2m[process exited — close, restart, or split a new terminal]\x1b[0m\r\n";
          terminal.write(message);
        });

    if (!cachedEntry) {
      terminalCache.set(paneId, {
        terminal,
        fit,
        disposeResources: () => {
          disposable?.dispose();
          removeDataListener?.();
          removeExitListener?.();
          terminal.dispose();
        },
        stopped: false,
      });
    }

    const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
    const showScrollbar = (): void => {
      host.classList.add("is-scrolling");
      if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
      scrollbarHideTimerRef.current = window.setTimeout(() => {
        host.classList.remove("is-scrolling");
        scrollbarHideTimerRef.current = null;
      }, 800);
    };
    viewport?.addEventListener("scroll", showScrollbar, { passive: true });

    return () => {
      observer.disconnect();
      viewport?.removeEventListener("scroll", showScrollbar);
      if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
      host.classList.remove("is-scrolling");
      webLinksDisposableRef.current?.dispose();
      webLinksDisposableRef.current = null;
      const entry = terminalCache.get(paneId);
      if (entry?.stopped) {
        disposeCachedTerminal(paneId);
      } else if (entry) {
        captureTerminalScrollState(entry);
        detachCachedTerminalElement(entry, host);
        if (exitStateSetters.get(paneId) === setExited) exitStateSetters.delete(paneId);
      }
      inputControllerRef.current?.dispose();
      inputControllerRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [isActive, paneId, view.id, workspace.path]);

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;

    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.lineHeight = settings.lineHeight;
    terminal.options.cursorBlink = settings.cursorBlink;
    terminal.options.cursorStyle = settings.cursorStyle;
    requestAnimationFrame(() => {
      const dimensions = fitRef.current?.proposeDimensions();
      if (!termRef.current || !dimensions) return;
      const cols = Math.max(2, dimensions.cols - TERMINAL_COL_RESERVE);
      if (termRef.current.cols !== cols || termRef.current.rows !== dimensions.rows) {
        termRef.current.resize(cols, dimensions.rows);
      }
      if (startedSessions.has(paneId)) {
        terminalClient.resize({ sessionId: paneId, cols: termRef.current.cols, rows: termRef.current.rows });
      }
    });
  }, [paneId, settings.cursorBlink, settings.cursorStyle, settings.fontFamily, settings.fontSize, settings.lineHeight]);

  useEffect(() => {
    if (!isActive) return;
    termRef.current?.focus();
  }, [isActive]);

  const paste = async (): Promise<void> => {
    await inputControllerRef.current?.pasteFromClipboard();
  };

  useEffect(() => {
    if (!isActive) return;
    const onMenuPaste = (): void => {
      void paste();
    };
    window.addEventListener("swath:terminal-paste", onMenuPaste);
    return () => window.removeEventListener("swath:terminal-paste", onMenuPaste);
  }, [isActive, paneId]);

  const restart = (): void => {
    startedSessions.add(paneId);
    termRef.current?.reset();
    const entry = terminalCache.get(paneId);
    if (entry) entry.stopped = false;
    setExited(false);
    void terminalClient.restart(paneId);
  };

  const close = (): void => {
    appActions.closePane(workspace.id, view.id, paneId);
  };

  const runContextAction = (action: string): void => {
    setContextMenu(null);
    if (action === "copy") void inputControllerRef.current?.copy(true);
    if (action === "paste") void paste();
    if (action === "selectAll") termRef.current?.selectAll();
    if (action === "clear") termRef.current?.clear();
    if (action === "find") setSearchOpen(true);
    if (action === "restart") restart();
    if (action === "rename") {
      const title = window.prompt("Pane title", headerLine)?.trim();
      if (title) appActions.renamePane(workspace.id, view.id, paneId, title);
    }
    if (action === "cwd") {
      const cwd = window.prompt("Initial CWD for next restart", paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path)?.trim();
      if (cwd) appActions.setPaneInitialCwd(workspace.id, view.id, paneId, cwd);
    }
    if (action === "splitRight") appActions.splitPane(workspace.id, view.id, paneId, "vertical");
    if (action === "splitDown") appActions.splitPane(workspace.id, view.id, paneId, "horizontal");
    if (action === "close") close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    inputControllerRef.current?.handleKeyDown(event);
    if (event.key === "Escape") {
      setSearchOpen(false);
      setContextMenu(null);
    }
  };

  const onSearch = (query: string): void => {
    setSearchQuery(query);
    if (query) searchRef.current?.findNext(query);
  };

  useEffect(() => {
    const terminal = termRef.current;
    if (!isActive || !terminal || webLinksDisposableRef.current) return;
    const addon = new WebLinksAddon((_event, uri) => {
      void window.swath.browser.openExternal(uri);
    });
    terminal.loadAddon(addon);
    webLinksDisposableRef.current = addon;
  }, [isActive, paneId]);

  useEffect(() => {
    if (!searchOpen) return;
    const terminal = termRef.current;
    if (!terminal || searchRef.current) return;
    const search = new SearchAddon();
    terminal.loadAddon(search);
    searchRef.current = search;
    if (searchQuery) search.findNext(searchQuery);
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!contextMenu) return;
    const onKeyDownGlobal = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const onClick = (): void => {
      setContextMenu(null);
    };
    window.addEventListener("keydown", onKeyDownGlobal);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDownGlobal);
      window.removeEventListener("click", onClick);
    };
  }, [contextMenu]);

  return (
    <PaneFrame
      active={isActive}
      title={headerLine}
      statusClass={exited ? "exited" : startedSessions.has(paneId) ? "running" : "dormant"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)}
      onClose={close}
      onKeyDown={onKeyDown}
      onCopyCapture={(event: ClipboardEvent<HTMLDivElement>) => inputControllerRef.current?.handleCopyEvent(event)}
      onPasteCapture={(event: ClipboardEvent<HTMLDivElement>) => inputControllerRef.current?.handlePasteEvent(event)}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        if (event.dataTransfer.files.length > 0) event.preventDefault();
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => (file as File & { path?: string }).path)
          .filter((path): path is string => Boolean(path));
        if (paths.length === 0) return;
        event.preventDefault();
        inputControllerRef.current?.pastePaths(paths);
      }}
      onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <TerminalViewport hostRef={hostRef} suspended={!isActive} />
      {searchOpen ? (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={onSearch}
          onPrevious={() => searchRef.current?.findPrevious(searchQuery)}
          onNext={() => searchRef.current?.findNext(searchQuery)}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {contextMenu ? <TerminalContextMenu x={contextMenu.x} y={contextMenu.y} onAction={runContextAction} /> : null}
    </PaneFrame>
  );
}
