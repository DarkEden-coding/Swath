import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "swath-renderer-build-"));
try {
  for (const directory of ["scripts", "src", "public", "node_modules/vite/bin"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  copyFileSync(
    new URL("build-renderer.mjs", import.meta.url),
    join(root, "scripts/build-renderer.mjs"),
  );
  for (const file of [
    "index.html",
    "package.json",
    "pnpm-lock.yaml",
    "postcss.config.js",
    "tailwind.config.js",
    "tsconfig.json",
    "vite.config.ts",
  ]) {
    writeFileSync(join(root, file), file === "package.json" ? '{"type":"module"}' : "fixture");
  }
  writeFileSync(
    join(root, "node_modules/vite/bin/vite.js"),
    `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`,
  );
  const run = () =>
    execFileSync(process.execPath, [join(root, "scripts/build-renderer.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  assert.match(run(), /Cached renderer inputs/);
  assert.match(run(), /Renderer inputs unchanged/);
  writeFileSync(join(root, "pnpm-lock.yaml"), "changed tracked lockfile");
  assert.match(run(), /Cached renderer inputs/);
  writeFileSync(join(root, "package-lock.json"), "optional npm lockfile");
  assert.match(run(), /Cached renderer inputs/);
  assert.match(run(), /Renderer inputs unchanged/);
  console.log(
    "Renderer build works without an npm lockfile and invalidates on either lockfile change.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
