# Remote connectors

Swath can expose one running desktop instance to other Swath apps and web browsers. The connector
is designed for a private Tailscale network, but still requires a bearer token so another process
on the tailnet cannot silently take over a shell.

## Host a device

Open **Settings → Remote connector & Web UI**, leave the backend bound to `127.0.0.1`, keep
**Publish securely with Tailscale Serve** enabled, and generate a token. Swath starts the private
loopback connector and asks Tailscale Serve to publish it at
`https://<device>.<tailnet>.ts.net/`. Tailscale terminates TLS on port 443 and proxies HTTP to the
loopback port; the backend is not exposed directly to the LAN or tailnet. Tokens must be at least
16 characters and remain required in addition to tailnet access.

MagicDNS and HTTPS certificates must be enabled for the tailnet. Tailscale Serve normally handles
certificate provisioning automatically. If Tailscale is installed somewhere the app cannot find,
set `SWATH_TAILSCALE_BIN` to the CLI path before launching Swath. HTTPS certificate names are
recorded in public Certificate Transparency logs, although the service remains tailnet-only.

The displayed URL includes a one-time `?token=` sign-in link. The server exchanges it for an
HttpOnly, SameSite cookie and immediately redirects to `/`, keeping the token out of subsequent
navigation. Static hashed assets are cached; the HTML entrypoint is not.

Server-oriented installs can auto-start without opening Settings by defining
`SWATH_CONNECTOR_TOKEN` and, optionally, `SWATH_CONNECTOR_BIND` (default `127.0.0.1`) and
`SWATH_CONNECTOR_PORT` (default `7878`) before launching Swath. Set
`SWATH_CONNECTOR_TAILSCALE_HTTPS=1` to configure Tailscale Serve automatically. The equivalent
manual command is:

```sh
tailscale serve --bg --yes --https=443 http://127.0.0.1:7878
```

## Connect from the desktop app

Open **Settings → Remote connector & Web UI → Add connection** and enter the connector's Tailscale
HTTPS URL and token. The default HTTPS port does not need to be entered. Native Edit → Paste works
in both connection fields, including the masked token field. Adding a connection saves the machine
without importing its existing Swath workspaces. Addresses entered without a scheme default to
HTTPS.

Choose **Add Project**, select **Remote**, choose a saved machine, and browse to the folder that
should become a project. Remote projects receive a `remote` health badge. Terminal, Git manager,
file browser, image prompts, and Pi CodingAgent calls are routed to their owning machine. Session
and pane owners are retained for follow-up messages and process events.

Project paths and ids are namespaced inside the client. This prevents a local `/repo` from being
confused with a remote `/repo`, and prevents pane/session collisions. Groups are machine-scoped:
menu grouping, drag grouping, and config repair all reject members from different devices.

## Protocol and bandwidth

Protocol version 1 uses one authenticated WebSocket per device. JSON RPC responses and live
terminal/Git/Pi events share that socket; there is no polling. Terminal reads are already batched in
8 KiB chunks, file trees are loaded one directory level at a time, and images remain explicitly
batched. Reconnect uses a two-second backoff while consumers are subscribed.

Tailscale Serve terminates HTTPS at the local Tailscale daemon, then proxies over loopback to Swath.
The public internet cannot reach the service; this is Serve, not Funnel. Swath's token remains
mandatory because tailnet membership alone does not authorize terminal access.
