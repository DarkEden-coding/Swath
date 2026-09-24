import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

// Anthropic defaults to five minutes; GPT-5.6's guaranteed cache window is 30 minutes.
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const CACHE_MISS_NOISE_FLOOR = 1024;

interface PreviousRequest {
  promptTokens: number;
  model: string;
  timestamp: number;
  reportedCache: boolean;
  cachedTokens: number;
}

/** Extracts the previous provider request, honoring Pi's compaction and warm-usage boundaries. */
function previousRequest(entries: SessionEntry[]): PreviousRequest | undefined {
  let previous: PreviousRequest | undefined;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      previous = undefined;
    } else if (entry.type === "usage" && entry.kind === "cache_warm") {
      const tokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
      if (tokens > 0) previous = {
        promptTokens: tokens,
        model: `${entry.provider}/${entry.model}`,
        timestamp: Date.parse(entry.timestamp),
        reportedCache: true,
        cachedTokens: entry.usage.cacheRead + entry.usage.cacheWrite,
      };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message;
      const tokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      if (tokens > 0) previous = {
        promptTokens: tokens,
        model: `${message.provider}/${message.model}`,
        timestamp: message.timestamp,
        reportedCache: (previous?.reportedCache ?? false) || message.usage.cacheRead + message.usage.cacheWrite > 0,
        cachedTokens: message.usage.cacheRead + message.usage.cacheWrite,
      };
    }
  }
  return previous;
}

/** Reports Pi-compatible cache misses and estimates idle expiry only for known retention windows. */
export default function cacheNotices(pi: ExtensionAPI): void {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Refreshes the idle estimate from persisted usage, including cache-warming requests. */
  const scheduleExpiry = (ctx: ExtensionContext): void => {
    clearTimeout(expiryTimer);
    const previous = previousRequest(ctx.sessionManager.getEntries());
    const ttl = ctx.model?.provider === "anthropic" ? FIVE_MINUTES_MS
      : ctx.model?.provider === "openai-codex" && ctx.model.id.startsWith("gpt-5.6-")
        ? THIRTY_MINUTES_MS : undefined;
    if (!previous || !ttl || !ctx.model || !previous.cachedTokens ||
      previous.model !== `${ctx.model.provider}/${ctx.model.id}`) return;
    expiryTimer = setTimeout(() => {
      if (!ctx.isIdle()) {
        expiryTimer = setTimeout(() => scheduleExpiry(ctx), 60_000);
        return;
      }
      const latest = previousRequest(ctx.sessionManager.getEntries());
      if (latest?.timestamp !== previous.timestamp) {
        scheduleExpiry(ctx);
        return;
      }
      ctx.ui.notify("Prompt cache may have expired while idle; it may still be available.", "info");
    }, Math.max(0, previous.timestamp + ttl - Date.now()));
  };

  pi.on("session_start", (_event, ctx) => scheduleExpiry(ctx));
  pi.on("session_shutdown", () => clearTimeout(expiryTimer));
  pi.on("turn_start", () => clearTimeout(expiryTimer));
  pi.on("agent_settled", (_event, ctx) => scheduleExpiry(ctx));

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const usage = message.usage;
    const previous = previousRequest(ctx.sessionManager.getEntries());
    const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (previous && tokens > 0 && (usage.cacheRead + usage.cacheWrite > 0 || previous.reportedCache) &&
      Math.min(previous.promptTokens, tokens) - usage.cacheRead > CACHE_MISS_NOISE_FLOOR) {
      ctx.ui.notify("Prompt cache miss: previously sent input was not read from cache.", "warning");
    }
  });
}
