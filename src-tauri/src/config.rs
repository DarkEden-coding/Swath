use crate::types::*;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{collections::HashMap, fs, path::PathBuf};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

use crate::{network, task_store};

const DB_FILE: &str = "swath.sqlite3";

/// Resolves and creates the application data directory for the config database.
#[cfg(feature = "desktop")]
fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?;
    db_path_in(&dir)
}

/// Resolves the database path in an injected application data directory.
pub fn db_path_in(dir: &std::path::Path) -> Result<PathBuf> {
    fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    Ok(dir.join(DB_FILE))
}

/// Opens the config database and ensures its schema is ready.
#[cfg(feature = "desktop")]
fn connection(app: &AppHandle) -> Result<Connection> {
    let file = db_path(app)?;
    migrate_legacy_sqlite_db(&file)?;
    connection_at(&file)
}

/// Opens the configuration database at an injected application-data path.
pub fn connection_at(file: &std::path::Path) -> Result<Connection> {
    let conn =
        Connection::open(file).with_context(|| format!("failed to open {}", file.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS app_config_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, reason TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS local_interface_state (
            interface_id TEXT PRIMARY KEY, json TEXT NOT NULL, revision INTEGER NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS runtime_interruptions (
            id INTEGER PRIMARY KEY, recorded_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            reason TEXT NOT NULL
         );",
    )?;
    network::migrate(&conn)?;
    task_store::migrate(&conn)?;
    crate::migration::migrate(&conn)?;
    crate::pi_session_store::migrate(&conn)?;
    Ok(conn)
}

/// Initializes all durable storage for a headless or desktop runtime.
pub fn initialize(data_dir: &std::path::Path) -> Result<()> {
    let file = db_path_in(data_dir)?;
    connection_at(&file).map(|_| ())
}

/// Records that the owning executor explicitly interrupted its managed children.
pub fn record_runtime_interruption(data_dir: &std::path::Path) -> Result<()> {
    let file = db_path_in(data_dir)?;
    let conn = connection_at(&file)?;
    conn.execute(
        "INSERT INTO runtime_interruptions (reason) VALUES ('runtime_shutdown')",
        [],
    )?;
    Ok(())
}

/// Copies a legacy database into the current app data directory when needed.
fn migrate_legacy_sqlite_db(new_path: &PathBuf) -> Result<()> {
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
    let conn = connection(app)?;
    load_from_connection(&conn)
}

/// Loads configuration from an injected runtime data directory.
pub fn load_at(data_dir: &std::path::Path) -> Result<AppConfig> {
    let file = db_path_in(data_dir)?;
    let conn = connection_at(&file)?;
    load_from_connection(&conn)
}

fn load_from_connection(conn: &Connection) -> Result<AppConfig> {
    let json: Option<String> = conn
        .query_row("SELECT json FROM app_config WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()?;

    let mut config = if let Some(json) = json {
        serde_json::from_str::<AppConfig>(&json).map_err(|err| {
            anyhow!("cannot read required legacy v2 config; restore app_config backup before continuing: {err}")
        })?
    } else {
        default_config()
    };
    if config.version != 2 {
        return Err(anyhow!(
            "unsupported config version {}; install a compatible Swath version or restore a v2 backup",
            config.version
        ));
    }
    // Legacy JSON is intentionally left untouched until the user reviews a migration preview.
    // `migration_confirm` is the only path that creates catalog projects/tasks from it.
    normalize_config(&mut config);
    Ok(config)
}

/// Loads interface-local selection, layout, and drafts without exposing them to the catalog.
pub fn load_local_interface_state(
    data_dir: &std::path::Path,
    interface_id: &str,
) -> Result<Option<LocalInterfaceState>> {
    let conn = connection_at(&db_path_in(data_dir)?)?;
    let json: Option<String> = conn
        .query_row(
            "SELECT json FROM local_interface_state WHERE interface_id = ?1",
            params![interface_id],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|value| {
        serde_json::from_str(&value)
            .map_err(|err| anyhow!("cannot read local interface state: {err}"))
    })
    .transpose()
}

/// Saves local interface state with an expected revision to avoid whole-object overwrite races.
pub fn save_local_interface_state(
    data_dir: &std::path::Path,
    state: &LocalInterfaceState,
    expected_revision: i64,
) -> Result<()> {
    let conn = connection_at(&db_path_in(data_dir)?)?;
    let json = serde_json::to_string(state)?;
    let updated = conn.execute(
        "UPDATE local_interface_state SET json = ?1, revision = revision + 1, updated_at = strftime('%s','now')
         WHERE interface_id = ?2 AND revision = ?3",
        params![json, state.interface_id, expected_revision],
    )?;
    if updated == 1 {
        return Ok(());
    }
    if expected_revision == 0 {
        let inserted = conn.execute(
            "INSERT INTO local_interface_state (interface_id, json, revision) VALUES (?1, ?2, 1)
             ON CONFLICT(interface_id) DO NOTHING",
            params![state.interface_id, serde_json::to_string(state)?],
        )?;
        if inserted == 1 {
            return Ok(());
        }
    }
    Err(anyhow!(
        "local interface state revision conflict; reload before saving"
    ))
}

/// Normalizes and persists the application configuration.
#[cfg(feature = "desktop")]
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<()> {
    let conn = connection(app)?;
    save_to_connection(&conn, config)
}

fn save_to_connection(conn: &Connection, config: &AppConfig) -> Result<()> {
    let migrated: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM legacy_import_operations WHERE state='complete' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if migrated.is_some() {
        return Err(anyhow!(
            "legacy whole-config writes are not supported after catalog migration"
        ));
    }
    let mut normalized = config.clone();
    if normalized.version != 2 {
        return Err(anyhow!("unsupported config version {}", normalized.version));
    }
    // Whole-config saves are compatibility-only before migration; they never import silently.
    normalize_config(&mut normalized);
    let json = serde_json::to_string_pretty(&normalized)?;
    conn.execute(
        "INSERT INTO app_config (id, json, updated_at) VALUES (1, ?1, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![json],
    )?;
    Ok(())
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
    fn local_interface_state_survives_restart_with_history_and_pane_state() {
        let dir = std::env::temp_dir().join(format!("swath-local-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state: LocalInterfaceState = serde_json::from_value(serde_json::json!({
            "interfaceId": "task:network",
            "activeProjectId": "project",
            "activeTaskId": null,
            "historicalTaskId": "completed-task",
            "focusedPaneId": "pane-2",
            "taskLayouts": { "completed-task": ["pane-2", "pane-1"] },
            "drafts": { "pane-2": "unsent" },
            "revision": 1
        }))
        .unwrap();
        save_local_interface_state(&dir, &state, 0).unwrap();
        let restored = load_local_interface_state(&dir, "task:network")
            .unwrap()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            restored.historical_task_id.as_deref(),
            Some("completed-task")
        );
        assert_eq!(restored.focused_pane_id.as_deref(), Some("pane-2"));
        assert_eq!(restored.task_layouts["completed-task"][0], "pane-2");
        assert_eq!(restored.drafts["pane-2"], "unsent");
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
    fn shared_schema_is_idempotent_and_keeps_same_hostname_devices_distinct() {
        let conn = Connection::open_in_memory().unwrap();
        network::migrate(&conn).unwrap();
        task_store::migrate(&conn).unwrap();
        network::migrate(&conn).unwrap();
        task_store::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO networks (id, name, schema_version, revision, created_at) VALUES ('net', 'n', 1, 1, 0)",
            [],
        ).unwrap();
        for enrollment in ["one", "two"] {
            conn.execute(
                "INSERT INTO devices (id, network_id, display_name, hostname, platform, enrollment_id, revision, created_at)
                 VALUES (?1, 'net', 'same', 'same', 'test', ?2, 1, 0)",
                params![format!("dev-{enrollment}"), enrollment],
            ).unwrap();
        }
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM devices WHERE hostname = 'same'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn rejects_unknown_shared_schema_records() {
        let conn = Connection::open_in_memory().unwrap();
        network::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (name, version) VALUES ('future_catalog', 2)",
            [],
        )
        .unwrap();
        assert!(network::migrate(&conn)
            .unwrap_err()
            .to_string()
            .contains("unsupported migration record"));
    }

    #[test]
    fn operation_dedup_rejects_a_reused_id_for_different_requests() {
        let conn = Connection::open_in_memory().unwrap();
        task_store::migrate(&conn).unwrap();
        task_store::record_operation(&conn, "op", "createTask", "one", "{} ").unwrap();
        task_store::record_operation(&conn, "op", "createTask", "one", "{} ").unwrap();
        assert!(task_store::record_operation(&conn, "op", "createTask", "two", "{} ").is_err());
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
