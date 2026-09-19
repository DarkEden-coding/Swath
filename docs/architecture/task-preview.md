# Task previews

A preview URL is a capability for one ready task and one explicitly approved port. Approve it with `task.rpc({ op: "approvePreview", taskId, port })`; the connector resolves it only to executor loopback.

HTTP previews use `/api/preview/:taskId/:port/...`. WebSocket previews use `/api/preview/:taskId/:port/ws/...`. The connector forwards only GET, HEAD, and POST HTTP requests, a small header allowlist, and no arbitrary hosts or paths. Preview pages are sandboxed so they cannot use the Swath control origin or its authentication cookie.
