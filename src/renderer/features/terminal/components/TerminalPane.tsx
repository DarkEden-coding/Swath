import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
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
import { readTerminalPastePayload } from "../../../utils/terminalPaste";
import { TERMINAL_COL_RESERVE, TERMINAL_THEME } from "../runtime/terminalConfig";
import {
  createTerminalInputController,
  type TerminalInputController,
} from "../input/terminalInputController";
import {
  IMAGE_ADDON_SEQUENCE_SIZE_LIMIT,
  IMAGE_ADDON_STORAGE_LIMIT_MB,
  TERMINAL_SCROLLBACK_LINES,
} from "../../../../shared/memoryLimits";
import {
  captureTerminalScrollState,
  detachCachedTerminalElement,
  disposeCachedTerminal,
  exitStateSetters,
  restoreTerminalScrollState,
  startedSessions,
  terminalCache,
  writeTerminalOutput,
} from "../runtime/terminalCache";

function shellFor(settings: AppSettings): ShellProfile | null {
  return (
    settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ??
    settings.shellProfiles[0] ??
    null
  );
}

function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return Object.fromEntries(env.map((item) => [item.name, item.value]));
  return env as Record<string, string>;
}

function removeForeignTerminalElements(
  host: HTMLElement,
  currentElement: HTMLElement | undefined,
): void {
  Array.from(host.children).forEach((child) => {
    if (child === currentElement) return;
    if (child.classList.contains("xterm")) host.removeChild(child);
  });
}

/** Creates ImageAddon options with conservative IIP/SIXEL limits from memoryLimits. */
function createImageAddon(): ImageAddon {
  return new ImageAddon({
    enableSizeReports: false,
    showPlaceholder: true,
    iipSupport: true,
    sixelSupport: true,
    storageLimit: IMAGE_ADDON_STORAGE_LIMIT_MB,
    iipSizeLimit: IMAGE_ADDON_SEQUENCE_SIZE_LIMIT,
    sixelSizeLimit: IMAGE_ADDON_SEQUENCE_SIZE_LIMIT,
  });
}

/** Render and manage the cached xterm instance for a workspace pane. */
/**
 * The grid `fit` proposes, or null when the pane has no usable size.
 *
 * `proposeDimensions()` divides by the measured cell size, so a pane that is hidden or mid-layout
 * yields NaN or Infinity — and `Terminal.resize` throws "This API only accepts integers" on those,
 * from a ResizeObserver callback where nothing catches it.
 */
