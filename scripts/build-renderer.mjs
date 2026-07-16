import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const cacheDirectory = join(root, "node_modules", ".cache", "swath");
const cachePath = join(cacheDirectory, "renderer-input.sha256");
const distIndexPath = join(root, "dist", "index.html");
const inputPaths = [
  "index.html",
  "package.json",
  "package-lock.json",
  "postcss.config.js",
  "tailwind.config.js",
  "tsconfig.json",
  "vite.config.ts",
  "public",
  "src",
];

/** Adds a file or directory tree to the renderer input hash in stable path order. */
async function hashPath(hash, path) {
  const absolutePath = join(root, path);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);

  if (entries === null) {
    hash.update(path);
    hash.update(await readFile(absolutePath));
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await hashPath(hash, join(path, entry.name));
  }
}

/** Computes a digest of every input that can affect the production renderer bundle. */
async function rendererInputDigest() {
  const hash = createHash("sha256");
  for (const path of inputPaths) {
    await hashPath(hash, path);
  }
  return hash.digest("hex");
}

const digest = await rendererInputDigest();
const cachedDigest = await readFile(cachePath, "utf8").catch(() => "");

if (cachedDigest.trim() === digest && existsSync(distIndexPath)) {
  console.log("Renderer inputs unchanged; reusing dist/.");
  process.exit(0);
}

const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await mkdir(cacheDirectory, { recursive: true });
await writeFile(cachePath, `${digest}\n`);
console.log(`Cached renderer inputs from ${relative(process.cwd(), root) || "."}.`);
