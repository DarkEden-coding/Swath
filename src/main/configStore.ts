import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { app } from "electron";
import { createDefaultConfig } from "./defaults";
import type { AppConfig, Workspace } from "./sharedTypes";

const DB_FILE = "swath.sqlite3";

let db: Database.Database | null = null;

function databasePath(): string {
  return path.join(app.getPath("userData"), DB_FILE);
}

function getDb(): Database.Database {
  if (db) return db;

  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function workspaceExists(workspace: Workspace): boolean {
  try {
    return fs.existsSync(workspace.path) && fs.statSync(workspace.path).isDirectory();
  } catch {
    return false;
  }
}

function pruneMissingWorkspaces(config: AppConfig): AppConfig {
  const workspaces = config.workspaces.filter(workspaceExists);
  return {
    ...config,
    workspaces,
    activeWorkspaceId: config.activeWorkspaceId && workspaces.some((item) => item.id === config.activeWorkspaceId)
      ? config.activeWorkspaceId
      : workspaces[0]?.id ?? null,
  };
}

function isAppConfig(value: unknown): value is AppConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { workspaces?: unknown }).workspaces)
  );
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const row = getDb()
      .prepare("SELECT json FROM app_config WHERE id = 1")
      .get() as { json: string } | undefined;
    if (!row) return createDefaultConfig();

    const parsed: unknown = JSON.parse(row.json);
    if (!isAppConfig(parsed)) return createDefaultConfig();

    const defaults = createDefaultConfig();
    const merged = {
      ...defaults,
      ...parsed,
      settings: {
        ...defaults.settings,
        ...parsed.settings,
        shellProfiles: Array.isArray(parsed.settings?.shellProfiles)
          ? parsed.settings.shellProfiles
          : defaults.settings.shellProfiles,
        globalEnv: parsed.settings?.globalEnv && typeof parsed.settings.globalEnv === "object"
          ? parsed.settings.globalEnv
          : defaults.settings.globalEnv,
      },
    };
    const pruned = pruneMissingWorkspaces(merged);
    if (pruned.workspaces.length !== merged.workspaces.length || pruned.activeWorkspaceId !== merged.activeWorkspaceId) {
      await saveConfig(pruned);
    }
    return pruned;
  } catch (error) {
    console.warn("Could not read SQLite config; using defaults", error);
    return createDefaultConfig();
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  getDb()
    .prepare(
      `INSERT INTO app_config (id, json, updated_at)
       VALUES (1, @json, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
    .run({ json: JSON.stringify(config), updatedAt: Date.now() });
}
