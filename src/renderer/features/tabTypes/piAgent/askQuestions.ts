/**
 * Sentinel protocol for the `ask_user_questions` extension.
 *
 * pi's RPC dialog protocol has no questionnaire method (`ctx.ui.custom` is TUI-only), so the
 * extension smuggles the whole question set through a `select` title prefixed with
 * `SWATH_ASK_V1:`. Swath answers with a JSON `AskAnswersPayload` string; a host that does not
 * understand the prefix picks the single fallback option instead and the extension degrades to
 * asking one question at a time.
 *
 * Keep this in sync with `~/.pi/agent/extensions/user-query.ts`.
 */

export const SWATH_ASK_PREFIX = "SWATH_ASK_V1:";

export interface AskQuestion {
  question: string;
  options: string[];
  /** Optional reference images, shown above the options. */
  images?: string[];
}

export interface AskAnswer {
  question: string;
  answer: string;
  type: "option" | "custom";
  optionIndex?: number;
}

export interface AskAnswersPayload {
  answers: AskAnswer[];
  cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts the question set from a `select` dialog title.
 *
 * Returns null for ordinary dialogs and for malformed payloads alike — in both cases the
 * caller renders the generic dialog, which still lets the user answer.
 */
export function parseAskQuestionsTitle(title: string | undefined): AskQuestion[] | null {
  if (!title || !title.startsWith(SWATH_ASK_PREFIX)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(title.slice(SWATH_ASK_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.questions) || raw.questions.length === 0) return null;

  const questions: AskQuestion[] = [];
  for (const entry of raw.questions) {
    if (!isRecord(entry)) return null;
    if (typeof entry.question !== "string") return null;
    if (!Array.isArray(entry.options)) return null;
    const options = entry.options.filter((option): option is string => typeof option === "string");
    if (options.length !== entry.options.length) return null;

    const images = Array.isArray(entry.images)
      ? entry.images.filter((image): image is string => typeof image === "string")
      : undefined;

    questions.push({
      question: entry.question,
      options,
      ...(images?.length ? { images } : {}),
    });
  }
  return questions;
}

/** Serialises the reply the extension expects back through `extension_ui_response`. */
export function serializeAskAnswers(payload: AskAnswersPayload): string {
  return JSON.stringify(payload);
}
