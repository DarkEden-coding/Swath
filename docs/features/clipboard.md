# Clipboard ownership and device switching

## Ownership rules

The clipboard belongs to the viewing device. The PTY belongs to its session's device. These are not interchangeable.

- Native menu paste reads the viewing device's clipboard. Embedded remote views receive that payload, not a request to read the remote server's clipboard.
- `src/renderer/app/clipboardPaste.ts` routes native and embedded paste to the focused DOM editor. Custom consumers register on their actual editor elements. There is no window-wide broadcast to every active-looking pane. If DOM focus is lost entirely, the command may restore only the explicitly identified, visible active terminal, never a hidden pane or a field behind a modal.
- Ordinary fields use native value setters and input events. Terminal input goes through xterm's `paste`, preserving its newline and bracketed-paste handling. Pi composers retain image attachments and large-text placeholders.
- A pending clipboard read is discarded if focus, field contents, selection, or editor attachment changes. Terminal context-menu reads are also invalidated on blur or controller disposal.
- DOM paste uses the event's text directly. Empty events no longer imply an image or inject an unexplained Ctrl+V into a shell.
- DOM copy writes the event's clipboard data synchronously. Keyboard/context-menu copy uses the viewer's clipboard API and reports failures.

## Device lifecycle

`DeviceSwitcher.tsx` and `deviceLifecycle.ts` serialize native menu routing, visibility and focus changes, including cleanup across remounts. Paste is blocked during a transition and after native visibility/focus failures until a successful retry. Switching back restores the last local editor. Late creation/error callbacks must not replace or close a newer view. Unmount clears remote menu ownership.

`src-tauri/src/menu.rs` keeps the selected remote label. An unavailable selected remote must consume paste rather than leak it into a local terminal. Clipboard delivery rechecks selection after the native read.

`remoteAdapter.ts` pins remote terminal ownership before asynchronous attachment. Missing connections, failed attachment and forgotten devices never turn a remote terminal write into a local write. Closed clients cannot reopen after being forgotten.

## Supported content and limits

| Destination     | Text                             | Images and files                                                                   |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Local terminal  | xterm paste                      | Local image shortcut/path handling; shell-quoted file paths                        |
| Remote terminal | xterm paste to pinned remote PTY | Explicit error for host images/local file paths; upload on the remote device first |
| Pi composer     | Text or large-paste attachment   | Host payloads and DOM image files become attachments                               |
| Ordinary editor | Text at captured selection       | No automatic file upload                                                           |

Browser clipboard reads use `navigator.clipboard.read` for text and images, with `readText` for browsers lacking the richer API. Image reads share the native RGBA payload format and reject images above 16 megapixels. HTTPS and browser clipboard permission are required. Permission errors are not treated as empty clipboard contents.

Remote terminal image upload is intentionally not simulated with Ctrl+V: that would read an unrelated clipboard on the server. Native local image shortcuts still rely on the terminal application supporting clipboard images.

## Regression checks

Run the focused tests with:

```sh
./node_modules/.bin/vitest run \
  src/renderer/app/clipboardPaste.test.ts \
  src/renderer/features/terminal/input/terminalInputController.test.ts \
  src/renderer/features/remote/deviceLifecycle.test.ts \
  src/renderer/platform/remoteAdapter.test.ts \
  src/renderer/platform/browserClipboard.test.ts \
  src/renderer/platform/tauriAdapter.test.ts
npm test
cargo test --manifest-path src-tauri/Cargo.toml menu::tests
```

For native smoke testing, switch local → remote A → remote B → local rapidly, then paste into the terminal, a Pi composer and a regular text field. Repeat while connecting, after removing a device, and with a clipboard permission prompt open. No hidden editor should receive text. Browser tests alone cannot verify OS-level WebView focus behavior.
