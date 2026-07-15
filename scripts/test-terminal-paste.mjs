import assert from "node:assert/strict";
import { formatPathPaste, shellQuotePath } from "../src/renderer/utils/terminalPaste.ts";

assert.equal(shellQuotePath("/tmp/plain.png"), "'/tmp/plain.png'");
assert.equal(shellQuotePath("/tmp/has space.png"), "'/tmp/has space.png'");
assert.equal(shellQuotePath("/tmp/it's.png"), "'/tmp/it'\\''s.png'");
assert.equal(formatPathPaste(["/tmp/a.png", "/tmp/b c.png"]), "'/tmp/a.png' '/tmp/b c.png'");
assert.equal(
  shellQuotePath("C:\\Temp\\has space.png", "powershell.exe"),
  "'C:\\Temp\\has space.png'",
);
assert.equal(shellQuotePath("C:\\Temp\\it's.png", "pwsh.exe"), "'C:\\Temp\\it''s.png'");
assert.equal(shellQuotePath("C:\\Temp\\has space.png", "cmd.exe"), '"C:\\Temp\\has space.png"');

console.log("terminal paste tests passed");
