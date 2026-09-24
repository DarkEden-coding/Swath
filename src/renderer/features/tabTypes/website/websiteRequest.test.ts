import { describe, expect, it } from "vitest";
import { websiteTabRequestFrom } from "./websiteRequest";

describe("websiteTabRequestFrom", () => {
  it("only accepts the website extension status payload", () => {
    expect(
      websiteTabRequestFrom({
        type: "extension_ui_request",
        id: "open",
        method: "setStatus",
        statusKey: "swath:open-website:tool-1",
        statusText: JSON.stringify({ url: "https://example.com", title: "Example" }),
      }),
    ).toEqual({ url: "https://example.com", title: "Example" });
    expect(
      websiteTabRequestFrom({
        type: "extension_ui_request",
        id: "clear",
        method: "setStatus",
        statusKey: "swath:open-website:tool-1",
      }),
    ).toBeNull();
  });
});
