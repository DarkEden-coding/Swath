/** xterm.js scrollback lines per terminal pane (default xterm is 1000). */
export const TERMINAL_SCROLLBACK_LINES = 5000;

/** Max PTY output retained while a pane is attached to the UI (bytes). */
export const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024;

/** Max PTY output retained while detached (inactive split / hidden pane) (bytes). */
export const TERMINAL_REPLAY_DETACHED_MAX_BYTES = 256 * 1024;

/** Default maxBuffer for git subprocess stdout/stderr (bytes). */
export const GIT_RUN_MAX_BUFFER_BYTES = 1024 * 1024;

/** Max size of one image attached to a question (must match Rust ASK_IMAGE_MAX_BYTES). */
export const ASK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Max images attached to a question set (must match Rust ASK_IMAGE_MAX_COUNT). */
export const ASK_IMAGE_MAX_COUNT = 32;

/**
 * FIFO storage limit for @xterm/addon-image (MiB).
 * Kept conservative relative to per-pane replay retention.
 */
export const IMAGE_ADDON_STORAGE_LIMIT_MB = 16;

/** Max size of a single IIP or SIXEL sequence for ImageAddon (bytes). */
export const IMAGE_ADDON_SEQUENCE_SIZE_LIMIT = 2 * 1024 * 1024;
