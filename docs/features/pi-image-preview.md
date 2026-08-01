# Pi coding-agent: Swath image preview

Extension for [pi](https://github.com/badlogic/pi-mono) **0.82.1** that opens local images in Swath’s `imagePreview` pane via OSC 777.

Source: [`integrations/pi/show-image.ts`](../../integrations/pi/show-image.ts)

## Install

Copy or symlink the extension into an auto-discovered pi extensions directory:

```bash
# Global (all projects)
mkdir -p ~/.pi/agent/extensions
ln -sf /absolute/path/to/terminal-project-manager/integrations/pi/show-image.ts \
  ~/.pi/agent/extensions/show-image.ts

# Or project-local (loads after the project is trusted)
mkdir -p .pi/extensions
ln -sf ../../integrations/pi/show-image.ts .pi/extensions/show-image.ts
```

You can also copy the file instead of symlinking. Quick one-off test without install:

```bash
pi -e ./integrations/pi/show-image.ts
```

### Reload

After installing or editing the file in an auto-discovered location, run `/reload` inside pi so the extension is picked up. Tools registered at load time appear after reload; the `/preview` command likewise requires a successful reload.

## Usage

### Tool: `show_image`

The LLM can call `show_image` with a filesystem path:

- Relative paths resolve against the session `ctx.cwd`.
- A single leading `@` is stripped (some models prepend it).
- On success, Swath receives OSC 777 and opens/updates an `imagePreview` pane.

### Command: `/preview`

```text
/preview path/to/image.png
/preview @screenshots/demo.webp
```

## Protocol

Emits exactly (no inline pixel graphics):

```text
ESC ] 777 ; swath-image= <base64 UTF-8 absolute path> BEL
```

Equivalent Node write:

```js
process.stdout.write(`\x1b]777;swath-image=${encoded}\x07`);
```

Swath’s terminal OSC handler decodes the path and upserts an `imagePreview` pane. Image bytes are loaded later via host RPC, not through the OSC payload.

## Formats and security

| Rule      | Detail                                                 |
| --------- | ------------------------------------------------------ |
| Formats   | PNG, JPEG, GIF, WebP (magic bytes only)                |
| Rejected  | SVG and any non-matching header                        |
| Size      | Max **10 MiB**                                         |
| File type | Regular files only; directories and symlinks rejected  |
| Payload   | Absolute path only (base64); no image data on the wire |

Validation happens in the extension before emitting OSC. Swath’s backend applies related checks again when loading bytes for the preview pane.

## Inline ImageAddon vs preview pane

| Path                              | Mechanism                                              | Best for                                                            |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| **Inline ImageAddon**             | xterm `@xterm/addon-image` (OSC 1337 IIP, SIXEL, etc.) | Graphics protocols that paint inside the terminal cell grid         |
| **Preview pane** (this extension) | OSC 777 `swath-image=` → `imagePreview` pane           | Inspecting local files with zoom/fit UI without bloating scrollback |

Use `show_image` / `/preview` when you want Swath’s dedicated preview pane. Do **not** use this extension to dump IIP/SIXEL sequences; it intentionally emits only the path-based OSC so replay sanitizers can strip it and panes stay lightweight.

## Requirements

- pi coding-agent **0.82.1** (or compatible) with extension support
- Running inside a Swath terminal pane that registers the OSC 777 `swath-image` handler
- No extra npm dependencies for the extension (uses Node builtins + pi-provided `typebox` / `@earendil-works/pi-coding-agent`)
