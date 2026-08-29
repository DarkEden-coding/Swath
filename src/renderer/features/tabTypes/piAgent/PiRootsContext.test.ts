import { describe, expect, it } from "vitest";
import { displayPath, resolveUnderRoots } from "./PiRootsContext";

const roots = ["/work/api", "/work/web", "/work/api/vendor"];

describe("project roots", () => {
  it("resolves a file against the folder that owns it", () => {
    expect(resolveUnderRoots(roots, "/work/api/src/main.rs")).toEqual({
      root: "/work/api",
      relative: "src/main.rs",
    });
    expect(resolveUnderRoots(roots, "/work/web/index.ts")).toEqual({
      root: "/work/web",
      relative: "index.ts",
    });
  });

  it("prefers the most specific folder when one is nested in another", () => {
    expect(resolveUnderRoots(roots, "/work/api/vendor/lib.rs")).toEqual({
      root: "/work/api/vendor",
      relative: "lib.rs",
    });
  });

  it("treats a relative path as belonging to the working directory", () => {
    expect(resolveUnderRoots(roots, "src/main.rs")).toEqual({
      root: "/work/api",
      relative: "src/main.rs",
    });
  });

  it("refuses a file outside every folder of the project", () => {
    expect(resolveUnderRoots(roots, "/etc/passwd")).toBeNull();
  });

  it("names a sibling folder's file by its folder so look-alikes stay apart", () => {
    expect(displayPath(roots, "/work/api/src/index.ts")).toBe("src/index.ts");
    expect(displayPath(roots, "/work/web/src/index.ts")).toBe("web/src/index.ts");
  });
});
