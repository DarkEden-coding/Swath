use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "window-state.json";

#[derive(Debug, Deserialize, Serialize)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    let directory = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;
    fs::create_dir_all(&directory)
        .with_context(|| format!("failed to create {}", directory.display()))?;
    Ok(directory.join(STATE_FILE))
}

/// Restores the last usable placement for a window. Placements on disconnected displays are ignored.
pub fn restore(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    let path = state_path(app)?;
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(state) = serde_json::from_str::<WindowState>(&contents) else {
        return Ok(());
    };

    if state.width == 0 || state.height == 0 || !placement_is_visible(app, &state)? {
        return Ok(());
    }

    window.set_size(PhysicalSize::new(state.width, state.height))?;
    window.set_position(PhysicalPosition::new(state.x, state.y))?;
    if state.maximized {
        window.maximize()?;
    }
    Ok(())
}

/// Persists the outer position and inner size after each native window move or resize event.
pub fn save(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    if window.is_minimized()? {
        return Ok(());
    }

    let position = window.outer_position()?;
    let size = window.inner_size()?;
    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized()?,
    };
    let path = state_path(app)?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, serde_json::to_vec(&state)?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

fn placement_is_visible(app: &AppHandle, state: &WindowState) -> Result<bool> {
    let right = state.x.saturating_add_unsigned(state.width);
    let bottom = state.y.saturating_add_unsigned(state.height);

    Ok(app.available_monitors()?.iter().any(|monitor| {
        let area = monitor.work_area();
        let area_right = area.position.x.saturating_add_unsigned(area.size.width);
        let area_bottom = area.position.y.saturating_add_unsigned(area.size.height);
        state.x < area_right && right > area.position.x && state.y < area_bottom && bottom > area.position.y
    }))
}