function fitDimensions(fit: FitAddon): { cols: number; rows: number } | null {
  const proposed = fit.proposeDimensions();
  if (!proposed) return null;
  const cols = Math.floor(proposed.cols - TERMINAL_COL_RESERVE);
  const rows = Math.floor(proposed.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return { cols: Math.max(2, cols), rows: Math.max(1, rows) };
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
  const [running, setRunning] = useState(() => startedSessions.has(pane.id));
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;

  const initialSettingsRef = useRef(settings);
  const [initialShellProfile] = useState<ShellProfile | null>(() => shellFor(settings));

  const paneMeta = findPane(view.layout, paneId);
  const headerLine =
    paneMeta?.title ?? paneMeta?.metadata?.title ?? paneMeta?.promptLabel ?? `${workspace.name}`;
  const paneShellProfile =
    paneMeta?.shellProfile ?? paneMeta?.metadata?.shellProfile ?? initialShellProfile;

  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  const paneCwd = paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path;
  const paneEnv = paneMeta?.env ?? normalizeEnv(paneMeta?.metadata?.env);
  // `withConfig` structurally clones the whole config, so pane env/shell objects
  // get a fresh identity on every commit. Key the session effect on their content
  // instead; otherwise unrelated UI updates detach and reattach the terminal.
  const paneEnvKey = JSON.stringify(paneEnv ?? null);
  const paneShellProfileKey = paneShellProfile?.id ?? "";
  const sessionInputRef = useRef({ cwd: paneCwd, env: paneEnv, shellProfile: paneShellProfile });

  useEffect(() => {
    sessionInputRef.current = { cwd: paneCwd, env: paneEnv, shellProfile: paneShellProfile };
  });

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
    setRunning(startedSessions.has(paneId));

    const terminal =
      cachedEntry?.terminal ??
      new Terminal({
        allowProposedApi: true,
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
    const image = cachedEntry?.image ?? createImageAddon();
    if (cachedEntry) {
      const terminalElement = terminal.element;
      removeForeignTerminalElements(host, terminalElement);
      if (terminalElement && terminalElement.parentElement !== host)
        host.appendChild(terminalElement);
    } else {
      removeForeignTerminalElements(host, undefined);
      terminal.loadAddon(fit);
      terminal.loadAddon(image);
      terminal.open(host);
    }

    termRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = null;

    const currentCwd = sessionInputRef.current.cwd;

    // Buffer state, not pixel distance: a pane that has silently dropped out of
    // follow mode sits a row short of the bottom, which a pixel threshold hides.
    const updateScrollToBottomButton = (): void => {
      const buffer = terminal.buffer.active;
      setShowScrollToBottom(buffer.viewportY < buffer.baseY);
    };

    const writeOutput = (data: string): void => {
      const entry = terminalCache.get(paneId);
      if (entry) writeTerminalOutput(entry, data, updateScrollToBottomButton);
      else terminal.write(data, updateScrollToBottomButton);
    };

    let sessionReady: Promise<void> | null = null;

    const startPty = (): Promise<void> => {
      if (startedSessions.has(paneId)) return sessionReady ?? Promise.resolve();
      if (sessionReady) return sessionReady;

      startedSessions.add(paneId);
      setRunning(true);
      const entry = terminalCache.get(paneId);
      if (entry) entry.stopped = false;
      exitStateSetters.get(paneId)?.(false);

      sessionReady = terminalClient
        .create({
          sessionId: paneId,
          cwd: currentCwd,
          cols: terminal.cols,
          rows: terminal.rows,
          shellProfile: sessionInputRef.current.shellProfile,
          env: sessionInputRef.current.env ?? initialSettingsRef.current.globalEnv,
        })
        .then(() => {
          sessionReady = null;
        })
        .catch((error: unknown) => {
          startedSessions.delete(paneId);
          setRunning(false);
          sessionReady = null;
          if (entry) entry.stopped = true;
          exitStateSetters.get(paneId)?.(true);
          writeOutput(`\r\n\x1b[31mFailed to start terminal: ${String(error)}\x1b[0m\r\n`);
          throw error;
        });

      return sessionReady;
    };

    const writeToSession = (data: string): void => {
      if (!startedSessions.has(paneId)) void startPty();
      const ready = sessionReady;
      if (ready) {
        void ready.then(() => terminalClient.write(paneId, data)).catch(() => undefined);
        return;
      }
      void terminalClient.write(paneId, data);
    };

    inputControllerRef.current?.dispose();
    inputControllerRef.current = createTerminalInputController({
      terminal,
      shellProfile: sessionInputRef.current.shellProfile,
      readClipboard: readTerminalPastePayload,
      writeClipboardText: (text) => window.swath.clipboard.writeText(text),
      writeTerminalData: writeToSession,
      openSearch: () => setSearchOpen(true),
      platform: window.swath.platform,
      onPasteError: (error) => {
        console.error("Unable to read the clipboard", error);
        writeOutput("\r\n\x1b[31m[clipboard paste failed]\x1b[0m\r\n");
      },
    });

    const fitAndResize = (): void => {
      if (!termRef.current || !fitRef.current) return;
      const dimensions = fitDimensions(fitRef.current);
      if (!dimensions) return;

      if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
        terminal.resize(dimensions.cols, dimensions.rows);
      }
      if (startedSessions.has(paneId))
        terminalClient.resize({ sessionId: paneId, cols: terminal.cols, rows: terminal.rows });
    };

    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);

    requestAnimationFrame(() => {
      fitAndResize();
      if (cachedEntry) {
        // Restore a frame later: resizing reflows the buffer (moving baseY) and
        // xterm's own viewport refresh is itself deferred to the next frame.
        requestAnimationFrame(() => {
          if (termRef.current !== terminal) return;
          restoreTerminalScrollState(cachedEntry);
          updateScrollToBottomButton();
        });
        terminal.focus();
      } else if (startedSessions.has(paneId)) {
        void terminalClient.replay(paneId);
      } else {
        const prompt = `${currentCwd} % `;
        writeOutput(prompt);
        terminal.focus();
      }
    });

    const isDormantIgnoredInput = (data: string): boolean => data === "\x1b[3~";

    dormantInputRef.current = "";

    const disposable = cachedEntry
      ? null
      : terminal.onData((data) => {
          if (startedSessions.has(paneId)) {
            writeToSession(data);
            return;
          }

          if (!data || isDormantIgnoredInput(data)) return;

          if (data === "\r") {
            writeOutput("\r\x1b[K");
            const dormantInput = dormantInputRef.current + "\r";
            dormantInputRef.current = "";
            // Queue write behind PTY create — firing write immediately races spawn
            // on macOS and drops activation input ("terminal session not found").
            writeToSession(dormantInput);
          } else if (data === "\x7f") {
            if (dormantInputRef.current.length > 0) {
              dormantInputRef.current = dormantInputRef.current.slice(0, -1);
              writeOutput("\b \b");
            }
          } else {
            dormantInputRef.current += data;
            writeOutput(data);
          }
        });
    const removeDataListener = cachedEntry
      ? null
      : terminalClient.onData((sessionId, data) => {
          if (sessionId !== paneId) return;
          writeOutput(data);
        });
    const removeExitListener = cachedEntry
      ? null
      : terminalClient.onExit((sessionId) => {
          if (sessionId !== paneId) return;
          startedSessions.delete(sessionId);
          setRunning(false);
          exitStateSetters.get(paneId)?.(true);
          const entry = terminalCache.get(paneId);
          if (entry) entry.stopped = true;
          const message =
            "\r\n\x1b[2m[process exited — close, restart, or split a new terminal]\x1b[0m\r\n";
          writeOutput(message);
        });

    if (!cachedEntry) {
      terminalCache.set(paneId, {
        terminal,
        fit,
        image,
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
    const scrollDisposable = terminal.onScroll(updateScrollToBottomButton);
    updateScrollToBottomButton();
    const showScrollbar = (): void => {
      host.classList.add("is-scrolling");
      if (scrollbarHideTimerRef.current !== null)
        window.clearTimeout(scrollbarHideTimerRef.current);
      scrollbarHideTimerRef.current = window.setTimeout(() => {
        host.classList.remove("is-scrolling");
        scrollbarHideTimerRef.current = null;
      }, 800);
    };
    const onViewportScroll = (): void => {
      showScrollbar();
      updateScrollToBottomButton();
    };
    viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

    return () => {
      observer.disconnect();
      scrollDisposable.dispose();
      setShowScrollToBottom(false);
      viewport?.removeEventListener("scroll", onViewportScroll);
      if (scrollbarHideTimerRef.current !== null)
        window.clearTimeout(scrollbarHideTimerRef.current);
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
  }, [isActive, paneId, paneCwd, paneEnvKey, paneShellProfileKey, view.id, workspace.id]);

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;

    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.lineHeight = settings.lineHeight;
    terminal.options.cursorBlink = settings.cursorBlink;
    terminal.options.cursorStyle = settings.cursorStyle;
    requestAnimationFrame(() => {
      const dimensions = fitRef.current ? fitDimensions(fitRef.current) : null;
      if (!termRef.current || !dimensions) return;
      if (termRef.current.cols !== dimensions.cols || termRef.current.rows !== dimensions.rows) {
        termRef.current.resize(dimensions.cols, dimensions.rows);
      }
      if (startedSessions.has(paneId)) {
        terminalClient.resize({
          sessionId: paneId,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        });
      }
    });
  }, [
    paneId,
    settings.cursorBlink,
    settings.cursorStyle,
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
  ]);

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
    setRunning(true);
    termRef.current?.reset();
    const entry = terminalCache.get(paneId);
    if (entry) {
      entry.stopped = false;
      // The reset buffer invalidates any captured anchor; fall back to the bottom.
      entry.scrollState = undefined;
    }
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
      const cwd = window
        .prompt(
          "Initial CWD for next restart",
          paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path,
        )
        ?.trim();
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
      statusClass={exited ? "exited" : running ? "running" : "dormant"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) =>
        appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
      }
      onClose={close}
      onKeyDown={onKeyDown}
      onCopyCapture={(event: ClipboardEvent<HTMLDivElement>) =>
        inputControllerRef.current?.handleCopyEvent(event)
      }
      onPasteCapture={(event: ClipboardEvent<HTMLDivElement>) =>
        inputControllerRef.current?.handlePasteEvent(event)
      }
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
      <button
        type="button"
        className={`absolute bottom-3 left-1/2 z-10 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-[#30363d] bg-[#161b22]/95 text-[#8b949e] shadow-[0_4px_14px_rgba(0,0,0,0.4)] backdrop-blur-sm transition-[opacity,transform,background-color,border-color,color] duration-200 ease-out hover:border-[#484f58] hover:bg-[#21262d] hover:text-[#f0f6fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f81f7] ${showScrollToBottom && isActive ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`}
        aria-label="Scroll to bottom"
        aria-hidden={!showScrollToBottom || !isActive}
        tabIndex={showScrollToBottom && isActive ? 0 : -1}
        title="Scroll to bottom"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          // Must go through xterm: writing viewport.scrollTop directly round-trips
          // through a lossy pixel→row conversion that can leave the pane one row
          // short of the bottom, permanently latching it out of follow mode.
          termRef.current?.scrollToBottom();
          termRef.current?.focus();
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
          <path
            d="M3.5 6 8 10.5 12.5 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {searchOpen ? (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={onSearch}
          onPrevious={() => searchRef.current?.findPrevious(searchQuery)}
          onNext={() => searchRef.current?.findNext(searchQuery)}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {contextMenu ? (
        <TerminalContextMenu x={contextMenu.x} y={contextMenu.y} onAction={runContextAction} />
      ) : null}
    </PaneFrame>
  );
}
