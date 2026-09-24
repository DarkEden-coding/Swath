import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const PORT = 8443; // Separate from Swath's connector on 443.

/** Parses the CLI's JSON response and reports which command failed. */
function statusJson<T>(output: string, command: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(
      `Tailscale ${command} returned non-JSON output: ${output.trim().slice(0, 120)}`,
    );
  }
}

async function tailscale(...args: string[]): Promise<string> {
  const candidates = [
    ...(process.env.SWATH_TAILSCALE_BIN ? [process.env.SWATH_TAILSCALE_BIN] : []),
    ...(process.platform === "darwin"
      ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
      : []),
    "tailscale",
  ];
  for (const binary of candidates) {
    try {
      // The macOS app-bundled CLI can fail to launch its GUI helper when executed directly
      // from a Pi child; a shell parent matches the working terminal invocation.
      const { stdout } =
        process.platform === "darwin"
          ? await runFile("/bin/sh", ["-c", '"$0" "$@"', binary, ...args], { timeout: 10_000 })
          : await runFile(binary, args, { timeout: 10_000 });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error("Tailscale CLI is unavailable");
}

/** This extension is not auto-invoked: publish only after explicit UI approval. */
export default function publishLocalhost(pi: ExtensionAPI): void {
  let owned: { target: string; hostname: string } | undefined;

  pi.registerTool({
    name: "publish_localhost_tailnet",
    label: "Publish localhost to tailnet",
    description:
      "Only call when the user explicitly requests publishing an existing localhost URL to their PRIVATE Tailscale tailnet. Never publish proactively. Requires user confirmation; never enables Funnel/public access.",
    parameters: Type.Object({
      url: Type.String({
        description: "Existing http://localhost or http://127.0.0.1 URL, optionally with a path",
      }),
    }),
    async execute(_id, { url }, _signal, _onUpdate, ctx) {
      try {
        const source = new URL(url);
        if (
          source.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(source.hostname) ||
          !source.port ||
          source.username ||
          source.password ||
          source.search ||
          source.hash
        ) {
          throw new Error(
            "Provide an HTTP localhost URL with an explicit port and optional path (no query, fragment, or credentials)",
          );
        }
        if (owned) throw new Error("This session already has a published URL");
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Publish to tailnet?",
            `${source.origin} (the whole local site, not only ${source.pathname}) will be reachable by devices permitted by your tailnet ACLs. Continue?`,
          ))
        ) {
          throw new Error("Publishing requires explicit user approval");
        }
        // A separate port leaves Swath's 443 connector untouched.
        // ponytail: the status check is not atomic across Pi processes; add a shared lock if concurrent publishes matter.
        const config = statusJson<{
          TCP?: Record<string, unknown>;
          Web?: Record<string, unknown>;
          AllowFunnel?: Record<string, unknown>;
        }>(await tailscale("serve", "status", "--json"), "serve status");
        if (
          !config ||
          typeof config !== "object" ||
          Object.keys(config.TCP ?? {}).some(
            (key) => key === String(PORT) || key.endsWith(`:${PORT}`),
          ) ||
          Object.keys(config.Web ?? {}).some((key) => key.endsWith(`:${PORT}`)) ||
          Object.keys(config.AllowFunnel ?? {}).some((key) => key.endsWith(`:${PORT}`))
        ) {
          throw new Error(
            `Tailscale Serve port ${PORT} is occupied or its status cannot be verified`,
          );
        }
        const status = statusJson<{ Self?: { DNSName?: string } }>(
          await tailscale("status", "--json"),
          "status",
        );
        const hostname = status.Self?.DNSName?.replace(/\.$/, "");
        if (!hostname || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(hostname))
          throw new Error("Tailscale DNS name unavailable");
        // Serve proxies the whole local origin; retain the requested path in the returned URL.
        const target = source.origin;
        await tailscale("serve", "--bg", "--yes", `--https=${PORT}`, target);
        owned = { target, hostname };
        const published = `https://${hostname}:${PORT}${source.pathname}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Published privately to your tailnet: ${published}. The entire ${source.origin} site is available at this address.`,
            },
          ],
          details: { url: published },
        };
      } catch (error) {
        throw new Error(`Not published: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (!owned) return;
    const route = owned;
    owned = undefined;
    try {
      const config = JSON.parse(await tailscale("serve", "status", "--json")) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      };
      const handlers = config.Web?.[`${route.hostname}:${PORT}`]?.Handlers;
      // Never remove a route if another process changed it or added a sibling mount.
      if (
        handlers &&
        Object.keys(handlers).length === 1 &&
        handlers["/"]?.Proxy &&
        new URL(handlers["/"].Proxy).origin === route.target
      ) {
        await tailscale("serve", `--https=${PORT}`, "off");
      }
    } catch {
      /* Fail closed: leave a changed/unknown route untouched. */
    }
  });
}
