use crate::types::*;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{collections::HashMap, fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "swath.sqlite3";

/// Resolves and creates the application data directory for the config database.
fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?;
    fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
    Ok(dir.join(DB_FILE))
}

/// Opens the config database and ensures its schema is ready.
fn connection(app: &AppHandle) -> Result<Connection> {
    let file = db_path(app)?;
    migrate_legacy_sqlite_db(app, &file).ok();
    let conn =
        Connection::open(&file).with_context(|| format!("failed to open {}", file.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )",
        [],
    )?;
    Ok(conn)
}

/// Copies a legacy database into the current app data directory when needed.
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
pub fn load(app: &AppHandle) -> Result<AppConfig> {
    let conn = connection(app)?;
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
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<()> {
    let conn = connection(app)?;
    let mut normalized = config.clone();
    normalize_config(&mut normalized);
    if normalized.version != 2 {
        return Err(anyhow!("unsupported config version {}", normalized.version));
    }
    let json = serde_json::to_string_pretty(&normalized)?;
    conn.execute(
        "INSERT INTO app_config (id, json, updated_at) VALUES (1, ?1, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![json],
    )?;
    Ok(())
}

/// Repairs defaults and removes workspaces whose paths no longer exist.
fn normalize_config(config: &mut AppConfig) {
    config.version = 2;
    let mut changed_active = false;
    config.workspaces.retain(|workspace| {
        let exists = std::path::Path::new(&workspace.path).exists();
        if !exists && config.active_workspace_id.as_deref() == Some(&workspace.id) {
            changed_active = true;
        }
        exists
    });
    if changed_active
        || config
            .active_workspace_id
            .as_ref()
            .is_some_and(|id| !config.workspaces.iter().any(|w| &w.id == id))
    {
        config.active_workspace_id = config.workspaces.first().map(|w| w.id.clone());
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
