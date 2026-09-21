//! Runtime event delivery shared by desktop and connector consumers.

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::broadcast;

// Terminal output is published in chunks that can be several KiB each.  The event channel is
// intentionally bounded, but the old 1024-entry ring could be exhausted by a single busy PTY
// before a connector websocket got scheduled again.  Keep enough headroom for a short scheduling
// stall while retaining a finite memory bound (roughly 64 MiB for 8 KiB events).
const CONNECTOR_EVENT_CAPACITY: usize = 8192;

/// Publishes runtime events without requiring a desktop window.
pub trait EventPublisher: Send + Sync {
    /// Publishes one serializable event on `channel`.
    fn publish(&self, channel: &str, payload: serde_json::Value);
}

/// Connector-facing event stream. Native consumers may be added with [`FanoutPublisher`].
pub struct ConnectorEvents {
    sender: broadcast::Sender<String>,
}

impl ConnectorEvents {
    /// Creates an event stream with a bounded live-event buffer.
    pub fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(CONNECTOR_EVENT_CAPACITY);
        Arc::new(Self { sender })
    }

    /// Subscribes a connector client to live runtime events.
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }
}

impl EventPublisher for ConnectorEvents {
    fn publish(&self, channel: &str, payload: serde_json::Value) {
        let _ = self.sender.send(
            serde_json::json!({ "type": "event", "channel": channel, "payload": payload })
                .to_string(),
        );
    }
}

/// Sends every event to each configured concrete consumer.
pub struct FanoutPublisher {
    consumers: Vec<Arc<dyn EventPublisher>>,
}

impl FanoutPublisher {
    /// Combines native and connector event consumers.
    pub fn new(consumers: Vec<Arc<dyn EventPublisher>>) -> Arc<Self> {
        Arc::new(Self { consumers })
    }
}

impl EventPublisher for FanoutPublisher {
    fn publish(&self, channel: &str, payload: serde_json::Value) {
        for consumer in &self.consumers {
            consumer.publish(channel, payload.clone());
        }
    }
}

/// Native Tauri event consumer, kept at the desktop boundary.
#[cfg(feature = "desktop")]
pub struct TauriEvents {
    app: tauri::AppHandle,
}

#[cfg(feature = "desktop")]
impl TauriEvents {
    /// Creates a publisher for desktop webview events.
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

#[cfg(feature = "desktop")]
impl EventPublisher for TauriEvents {
    fn publish(&self, channel: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(channel, payload);
    }
}

/// Converts an event payload to JSON for callers with typed payloads.
pub fn value<T: Serialize>(payload: T) -> serde_json::Value {
    serde_json::to_value(payload).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_a_busy_terminal_burst_for_a_slow_subscriber() {
        let events = ConnectorEvents::new();
        let mut receiver = events.subscribe();
        let chunk = "x".repeat(8 * 1024);

        // This is twice the previous ring size and models a short period where a connector
        // websocket is descheduled while a PTY continues producing output.
        for sequence in 0..2048 {
            events.publish(
                "terminal:data",
                json!({"sessionId":"session","sequence":sequence,"data":&chunk}),
            );
        }

        for sequence in 0..2048 {
            let event = receiver
                .try_recv()
                .expect("the bounded connector ring should retain the burst");
            let event: serde_json::Value =
                serde_json::from_str(&event).expect("connector events are valid JSON");
            assert_eq!(event["channel"], "terminal:data");
            assert_eq!(event["payload"]["sequence"], sequence);
        }
    }
}
