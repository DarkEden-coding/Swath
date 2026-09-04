# Remote connectors

Swath can expose one running desktop instance to other Swath apps and web browsers. The connector
is designed for a private Tailscale network, but still requires a bearer token so another process
on the tailnet cannot silently take over a shell.

## Host a device

Open **Settings → Remote connector & Web UI**, choose a bind address and port, and generate a token.
Use `0.0.0.0` to listen on the device's Tailscale and LAN interfaces, or bind the device's Tailscale
IP for a narrower listener. Tokens must be at least 16 characters.

The displayed URL includes a one-time `?token=` sign-in link. The server exchanges it for an
HttpOnly, SameSite cookie and immediately redirects to `/`, keeping the token out of subsequent
navigation. Static hashed assets are cached; the HTML entrypoint is not.

Server-oriented installs can auto-start without opening Settings by defining
`SWATH_CONNECTOR_TOKEN` and, optionally, `SWATH_CONNECTOR_BIND` (default `127.0.0.1`) and
`SWATH_CONNECTOR_PORT` (default `7878`) before launching Swath.

## Connect from the desktop app

Choose **Connect to Remote** in the sidebar and enter the connector's Tailscale URL and token.
Remote projects are imported with a `remote` health badge. Terminal, Git manager, file browser,
image prompts, and Pi CodingAgent calls are routed to their owning machine. Session and pane owners
are retained for follow-up messages and process events.

Project paths and ids are namespaced inside the client. This prevents a local `/repo` from being
confused with a remote `/repo`, and prevents pane/session collisions. Groups are machine-scoped:
menu grouping, drag grouping, and config repair all reject members from different devices.

## Protocol and bandwidth

Protocol version 1 uses one authenticated WebSocket per device. JSON RPC responses and live
terminal/Git/Pi events share that socket; there is no polling. Terminal reads are already batched in
8 KiB chunks, file trees are loaded one directory level at a time, and images remain explicitly
batched. Reconnect uses a two-second backoff while consumers are subscribed.

Connector traffic is plaintext when the URL uses HTTP. Tailscale encrypts it on the tailnet; for
exposure beyond a tailnet, put the connector behind Tailscale Serve or another HTTPS reverse proxy.
