/** xterm.js scrollback lines per terminal pane (default xterm is 1000). */
export const TERMINAL_SCROLLBACK_LINES = 5000;

/** Max PTY output retained in the main process for pane/view replay (bytes). */
export const TERMINAL_REPLAY_MAX_BYTES = 2 * 1024 * 1024;

/** Default maxBuffer for git subprocess stdout/stderr (bytes). */
export const GIT_RUN_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
