use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const TERMINAL_REPLAY_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const GIT_RUN_MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u8,
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub views: Vec<WorkspaceView>,
    pub active_view_id: String,
    pub created_at: f64,
    pub updated_at: f64,
    #[serde(default)]
    pub tabs: Option<Vec<WorkspaceView>>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub id: String,
    #[serde(default)]
    pub r#type: Option<String>,
    pub title: String,
    pub layout: LayoutNode,
    pub active_pane_id: String,
    #[serde(default)]
    pub health: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LayoutNode {
    #[serde(rename = "pane")]
    Pane(Box<PaneLeaf>),
    #[serde(rename = "split")]
    Split(SplitNode),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLeaf {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt_label: Option<String>,
    #[serde(default)]
    pub demo_banner: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub shell_profile: Option<ShellProfile>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub terminal: Option<TerminalPaneConfig>,
    #[serde(default)]
    pub metadata: Option<PaneMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitNode {
    pub id: String,
    pub direction: String,
    pub ratio: f64,
    pub first: Box<LayoutNode>,
    pub second: Box<LayoutNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPaneConfig {
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub shell_profile: Option<ShellProfile>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub metadata: Option<PaneMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneMetadata {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub shell_profile_id: Option<String>,
    #[serde(default)]
    pub shell_profile: Option<ShellProfile>,
    #[serde(default)]
    pub env: Option<serde_json::Value>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub default_shell_profile_id: String,
    pub shell_profiles: Vec<ShellProfile>,
    pub global_env: HashMap<String, String>,
    pub confirm_before_closing_pane: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSelectResult {
    pub canceled: bool,
    pub path: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmDialogRequest {
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub confirm_label: Option<String>,
    #[serde(default)]
    pub cancel_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionStartRequest {
    pub session_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub shell_profile: Option<ShellProfile>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub metadata: Option<PaneMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResizeRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionAttachRequest {
    pub session_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub shell_profile: Option<ShellProfile>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub metadata: Option<PaneMetadata>,
    #[serde(default)]
    pub replay: Option<bool>,
}

impl From<TerminalSessionAttachRequest> for TerminalSessionStartRequest {
    fn from(value: TerminalSessionAttachRequest) -> Self {
        Self {
            session_id: value.session_id,
            cwd: value.cwd,
            cols: value.cols,
            rows: value.rows,
            shell_profile: value.shell_profile,
            env: value.env,
            metadata: value.metadata,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionStatus {
    pub session_id: String,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEventPayload {
    pub session_id: String,
    pub exit_code: i32,
    #[serde(default)]
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClipboardPayload {
    pub text: String,
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPastePermissionStatus {
    pub accessibility: String,
}
