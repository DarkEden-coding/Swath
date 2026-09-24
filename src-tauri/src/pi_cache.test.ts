import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cacheNotices from "./pi_cache";

/** Runs an extension event against a mutable, realistic session history. */
function fixture() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  cacheNotices({ on: (name: string, handler: (event: any, ctx: any) => void) => {
    handlers.set(name, handler);
  } } as unknown as ExtensionAPI);
  const entries: any[] = [];
  const notify = vi.fn();
  const ctx = { model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    ui: { notify }, isIdle: () => true, sessionManager: { getEntries: () => entries } };
  const fire = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const message = (input: number, cacheRead: number, model = "gpt-5.6-luna") => ({
    role: "assistant", provider: "openai-codex", model,
    timestamp: Date.now(), usage: { input, cacheRead, cacheWrite: 0 },
  });
  const end = (input: number, cacheRead: number, model?: string) => {
    const value = message(input, cacheRead, model);
    fire("message_end", { message: value });
    entries.push({ type: "message", message: value, timestamp: new Date().toISOString() });
  };
  return { entries, notify, ctx, fire, end };
}

describe("Pi cache notices", () => {
  it("reports a miss after persisted cache use, but not before", () => {
    const { notify, end } = fixture();
    end(4705, 0);
    end(118, 4608);
    expect(notify).not.toHaveBeenCalled();
    end(4747, 0, "gpt-6-luna");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cache miss"), "warning");
  });

  it("respects compaction and cache-warming entries on resume", () => {
    const { entries, notify, fire, end } = fixture();
    end(118, 4608);
    entries.push({ type: "compaction" });
    end(4750, 0);
    expect(notify).not.toHaveBeenCalled();
    entries.push({ type: "usage", kind: "cache_warm", provider: "openai-codex",
      model: "gpt-5.6-luna", timestamp: new Date().toISOString(),
      usage: { input: 100, cacheRead: 4608, cacheWrite: 0 } });
    fire("session_start");
    end(4750, 0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cache miss"), "warning");
    fire("session_shutdown");
  });

  it("warns only after Luna's 30-minute window and reschedules after a warm", () => {
    vi.useFakeTimers();
    try {
      const { entries, notify, fire, end } = fixture();
      end(118, 4608);
      fire("agent_settled");
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(notify).not.toHaveBeenCalled();
      entries.push({ type: "usage", kind: "cache_warm", provider: "openai-codex",
        model: "gpt-5.6-luna", timestamp: new Date().toISOString(),
        usage: { input: 100, cacheRead: 4608, cacheWrite: 0 } });
      vi.advanceTimersByTime(24 * 60 * 1000);
      expect(notify).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("may have expired"), "info");
      fire("session_shutdown");
    } finally {
      vi.useRealTimers();
    }
  });
});
