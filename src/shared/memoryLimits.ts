/** xterm.js scrollback lines per terminal pane (default xterm is 1000). */
export const TERMINAL_SCROLLBACK_LINES = 5000;

/** Max PTY output retained while a pane is attached to the UI (bytes). */
export const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024;

/** Max PTY output retained while detached (inactive split / hidden pane) (bytes). */
export const TERMINAL_REPLAY_DETACHED_MAX_BYTES = 256 * 1024;

/** Default maxBuffer for git subprocess stdout/stderr (bytes). */
export const GIT_RUN_MAX_BUFFER_BYTES = 1024 * 1024;
