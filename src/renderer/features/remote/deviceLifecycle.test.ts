import { describe, expect, it, vi } from "vitest";
import { DeviceLifecycle } from "./deviceLifecycle";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup() {
  const calls: string[] = [];
  const lifecycle = new DeviceLifecycle(
    async (label) => {
      calls.push(`route:${label}`);
    },
    async () => {
      calls.push("local-editor");
    },
  );
  const browser = (label: string, wait?: Promise<void>) => ({
    label,
    async show() {
      calls.push(`show:${label}`);
      if (wait) await wait;
    },
    async hide() {
      calls.push(`hide:${label}`);
    },
    async close() {
      calls.push(`close:${label}`);
    },
    async setFocus() {
      calls.push(`focus:${label}`);
    },
  });
  return { lifecycle, calls, browser };
}

describe("device lifecycle", () => {
  it("serializes rapid changes and restores the local editor without focusing a stale remote", async () => {
    const { lifecycle, calls, browser } = setup();
    const wait = deferred();
    const a = browser("a", wait.promise),
      b = browser("b");
    lifecycle.add("a", a);
    lifecycle.add("b", b);
    lifecycle.created("a", a);
    lifecycle.created("b", b);
    lifecycle.select("a");
    await vi.waitFor(() => expect(calls).toContain("show:a"));
    lifecycle.select("b");
    lifecycle.select("");
    wait.release();
    await lifecycle.idle();
    expect(calls).not.toContain("focus:a");
    expect(calls).not.toContain("focus:b");
    expect(calls.at(-1)).toBe("route:null");
    expect(calls.indexOf("hide:a")).toBeLessThan(calls.lastIndexOf("local-editor"));
  });

  it.each(["show", "setFocus"] as const)("blocks paste when remote %s fails", async (operation) => {
    const route = vi.fn().mockResolvedValue(undefined);
    const failure = vi.fn();
    const lifecycle = new DeviceLifecycle(route, async () => {}, failure);
    const view = {
      label: "device-failed",
      show: async () => {},
      hide: async () => {},
      close: async () => {},
      setFocus: async () => {},
    };
    view[operation] = async () => {
      throw new Error("native failure");
    };
    lifecycle.add("failed", view);
    lifecycle.created("failed", view);
    lifecycle.select("failed");
    await lifecycle.idle();
    expect(failure).toHaveBeenCalled();
    expect(route).not.toHaveBeenCalledWith("device-failed");
    expect(route).toHaveBeenLastCalledWith("device-unavailable");
  });

  it("finishes a previous switcher's cleanup before a remount takes paste ownership", async () => {
    const { lifecycle, calls, browser } = setup();
    const closing = deferred();
    const view = browser("old");
    view.close = async () => {
      calls.push("closing");
      await closing.promise;
    };
    lifecycle.add("old", view);
    lifecycle.created("old", view);
    lifecycle.select("old");
    await lifecycle.idle();
    lifecycle.unmount();
    const route = vi.fn().mockResolvedValue(undefined);
    const replacement = new DeviceLifecycle(route, async () => {});
    replacement.select("new");
    await vi.waitFor(() => expect(calls).toContain("closing"));
    expect(route).not.toHaveBeenCalled();
    closing.release();
    await replacement.idle();
    expect(route).toHaveBeenLastCalledWith("device-unavailable");
  });

  it("routes unavailable selections away from local and recovers after native failures", async () => {
    const error = vi.fn();
    const route = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValue(undefined);
    const local = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new DeviceLifecycle(route, local, error);
    lifecycle.select("missing");
    await lifecycle.idle();
    expect(error).toHaveBeenCalledTimes(1);
    lifecycle.reconcile();
    await lifecycle.idle();
    expect(route).toHaveBeenLastCalledWith("device-unavailable");
    expect(local).not.toHaveBeenCalled();
    lifecycle.select("");
    await lifecycle.idle();
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("does not delete replacements on late errors and closes stale creations after unmount", async () => {
    const { lifecycle, calls, browser } = setup();
    const old = browser("old"),
      replacement = browser("new"),
      late = browser("late");
    lifecycle.add("a", old);
    lifecycle.remove("a");
    lifecycle.add("a", replacement);
    lifecycle.error("a", old);
    expect(lifecycle.views.get("a")?.browser).toBe(replacement);
    lifecycle.created("a", old);
    lifecycle.add("b", late);
    lifecycle.unmount();
    lifecycle.created("b", late);
    await lifecycle.idle();
    expect(calls).toContain("close:old");
    expect(calls).toContain("close:late");
    expect(calls).not.toContain("focus:late");
  });
});
