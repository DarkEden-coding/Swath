//! Event delivery shared by the desktop and display-free connector.

use serde::Serialize;
use serde_json::json;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

#[derive(Clone)]
pub enum EventSink {
    #[cfg(feature = "desktop")]
    Desktop(AppHandle),
    Headless(broadcast::Sender<String>),
}

impl EventSink {
    pub fn emit<T: Serialize>(&self, channel: &str, payload: T) {
        let value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        match self {
            #[cfg(feature = "desktop")]
            Self::Desktop(app) => {
                let _ = app.emit(channel, value);
            }
            Self::Headless(sender) => {
                let _ = sender
                    .send(json!({"type":"event","channel":channel,"payload":value}).to_string());
            }
        }
    }
}
