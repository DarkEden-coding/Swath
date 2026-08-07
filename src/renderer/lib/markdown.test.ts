import { Prism } from "prism-react-renderer";
import { describe, expect, it } from "vitest";
import { highlightLanguage } from "./markdown";

/**
 * `Highlight` throws from inside `Prism.tokenize` for a grammar it does not bundle, and a throw
 * during render blanks the whole app — so every name this returns must actually exist.
 */
describe("highlightLanguage", () => {
  it("never returns a grammar prism-react-renderer lacks", () => {
    for (const name of ["bash", "sh", "zsh", "shell", "toml", "diff"]) {
      expect(highlightLanguage(name)).toBe("");
    }
  });

  it("still highlights the bundled languages", () => {
    expect(highlightLanguage("ts")).toBe("typescript");
    expect(highlightLanguage("rs")).toBe("rust");
    expect(highlightLanguage("PY")).toBe("python");
    expect(highlightLanguage(undefined)).toBe("");
    expect(highlightLanguage("nonsense")).toBe("");
  });

  it("matches what Prism can actually tokenize", () => {
    expect(() => Prism.tokenize("a = 1", Prism.languages.toml)).toThrow();
    expect(() => Prism.tokenize("a = 1", Prism.languages.python)).not.toThrow();
  });
});
