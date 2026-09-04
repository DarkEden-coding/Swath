import { describe, expect, it } from "vitest";
import { useRemotePassword, usesRemoteSudo } from "./pi_sudo";

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
});
