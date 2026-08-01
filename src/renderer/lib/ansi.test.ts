import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

const ESC = "";

describe("parseAnsi", () => {
  it("returns a single unstyled span for plain text", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello", style: {} }]);
  });

  it("parses the truecolor sequences pi extensions actually emit", () => {
    // Real payload shape from a live `setStatus` request.
    const spans = parseAnsi(`${ESC}[38;2;100;116;139msubagents:5/5${ESC}[39m`);
    expect(spans).toEqual([{ text: "subagents:5/5", style: { color: "rgb(100,116,139)" } }]);
  });

  it("splits mixed styled and unstyled runs", () => {
    const spans = parseAnsi(`${ESC}[38;2;80;137;220mTools:${ESC}[39m 49`);
    expect(spans).toEqual([
      { text: "Tools:", style: { color: "rgb(80,137,220)" } },
      { text: " 49", style: {} },
    ]);
  });

  it("handles basic and bright colors", () => {
    expect(parseAnsi(`${ESC}[31mred${ESC}[0m`)[0].style.color).toBe("#cd3131");
    expect(parseAnsi(`${ESC}[91mbright${ESC}[0m`)[0].style.color).toBe("#f14c4c");
  });

  it("handles 256-color cube and grayscale indexes", () => {
    expect(parseAnsi(`${ESC}[38;5;196mx`)[0].style.color).toBe("rgb(255,0,0)");
    expect(parseAnsi(`${ESC}[38;5;244mx`)[0].style.color).toBe("rgb(128,128,128)");
    expect(parseAnsi(`${ESC}[38;5;9mx`)[0].style.color).toBe("#f14c4c");
  });

  it("applies and resets attributes", () => {
    expect(parseAnsi(`${ESC}[1mbold`)[0].style.fontWeight).toBe("bold");
    expect(parseAnsi(`${ESC}[3mitalic`)[0].style.fontStyle).toBe("italic");
    expect(parseAnsi(`${ESC}[4munder`)[0].style.textDecoration).toBe("underline");

    const reset = parseAnsi(`${ESC}[1;31mstyled${ESC}[0mplain`);
    expect(reset[1].style).toEqual({});
  });

  it("resets a single attribute without clearing the rest", () => {
    const spans = parseAnsi(`${ESC}[1;31mboth${ESC}[22mcolorOnly`);
    expect(spans[1].style).toEqual({ color: "#cd3131" });
  });

  it("treats a bare reset code as full reset", () => {
    const spans = parseAnsi(`${ESC}[31mred${ESC}[mplain`);
    expect(spans[1].style).toEqual({});
  });

  it("parses background colors", () => {
    expect(parseAnsi(`${ESC}[42mx`)[0].style.backgroundColor).toBe("#0dbc79");
    expect(parseAnsi(`${ESC}[48;2;1;2;3mx`)[0].style.backgroundColor).toBe("rgb(1,2,3)");
  });

  it("discards non-SGR CSI sequences instead of rendering them", () => {
    expect(parseAnsi(`${ESC}[2Jcleared`)).toEqual([{ text: "cleared", style: {} }]);
  });

  it("carries style across newlines within one payload", () => {
    const spans = parseAnsi(`${ESC}[31mline1\nline2`);
    expect(spans).toEqual([{ text: "line1\nline2", style: { color: "#cd3131" } }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});
