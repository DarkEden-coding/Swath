import { describe, expect, it } from "vitest";
import { remoteRpcError } from "./remoteAdapter";

describe("remoteRpcError", () => {
  it("flattens nested transport and catalog envelopes", () => {
    const error = remoteRpcError(
      JSON.stringify({
        code: "executor_unavailable",
        error: {
          error: {
            code: "catalog_unavailable",
            message: "database is locked",
            retryable: true,
          },
        },
      }),
    );
    expect(error.message).toBe("executor_unavailable → catalog_unavailable: database is locked");
    expect(error.codes).toEqual(["executor_unavailable", "catalog_unavailable"]);
    expect(error.retryable).toBe(true);
  });

  it("retains plain transport errors", () => {
    expect(remoteRpcError("connection closed").message).toBe("connection closed");
  });
});
