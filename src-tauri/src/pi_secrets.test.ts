import { describe, expect, it } from "vitest";
import { findSecrets, nextSecretId, redactSecrets } from "./pi_secrets";

describe("Pi secret placeholders", () => {
  it("detects known and labelled credentials without consuming surrounding text", () => {
    const github = `ghp_${"a".repeat(36)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature_value";
    const providerKey = "providercredentialwithoutdigits";
    const found = findSecrets(
      `Deploy with ${github}\nOPENROUTER_API_KEY=${providerKey}\napi_key = "ordinary-looking-secret-123"\n${jwt}`,
    );
    expect(found).toEqual(
      expect.arrayContaining([jwt, github, providerKey, "ordinary-looking-secret-123"]),
    );
  });

  it("does not reuse a placeholder already present in the same message", () => {
    expect(nextSecretId("first [SWATH_SECRET_1], later [SWATH_SECRET_4]")).toBe(5);
  });

  it("redacts every occurrence and leaves ordinary prose alone", () => {
    const replacements = new Map([["secret-value-123456", "[SWATH_SECRET_1]"]]);
    expect(redactSecrets("token=secret-value-123456 then secret-value-123456", replacements)).toBe(
      "token=[SWATH_SECRET_1] then [SWATH_SECRET_1]",
    );
    expect(findSecrets("please fix this ordinary short message [SWATH_SECRET_a1b2c3d4]")).toEqual(
      [],
    );
  });
});
