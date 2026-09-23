import { describe, expect, it } from "vitest";
import sudoPrompt, { useRemotePassword, usesRemoteSudo } from "./pi_sudo";

describe("remote sudo prompting", () => {
  it("pipes the saved password into sudo running through ssh", () => {
    const command = 'cd /tmp && ssh admin@example.test "sudo -n systemctl restart app"';

    expect(usesRemoteSudo(command)).toBe(true);
    expect(useRemotePassword(command, "/tmp/swath sudo/password")).toBe(
      'cd /tmp && cat "/tmp/swath sudo/password" | ssh admin@example.test "sudo -k -S systemctl restart app"',
    );
  });

  it("leaves local sudo on the local askpass path", () => {
    expect(usesRemoteSudo("sudo apt-get update")).toBe(false);
  });

  it("reuses remote passwords per host until the session ends", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const prompts: string[] = [];
    sudoPrompt({
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    } as any);
    const context = {
      ui: {
        input: async (_title: string, label: string) => {
          prompts.push(label);
          return "test-password";
        },
      },
    };
    const call = handlers.get("tool_call")!;
    for (const host of ["first.test", "first.test", "second.test"]) {
      const input = { command: `ssh user@${host} "sudo id"` };
      await call({ toolName: "bash", input }, context);
      expect(input.command).toContain("cat ");
    }
    expect(prompts).toHaveLength(2);
    handlers.get("session_shutdown")!();
  });
});
