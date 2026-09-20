import { afterEach, describe, expect, it, vi } from "vitest";
import { errorMessage, useNotificationStore } from "./notificationStore";

describe("notificationStore", () => {
  afterEach(() => {
    vi.useRealTimers();
    useNotificationStore.setState({ notifications: [] });
  });

  it("automatically dismisses errors after four seconds", () => {
    vi.useFakeTimers();
    useNotificationStore.getState().notifyError("Deletion failed");
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    vi.advanceTimersByTime(3_999);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("uses useful thrown error messages", () => {
    expect(errorMessage(new Error("not leader"), "Fallback")).toBe("not leader");
    expect(errorMessage(null, "Fallback")).toBe("Fallback");
  });
});
