import assert from "node:assert/strict";
import { formatPathPaste, shellQuotePath } from "../src/renderer/utils/terminalPaste.ts";

assert.equal(shellQuotePath("/tmp/plain.png"), "'/tmp/plain.png'");
assert.equal(shellQuotePath("/tmp/has space.png"), "'/tmp/has space.png'");
assert.equal(shellQuotePath("/tmp/it's.png"), "'/tmp/it'\\''s.png'");
assert.equal(formatPathPaste(["/tmp/a.png", "/tmp/b c.png"]), "'/tmp/a.png' '/tmp/b c.png'");

console.log("terminal paste tests passed");
