import { describe, expect, it } from "vitest";
import { websiteAddressFrom } from "./websiteAddress";

describe("websiteAddressFrom", () => {
  it("accepts HTTPS, localhost HTTP, and local HTML files only", () => {
    expect(websiteAddressFrom("https://example.com/docs")?.url).toBe("https://example.com/docs");
    expect(websiteAddressFrom("localhost:3000")?.url).toBe("http://localhost:3000/");
    expect(websiteAddressFrom("http://localhost:3000")?.url).toBe("http://localhost:3000/");
    expect(websiteAddressFrom("/tmp/demo.html")?.url).toBe("file:///tmp/demo.html");
    expect(websiteAddressFrom("http://example.com")).toBeNull();
    expect(websiteAddressFrom("file:///tmp/demo.txt")).toBeNull();
  });
});
