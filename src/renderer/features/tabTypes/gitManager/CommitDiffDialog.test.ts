import { describe, expect, it } from "vitest";
import { parseCommitPatch } from "./CommitDiffDialog";

describe("parseCommitPatch", () => {
  it("separates files and reports unchanged lines between edit regions", () => {
    const files = parseCommitPatch(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 import React from "react";
-old title
+new title
 line 3
 line 4
@@ -20,2 +20,3 @@ function footer() {
 context
-old footer
+new footer
+another line
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-old
+new
`);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "src/app.ts", added: 3, removed: 2 });
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[1].skippedBefore).toBe(15);
    expect(files[0].hunks[0].lines[1]).toMatchObject({
      type: "delete",
      oldNumber: 2,
      newNumber: null,
    });
    expect(files[0].hunks[0].lines[2]).toMatchObject({
      type: "add",
      oldNumber: null,
      newNumber: 2,
    });
    expect(files[1]).toMatchObject({ path: "new.txt", added: 1, removed: 1 });
    expect(files[1].metadata).toEqual([
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
    ]);
  });
});
