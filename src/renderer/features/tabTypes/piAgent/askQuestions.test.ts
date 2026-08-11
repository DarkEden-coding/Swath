import { describe, expect, it } from "vitest";
import { parseAskQuestionsTitle, serializeAskAnswers, SWATH_ASK_PREFIX } from "./askQuestions";

function title(payload: unknown): string {
  return SWATH_ASK_PREFIX + JSON.stringify(payload);
}

describe("parseAskQuestionsTitle", () => {
  it("ignores ordinary dialog titles", () => {
    expect(parseAskQuestionsTitle(undefined)).toBeNull();
    expect(parseAskQuestionsTitle("Pick a model")).toBeNull();
  });

  it("parses questions with and without images", () => {
    const parsed = parseAskQuestionsTitle(
      title({
        questions: [
          { question: "Which layout?", options: ["Grid", "List"], images: ["a.png", "b.png"] },
          { question: "Ship it?", options: ["Yes", "No"] },
        ],
      }),
    );

    expect(parsed).toEqual([
      { question: "Which layout?", options: ["Grid", "List"], images: ["a.png", "b.png"] },
      { question: "Ship it?", options: ["Yes", "No"] },
    ]);
  });

  it("omits an empty images array rather than keeping it", () => {
    const parsed = parseAskQuestionsTitle(
      title({ questions: [{ question: "Q", options: ["A"], images: [] }] }),
    );
    expect(parsed?.[0]).not.toHaveProperty("images");
  });

  it("falls back to null on malformed payloads", () => {
    expect(parseAskQuestionsTitle(`${SWATH_ASK_PREFIX}not json`)).toBeNull();
    expect(parseAskQuestionsTitle(title({ questions: [] }))).toBeNull();
    expect(parseAskQuestionsTitle(title({ questions: [{ options: ["A"] }] }))).toBeNull();
    expect(
      parseAskQuestionsTitle(title({ questions: [{ question: "Q", options: [1] }] })),
    ).toBeNull();
  });
});

describe("serializeAskAnswers", () => {
  it("round-trips through the extension's parser shape", () => {
    const json = serializeAskAnswers({
      answers: [{ question: "Q", answer: "A", type: "option", optionIndex: 0 }],
      cancelled: false,
    });
    expect(JSON.parse(json)).toEqual({
      answers: [{ question: "Q", answer: "A", type: "option", optionIndex: 0 }],
      cancelled: false,
    });
  });
});
