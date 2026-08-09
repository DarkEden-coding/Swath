import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearErrorLog, getErrorLog, reportError, subscribeToErrorLog } from "./errorLog";

describe("errorLog", () => {
  beforeEach(() => {
    clearErrorLog();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("records newest first and notifies subscribers", () => {
    let notified = 0;
    const unsubscribe = subscribeToErrorLog(() => (notified += 1));
    reportError("first", new Error("boom"));
    reportError("second", "plain string");
    unsubscribe();

    const [newest, oldest] = getErrorLog();
    expect(newest.source).toBe("second");
    expect(newest.message).toBe("plain string");
    expect(oldest.message).toBe("Error: boom");
    expect(oldest.stack).toBeDefined();
    expect(notified).toBe(2);
  });

  it("keeps the log bounded", () => {
    for (let i = 0; i < 120; i += 1) reportError("noisy", `error ${i}`);
    expect(getErrorLog()).toHaveLength(100);
    expect(getErrorLog()[0].message).toBe("error 119");
  });

  /** Only critical entries take over the screen; everything else waits in Settings. */
  it("defaults to non-critical", () => {
    reportError("quiet", "warning");
    expect(getErrorLog()[0].critical).toBe(false);
  });
});
