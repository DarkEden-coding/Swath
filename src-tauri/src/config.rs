use crate::types::*;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "swath.sqlite3";

/// Resolves and creates the application data directory for the config database.
#[cfg(feature = "desktop")]
fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?;
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    Ok(dir.join(DB_FILE))
}

/// Opens the config database and ensures its schema is ready.
#[cfg(feature = "desktop")]
fn connection(app: &AppHandle) -> Result<Connection> {
    let file = db_path(app)?;
    migrate_legacy_sqlite_db(app, &file).ok();
    connection_at(&file)
}

fn connection_at(file: &Path) -> Result<Connection> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn =
        Connection::open(file).with_context(|| format!("failed to open {}", file.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )",
        [],
    )?;
    let has_revision = conn
        .prepare("PRAGMA table_info(app_config)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|column| column == "revision");
    if !has_revision {
        conn.execute(
            "ALTER TABLE app_config ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(conn)
}

/// Copies a legacy database into the current app data directory when needed.
#[cfg(feature = "desktop")]
fn migrate_legacy_sqlite_db(_app: &AppHandle, new_path: &PathBuf) -> Result<()> {
    if new_path.exists() {
        return Ok(());
    }
    let Some(old_path) = legacy_user_data_path() else {
        return Ok(());
    };
    let old_db = old_path.join(DB_FILE);
    if old_db.exists() {
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(old_db, new_path)?;
    }
    Ok(())
}

#[cfg(feature = "desktop")]
fn legacy_user_data_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support/Swath"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("Swath"))
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            Some(PathBuf::from(xdg).join("Swath"))
        } else {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/Swath"))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

/// Loads and normalizes the persisted application configuration.
#[cfg(feature = "desktop")]
pub fn load(app: &AppHandle) -> Result<AppConfig> {
    load_connection(connection(app)?)
}

pub fn load_in(data_dir: &Path) -> Result<AppConfig> {
    load_connection(connection_at(&data_dir.join(DB_FILE))?)
}

fn load_connection(conn: Connection) -> Result<AppConfig> {
    let json: Option<String> = conn
        .query_row("SELECT json FROM app_config WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()?;

    let mut config = if let Some(json) = json {
        serde_json::from_str::<AppConfig>(&json).unwrap_or_else(|_| default_config())
    } else {
        default_config()
    };

    normalize_config(&mut config);
    Ok(config)
}

/// Normalizes and persists the application configuration.
#[cfg(feature = "desktop")]
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<()> {
    save_connection(connection(app)?, config)
}

pub fn save_in(data_dir: &Path, config: &AppConfig) -> Result<()> {
    save_connection(connection_at(&data_dir.join(DB_FILE))?, config)
}

fn save_connection(conn: Connection, config: &AppConfig) -> Result<()> {
    let mut normalized = config.clone();
    normalize_config(&mut normalized);
    if normalized.version != 2 {
        return Err(anyhow!("unsupported config version {}", normalized.version));
    }
    let json = serde_json::to_string_pretty(&normalized)?;
    conn.execute(
        "INSERT INTO app_config (id, json, updated_at) VALUES (1, ?1, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, revision = app_config.revision + 1",
        params![json],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct ConfigSnapshot {
    pub config: AppConfig,
    pub revision: u64,
}

#[cfg(feature = "desktop")]
pub fn snapshot(app: &AppHandle) -> Result<ConfigSnapshot> {
    snapshot_connection(connection(app)?)
}

pub fn snapshot_in(data_dir: &Path) -> Result<ConfigSnapshot> {
    snapshot_connection(connection_at(&data_dir.join(DB_FILE))?)
}

fn snapshot_connection(conn: Connection) -> Result<ConfigSnapshot> {
    let row: Option<(String, u64)> = conn
        .query_row(
            "SELECT json, revision FROM app_config WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (mut config, revision) = match row {
        Some((json, revision)) => (serde_json::from_str(&json)?, revision),
        None => (default_config(), 0),
    };
    normalize_config(&mut config);
    Ok(ConfigSnapshot { config, revision })
}

#[cfg(feature = "desktop")]
pub fn commit(app: &AppHandle, config: &AppConfig, revision: u64) -> Result<ConfigSnapshot> {
    commit_connection(connection(app)?, config, revision)
}

pub fn commit_in(data_dir: &Path, config: &AppConfig, revision: u64) -> Result<ConfigSnapshot> {
    commit_connection(connection_at(&data_dir.join(DB_FILE))?, config, revision)
}

fn commit_connection(
    mut conn: Connection,
    config: &AppConfig,
    revision: u64,
) -> Result<ConfigSnapshot> {
    let mut normalized = config.clone();
    normalize_config(&mut normalized);
    let tx = conn.transaction()?;
    if normalized.remote_connections.is_none() {
        let existing: Option<String> = tx
            .query_row("SELECT json FROM app_config WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if let Some(existing) =
            existing.and_then(|json| serde_json::from_str::<AppConfig>(&json).ok())
        {
            normalized.remote_connections = existing.remote_connections;
        }
    }
    let json = serde_json::to_string_pretty(&normalized)?;
    let changed = if revision == 0 {
        tx.execute(
            "INSERT INTO app_config (id, json, revision, updated_at) VALUES (1, ?1, 1, strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET json = excluded.json, revision = 1, updated_at = strftime('%s','now') WHERE app_config.revision = 0",
            params![json],
        )?
    } else {
        tx.execute(
            "UPDATE app_config SET json = ?1, revision = revision + 1, updated_at = strftime('%s','now') WHERE id = 1 AND revision = ?2",
            params![json, revision],
        )?
    };
    if changed == 0 {
        return Err(anyhow!(
            "config conflict: configuration changed; reload and retry"
        ));
    }
    tx.commit()?;
    Ok(ConfigSnapshot {
        config: normalized,
        revision: revision + 1,
    })
}

/// Repairs defaults and marks workspaces whose paths are temporarily unavailable.
fn normalize_config(config: &mut AppConfig) {
    config.version = 2;
    for workspace in &mut config.workspaces {
        // A remote path belongs to another filesystem; connector health, not local fs metadata,
        // determines whether it is usable.
        workspace.is_missing = workspace.remote_connection_id.is_none()
            && !std::path::Path::new(&workspace.path).exists();
    }
    // A group root has no folder of its own: it is unavailable only once every member is.
    let live_groups: std::collections::HashSet<String> = config
        .workspaces
        .iter()
        .filter(|workspace| !workspace.is_missing && !workspace.is_group_root)
        .filter_map(|workspace| workspace.group_id.clone())
        .collect();
    for workspace in &mut config.workspaces {
        if workspace.is_group_root {
            workspace.is_missing = !live_groups.contains(&workspace.id);
        }
    }
    if config.active_workspace_id.as_ref().is_none_or(|id| {
        !config
            .workspaces
            .iter()
            .any(|workspace| &workspace.id == id && !workspace.is_missing)
    }) {
        config.active_workspace_id = config
            .workspaces
            .iter()
            .find(|workspace| !workspace.is_missing)
            .map(|workspace| workspace.id.clone());
    }
    let defaults = default_settings();
    if config.settings.shell_profiles.is_empty() {
        config.settings.shell_profiles = defaults.shell_profiles;
    }
    if config.settings.default_shell_profile_id.is_empty() {
        config.settings.default_shell_profile_id = config
            .settings
            .shell_profiles
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| "default".into());
    }
}

/// Builds the default application configuration.
pub fn default_config() -> AppConfig {
    AppConfig {
        version: 2,
        workspaces: Vec::new(),
        active_workspace_id: None,
        settings: default_settings(),
        remote_connections: None,
    }
}

/// Builds platform-appropriate default application settings.
pub fn default_settings() -> AppSettings {
    let shell_profiles = default_shell_profiles();
    AppSettings {
        font_family: if cfg!(target_os = "windows") {
            "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace".into()
        } else {
            "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, monospace".into()
        },
        font_size: 13.0,
        line_height: 1.15,
        cursor_blink: true,
        cursor_style: "block".into(),
        default_shell_profile_id: shell_profiles
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| "default".into()),
        shell_profiles,
        global_env: HashMap::new(),
        confirm_before_closing_pane: false,
    }
}

/// Returns the built-in shell profiles for the current platform.
pub fn default_shell_profiles() -> Vec<ShellProfile> {
    if cfg!(target_os = "windows") {
        return vec![
            ShellProfile {
                id: "powershell".into(),
                name: "PowerShell".into(),
                command: "powershell.exe".into(),
                args: vec!["-NoLogo".into()],
                env: None,
            },
            ShellProfile {
                id: "cmd".into(),
                name: "Command Prompt".into(),
                command: "cmd.exe".into(),
                args: vec![],
                env: None,
            },
            ShellProfile {
                id: "pwsh".into(),
                name: "PowerShell 7".into(),
                command: "pwsh.exe".into(),
                args: vec!["-NoLogo".into()],
                env: None,
            },
        ];
    }
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    vec![
        ShellProfile {
            id: "default".into(),
            name: "Default shell".into(),
            command: default_shell,
            args: vec!["-l".into()],
            env: None,
        },
        ShellProfile {
            id: "zsh".into(),
            name: "zsh".into(),
            command: "/bin/zsh".into(),
            args: vec!["-l".into()],
            env: None,
        },
        ShellProfile {
            id: "bash".into(),
            name: "bash".into(),
            command: "/bin/bash".into(),
            args: vec!["-l".into()],
            env: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_conflicts_and_migrates_legacy_rows() {
        // A file-backed database exercises the same schema migration as production.
        let path =
            std::env::temp_dir().join(format!("swath-config-cas-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let old = Connection::open(&path).unwrap();
        old.execute_batch("CREATE TABLE app_config (id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        drop(old);
        let config = default_config();
        assert_eq!(
            snapshot_connection(connection_at(&path).unwrap())
                .unwrap()
                .revision,
            0
        );
        assert_eq!(
            commit_connection(connection_at(&path).unwrap(), &config, 0)
                .unwrap()
                .revision,
            1
        );
        assert!(commit_connection(connection_at(&path).unwrap(), &config, 0)
            .err()
            .unwrap()
            .to_string()
            .contains("conflict"));
        assert_eq!(
            commit_connection(connection_at(&path).unwrap(), &config, 1)
                .unwrap()
                .revision,
            2
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn retains_missing_workspaces_without_persisting_the_missing_flag() {
        let mut config = default_config();
        config.workspaces.push(
            serde_json::from_value(serde_json::json!({
                "id": "missing",
                "name": "Missing",
                "path": std::env::temp_dir().join("swath-config-test-missing").to_string_lossy(),
                "views": [],
                "activeViewId": "",
                "createdAt": 0,
                "updatedAt": 0,
            }))
            .unwrap(),
        );
        config.active_workspace_id = Some("missing".into());

        normalize_config(&mut config);

        assert!(config.workspaces[0].is_missing);
        assert_eq!(config.active_workspace_id, None);
        assert!(serde_json::to_value(config).unwrap()["workspaces"][0]
            .get("isMissing")
            .is_none());
    }

    #[test]
    fn remote_workspaces_are_not_checked_against_the_local_filesystem() {
        let mut config = default_config();
        config.workspaces.push(
            serde_json::from_value(serde_json::json!({
                "id": "remote:project",
                "name": "Remote project",
                "path": "swath-remote://device/%2Frepo",
                "remoteConnectionId": "device",
                "views": [],
                "activeViewId": "",
                "createdAt": 0,
                "updatedAt": 0
            }))
            .unwrap(),
        );
        normalize_config(&mut config);
        assert!(!config.workspaces[0].is_missing);
        assert_eq!(
            config.active_workspace_id.as_deref(),
            Some("remote:project")
        );
    }
}
