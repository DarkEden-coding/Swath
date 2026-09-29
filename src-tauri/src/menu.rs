use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager,
};

static ACTIVE_REMOTE_VIEW: Mutex<(Option<String>, u64)> = Mutex::new((None, 0));

/// Reject clipboard reads completed after any device selection change, including reselection.
fn should_deliver_remote(selected: &(Option<String>, u64), label: &str, revision: u64) -> bool {
    selected.0.as_deref() == Some(label) && selected.1 == revision
}

/// Records the view selected by the device switcher for native menu paste routing.
pub fn select_remote_view(label: Option<String>) -> Result<(), String> {
    if label
        .as_ref()
        .is_some_and(|value| !value.starts_with("device-"))
    {
        return Err("Invalid remote webview label".into());
    }
    let mut selected = ACTIVE_REMOTE_VIEW
        .lock()
        .map_err(|_| "Device selection state poisoned")?;
    selected.0 = label;
    selected.1 = selected.1.wrapping_add(1);
    Ok(())
}

/// Sends menu paste only to the selected remote webview, never a hidden one.
fn paste_into_remote_view(app: &AppHandle) -> bool {
    let selection = match ACTIVE_REMOTE_VIEW.lock() {
        Ok(selected) => selected.clone(),
        Err(error) => {
            eprintln!("Cannot determine clipboard destination; paste discarded: {error}");
            return true;
        }
    };
    let (Some(label), revision) = selection else {
        return false;
    };
    let Some(view) = app.get_webview(&label) else {
        eprintln!("Selected remote Swath view {label} is unavailable; paste discarded");
        return true;
    };
    let result = crate::platform::read_clipboard_for_terminal(app.clone()).and_then(|payload| {
        // Clipboard reads may block; never deliver to a view deselected in the meantime.
        if !ACTIVE_REMOTE_VIEW
            .lock()
            .ok()
            .is_some_and(|selected| should_deliver_remote(&selected, &label, revision))
        {
            return Ok(());
        }
        let detail = serde_json::to_string(&payload)?;
        view.eval(format!(
            "window.dispatchEvent(new CustomEvent('swath:embedded-paste', {{ detail: {detail} }}))"
        ))?;
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("Unable to paste into remote Swath: {error}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_selection_cannot_deliver_even_after_reselection() {
        let old = (Some("device-a".into()), 1);
        assert!(should_deliver_remote(&old, "device-a", 1));
        assert!(!should_deliver_remote(
            &(Some("device-b".into()), 2),
            "device-a",
            1
        ));
        assert!(!should_deliver_remote(
            &(Some("device-a".into()), 3),
            "device-a",
            1
        ));
        assert!(!should_deliver_remote(
            &(Some("device-unavailable".into()), 4),
            "device-a",
            1
        ));
    }

    #[test]
    fn device_selection_clears_hidden_remote_paste_target() {
        select_remote_view(Some("device-1".into())).unwrap();
        assert_eq!(
            ACTIVE_REMOTE_VIEW.lock().unwrap().0.as_deref(),
            Some("device-1")
        );
        select_remote_view(None).unwrap();
        assert!(ACTIVE_REMOTE_VIEW.lock().unwrap().0.is_none());
        assert!(select_remote_view(Some("main".into())).is_err());
        select_remote_view(Some("device-unavailable".into())).unwrap();
        assert_eq!(
            ACTIVE_REMOTE_VIEW.lock().unwrap().0.as_deref(),
            Some("device-unavailable")
        );
        select_remote_view(None).unwrap();
    }
}

fn command_item(
    app: &AppHandle,
    command: &str,
    label: &str,
    accelerator: &str,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    MenuItemBuilder::with_id(command, label)
        .accelerator(accelerator)
        .build(app)
}

pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let add_workspace = command_item(app, "workspace:add", "Add Workspace", "CmdOrCtrl+Shift+O")?;
    let new_view = command_item(app, "view:new", "New Workspace View", "CmdOrCtrl+T")?;
    let close_view = command_item(app, "view:close", "Close Workspace View", "CmdOrCtrl+W")?;
    let split_right = command_item(app, "pane:split-right", "Split Right", "CmdOrCtrl+\\")?;
    let split_down = command_item(app, "pane:split-down", "Split Down", "CmdOrCtrl+Shift+\\")?;
    let close_pane = command_item(app, "pane:close", "Close Pane", "CmdOrCtrl+Shift+W")?;
    let paste = command_item(app, "terminal:paste", "Paste", "CmdOrCtrl+V")?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .item(&paste)
        .separator()
        .select_all()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&add_workspace)
        .item(&new_view)
        .item(&close_view)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let terminal = SubmenuBuilder::new(app, "Terminal")
        .item(&split_right)
        .item(&split_down)
        .item(&close_pane)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .text("reload", "Reload")
        .text("force-reload", "Force Reload")
        .text("toggle-devtools", "Toggle Developer Tools")
        .separator()
        .text("reset-zoom", "Actual Size")
        .text("zoom-in", "Zoom In")
        .text("zoom-out", "Zoom Out")
        .separator()
        .text("toggle-fullscreen", "Toggle Full Screen")
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&edit)
        .item(&file)
        .item(&terminal)
        .item(&view)
        .build()?;

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let command = event.id().as_ref();
        if command == "terminal:paste" && paste_into_remote_view(app) {
            return;
        }
        match command {
            "workspace:add" | "view:new" | "view:close" | "pane:split-right"
            | "pane:split-down" | "pane:close" | "terminal:paste" => {
                let _ = app.emit("app:command", command);
            }
            _ => {}
        }
    });

    Ok(())
}
