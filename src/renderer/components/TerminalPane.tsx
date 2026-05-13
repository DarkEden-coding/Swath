import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { AppSettings, ShellProfile, TerminalTab, Workspace } from "../../main/sharedTypes";
import { findPane } from "../utils/layout";
import { useAppStore } from "../state/appStore";
import { IconClose, IconColumns, IconRows } from "./icons";

interface TerminalPaneProps {
  workspace: Workspace;
  tab: TerminalTab;
  paneId: string;
  settings: AppSettings;
}

const startedSessions = new Set<string>();

function shellFor(settings: AppSettings): ShellProfile | null {
  return settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ?? settings.shellProfiles[0] ?? null;
}

function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return Object.fromEntries(env.map((item) => [item.name, item.value]));
  return env as Record<string, string>;
}

export function TerminalPane({ workspace, tab, paneId, settings }: TerminalPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const bannerSentRef = useRef(false);
  const [exited, setExited] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const activePaneId = useAppStore((state) => state.activePaneId);
  const splitPane = useAppStore((state) => state.splitPane);
  const closePane = useAppStore((state) => state.closePane);
  const renamePane = useAppStore((state) => state.renamePane);
  const setPaneInitialCwd = useAppStore((state) => state.setPaneInitialCwd);
  const setActivePane = useAppStore((state) => state.setActivePane);
  const isActive = activePaneId === paneId || tab.activePaneId === paneId;

  const initialSettingsRef = useRef(settings);
  const initialShellProfileRef = useRef<ShellProfile | null>(shellFor(settings));

  const paneMeta = findPane(tab.layout, paneId);
  const headerLine = paneMeta?.title ?? paneMeta?.metadata?.title ?? paneMeta?.promptLabel ?? `${workspace.name}`;

  useEffect(() => {
    bannerSentRef.current = false;
  }, [paneId, tab.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: initialSettingsRef.current.cursorBlink,
      cursorStyle: initialSettingsRef.current.cursorStyle,
      fontFamily: initialSettingsRef.current.fontFamily,
      fontSize: initialSettingsRef.current.fontSize,
      lineHeight: initialSettingsRef.current.lineHeight,
      scrollback: 10000,
      theme: {
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
        brightWhite: "#f0f6fc"
      }
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(host);

    termRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    const currentCwd = paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path;

    const startPty = (): void => {
      if (startedSessions.has(paneId) || !termRef.current) return;
      startedSessions.add(paneId);
      setExited(false);
      window.tpm.pty.create({
        sessionId: paneId,
        cwd: currentCwd,
        cols: termRef.current.cols,
        rows: termRef.current.rows,
        shellProfile: paneMeta?.shellProfile ?? paneMeta?.metadata?.shellProfile ?? initialShellProfileRef.current,
        env: paneMeta?.env ?? normalizeEnv(paneMeta?.metadata?.env) ?? initialSettingsRef.current.globalEnv
      });
    };

    const fitAndResize = (): void => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      if (startedSessions.has(paneId)) window.tpm.pty.resize({ sessionId: paneId, cols: terminal.cols, rows: terminal.rows });
    };

    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);

    requestAnimationFrame(() => {
      fit.fit();
      if (startedSessions.has(paneId)) {
        void window.tpm.terminalSession?.replay(paneId);
      } else {
        // Show current working directory as a placeholder
        const prompt = `${currentCwd} % `;
        terminal.write(prompt);
      }
      terminal.focus();
    });

    const disposable = terminal.onKey(({ key, domEvent }) => {
      if (startedSessions.has(paneId)) {
        window.tpm.pty.write(paneId, key);
        return;
      }

      // Check for backspace (8) or delete (46)
      if (domEvent.keyCode === 8 || domEvent.keyCode === 46) {
        return;
      }

      // Check for other "dead" keys that shouldn't trigger PTY start (e.g. Meta, Ctrl, Alt, Shift alone)
      if ([16, 17, 18, 91, 93].includes(domEvent.keyCode)) {
        return;
      }

      // Clear the placeholder prompt before starting the real PTY
      terminal.write("\r\x1b[K");
      startPty();
      window.tpm.pty.write(paneId, key);
    });
    const removeDataListener = window.tpm.pty.onData((sessionId, data) => {
      if (sessionId !== paneId) return;
      terminal.write(data);
    });
    const removeExitListener = window.tpm.pty.onExit((sessionId) => {
      if (sessionId !== paneId) return;
      startedSessions.delete(sessionId);
      setExited(true);
      const message = "\r\n\x1b[2m[process exited — close, restart, or split a new terminal]\x1b[0m\r\n";
      terminal.write(message);
    });

    return () => {
      observer.disconnect();
      disposable.dispose();
      removeDataListener();
      removeExitListener();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [paneId, tab.id, workspace.path]);

  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;

    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.lineHeight = settings.lineHeight;
    terminal.options.cursorBlink = settings.cursorBlink;
    terminal.options.cursorStyle = settings.cursorStyle;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (termRef.current && startedSessions.has(paneId)) {
        window.tpm.pty.resize({ sessionId: paneId, cols: termRef.current.cols, rows: termRef.current.rows });
      }
    });
  }, [paneId, settings.cursorBlink, settings.cursorStyle, settings.fontFamily, settings.fontSize, settings.lineHeight]);

  useEffect(() => {
    if (!isActive) return;
    termRef.current?.focus();
  }, [isActive]);

  const copy = async (): Promise<void> => {
    const selection = termRef.current?.getSelection();
    if (selection) await navigator.clipboard.writeText(selection);
  };

  const paste = async (): Promise<void> => {
    const text = await navigator.clipboard.readText();
    if (text) termRef.current?.paste(text);
  };

  const restart = (): void => {
    startedSessions.add(paneId);
    termRef.current?.reset();
    setExited(false);
    void window.tpm.terminalSession?.restart(paneId);
  };

  const close = (): void => {
    if (startedSessions.has(paneId) && !window.confirm("Close this running terminal?")) return;
    window.tpm.pty.kill(paneId);
    startedSessions.delete(paneId);
    closePane(workspace.id, tab.id, paneId);
  };

  const runContextAction = (action: string): void => {
    setContextMenu(null);
    if (action === "copy") void copy();
    if (action === "paste") void paste();
    if (action === "selectAll") termRef.current?.selectAll();
    if (action === "clear") termRef.current?.clear();
    if (action === "find") setSearchOpen(true);
    if (action === "restart") restart();
    if (action === "rename") {
      const title = window.prompt("Pane title", headerLine)?.trim();
      if (title) renamePane(workspace.id, tab.id, paneId, title);
    }
    if (action === "cwd") {
      const cwd = window.prompt("Initial CWD for next restart", paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path)?.trim();
      if (cwd) setPaneInitialCwd(workspace.id, tab.id, paneId, cwd);
    }
    if (action === "splitRight") splitPane(workspace.id, tab.id, paneId, "vertical");
    if (action === "splitDown") splitPane(workspace.id, tab.id, paneId, "horizontal");
    if (action === "close") close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setSearchOpen(true);
    }
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
    if (!contextMenu) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const onClick = (): void => {
      setContextMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onClick);
    };
  }, [contextMenu]);

  return (
    <div
      className={`terminal-pane ${isActive ? "active" : ""}`}
      onMouseDown={() => setActivePane(workspace.id, tab.id, paneId)}
      onKeyDown={onKeyDown}
      onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="pane-toolbar">
        <div className="pane-title">
          <span className={`status-dot ${exited ? "exited" : startedSessions.has(paneId) ? "running" : "dormant"}`} />
          <span className="pane-prompt mono">{headerLine}</span>
        </div>
        <div className="pane-actions">
          <button type="button" className="pane-icon-btn" title="Split right" onClick={() => splitPane(workspace.id, tab.id, paneId, "vertical")}>
            <IconColumns width={15} height={15} />
          </button>
          <button type="button" className="pane-icon-btn" title="Split down" onClick={() => splitPane(workspace.id, tab.id, paneId, "horizontal")}>
            <IconRows width={15} height={15} />
          </button>
          <button type="button" className="pane-icon-btn" title="Close pane" onClick={close}>
            <IconClose width={15} height={15} />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="terminal-host" onPaste={(_: ClipboardEvent<HTMLDivElement>) => undefined} />
      {searchOpen ? (
        <div className="terminal-search">
          <input autoFocus value={searchQuery} placeholder="Find" onChange={(event) => onSearch(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") searchRef.current?.findNext(searchQuery);
            if (event.key === "Escape") setSearchOpen(false);
          }} />
          <button type="button" onClick={() => searchRef.current?.findPrevious(searchQuery)}>↑</button>
          <button type="button" onClick={() => searchRef.current?.findNext(searchQuery)}>↓</button>
          <button type="button" onClick={() => setSearchOpen(false)}>×</button>
        </div>
      ) : null}
      {contextMenu ? (
        <div className="terminal-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {[
            ["copy", "Copy"], ["paste", "Paste"], ["selectAll", "Select All"], ["clear", "Clear"], ["find", "Find"],
            ["restart", "Restart"], ["rename", "Rename Pane"], ["cwd", "Set Initial CWD"], ["splitRight", "Split Right"],
            ["splitDown", "Split Down"], ["close", "Close Pane"]
          ].map(([id, label]) => <button key={id} type="button" onClick={() => runContextAction(id)}>{label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
