import { expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
type CommandListener = Parameters<typeof listen<string>>[1];
import { createTauriSwath } from "./tauriAdapter";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

it("does not deliver paste twice while an old command listener is still registering", async () => {
  let deliver!: CommandListener;
  let registered!: (unlisten: () => void) => void;
  vi.mocked(listen).mockImplementation((_channel, callback) => {
    deliver = callback as CommandListener;
    return new Promise((resolve) => {
      registered = resolve;
    });
  });
  const command = vi.fn();
  const dispose = createTauriSwath().app.onCommand(command);
  deliver({ payload: "terminal:paste" });
  expect(command).toHaveBeenCalledTimes(1);
  dispose();
  deliver({ payload: "terminal:paste" });
  expect(command).toHaveBeenCalledTimes(1);
  const unlisten = vi.fn();
  registered(unlisten);
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledTimes(1);
});
