use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter,
};

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

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
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
        match command {
            "workspace:add" | "view:new" | "view:close" | "pane:split-right"
            | "pane:split-down" | "pane:close" => {
                let _ = app.emit("app:command", command);
            }
            _ => {}
        }
    });

    Ok(())
}
