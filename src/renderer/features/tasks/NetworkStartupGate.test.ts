import { describe, expect, it } from "vitest";
import { joinRequest } from "./NetworkStartupGate";

describe("network startup gate", () => {
  it("does not turn incomplete join data into a network creation request", () => {
    expect(joinRequest("", "https://host", "1234567890123456")).toBeNull();
    expect(joinRequest("net_1", "", "1234567890123456")).toBeNull();
    expect(joinRequest("net_1", "https://host", "short")).toBeNull();
  });

  it("keeps an explicit manual join request intact for retry", () => {
    expect(joinRequest(" net_1 ", " https://host ", " 1234567890123456 ")).toEqual({
      networkId: "net_1",
      endpoint: "https://host",
      secret: "1234567890123456",
    });
  });
});
