/**
 * Rich renderer for `ask_user_questions` prompts (see `askQuestions.ts` for the protocol).
 *
 * Shows one question at a time but keeps the whole set navigable: ←/→ or the numbered pills
 * move between questions, so an earlier answer can be revised before anything is sent. The last
 * step is a review page — nothing reaches the agent until it is submitted from there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isLoadedAskImage,
  parseAskImagesResponse,
  type AskImage,
} from "../../../../shared/ipc/askImages";
import { serializeAskAnswers, type AskAnswer, type AskQuestion } from "./askQuestions";

interface AskQuestionsDialogProps {
  questions: AskQuestion[];
  /** Stable pane/dialog identifier used to retain drafts while its tab is unmounted. */
  cacheKey: string;
  /** Workspace directory used to resolve relative image paths. */
  cwd: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

interface AskQuestionsDraft {
  index: number;
  answers: (AskAnswer | undefined)[];
  customDrafts: Record<number, string>;
}

const CUSTOM_OPTION = "Custom response…";
const draftCache = new Map<string, AskQuestionsDraft>();

export function AskQuestionsDialog({
  questions,
  cacheKey,
  cwd,
  onSubmit,
  onCancel,
}: AskQuestionsDialogProps): JSX.Element {
  // `index === questions.length` is the review page.
  const reviewIndex = questions.length;
  const cached = draftCache.get(cacheKey);
  const [index, setIndex] = useState(cached?.index ?? 0);
  const [answers, setAnswers] = useState<(AskAnswer | undefined)[]>(
    () => cached?.answers ?? Array.from({ length: questions.length }, () => undefined),
  );
  const [customDrafts, setCustomDrafts] = useState<Record<number, string>>(
    cached?.customDrafts ?? {},
  );
  const [images, setImages] = useState<Record<string, AskImage>>({});
  const [zoomed, setZoomed] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const allImagePaths = useMemo(
    () => [...new Set(questions.flatMap((question) => question.images ?? []))],
    [questions],
  );

  // One batch round-trip for every attached image in the set, resolved before the user
  // navigates rather than per question, so moving between questions never stalls.
  useEffect(() => {
    if (allImagePaths.length === 0) return;
    let cancelled = false;

    void window.swath.askImages
      .load({ paths: allImagePaths, cwd })
      .then((raw) => {
        if (cancelled) return;
        const loaded = parseAskImagesResponse(raw);
        if (!loaded) return;
        setImages(
          Object.fromEntries(loaded.map((image, i) => [allImagePaths[i] ?? image.path, image])),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setImages(
          Object.fromEntries(allImagePaths.map((path) => [path, { path, error: message }])),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [allImagePaths, cwd]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    draftCache.set(cacheKey, { index, answers, customDrafts });
  }, [answers, cacheKey, customDrafts, index]);

  const answered = answers.filter(Boolean).length;

  // Returning zero answers tells the agent nothing; Cancel is the way to decline.
  const canSubmit = answered > 0;

  const submit = useCallback(() => {
    if (answered === 0) return;
    draftCache.delete(cacheKey);
    onSubmit(
      serializeAskAnswers({
        answers: answers.filter((answer): answer is AskAnswer => answer !== undefined),
        cancelled: false,
      }),
    );
  }, [answered, answers, cacheKey, onSubmit]);

  const cancel = useCallback(() => {
    draftCache.delete(cacheKey);
    onCancel();
  }, [cacheKey, onCancel]);

  const setAnswer = useCallback((at: number, answer: AskAnswer | undefined) => {
    setAnswers((current) => {
      const next = [...current];
      next[at] = answer;
      return next;
    });
  }, []);

  /** Records an option pick and advances; the review page is the final stop. */
  const chooseOption = useCallback(
    (at: number, optionIndex: number) => {
      const question = questions[at];
      if (!question) return;
      setAnswer(at, {
        question: question.question,
        answer: question.options[optionIndex] ?? "",
        type: "option",
        optionIndex,
      });
      setIndex(Math.min(reviewIndex, at + 1));
    },
    [questions, reviewIndex, setAnswer],
  );

  const commitCustom = useCallback(
    (at: number) => {
      const question = questions[at];
      if (!question) return;
      const existing = answers[at]?.type === "custom" ? answers[at].answer : "";
      const draft = (customDrafts[at] ?? existing).trim();
      if (!draft) return;
      setAnswer(at, { question: question.question, answer: draft, type: "custom" });
      setIndex(Math.min(reviewIndex, at + 1));
    },
    [answers, customDrafts, questions, reviewIndex, setAnswer],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (zoomed) setZoomed(null);
        else cancel();
        return;
      }
      // Arrow keys belong to the caret while a custom answer is being typed.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((value) => Math.min(reviewIndex, value + 1));
      } else if (event.key === "Enter" && index === reviewIndex) {
        event.preventDefault();
        submit();
      }
    },
    [cancel, index, reviewIndex, submit, zoomed],
  );

  const current = questions[index];

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 p-4">
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-[92%] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded border border-[var(--pi-purple)] bg-[var(--pi-page)] font-mono outline-none"
      >
        <QuestionNav
          count={questions.length}
          index={index}
          reviewIndex={reviewIndex}
          answers={answers}
          onSelect={setIndex}
        />

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {index === reviewIndex || !current ? (
            <ReviewPage questions={questions} answers={answers} onEdit={setIndex} />
          ) : (
            <QuestionPage
              question={current}
              index={index}
              images={images}
              answer={answers[index]}
              customDraft={customDrafts[index]}
              onCustomDraft={(text) => setCustomDrafts((drafts) => ({ ...drafts, [index]: text }))}
              onChooseOption={(optionIndex) => chooseOption(index, optionIndex)}
              onCommitCustom={() => commitCustom(index)}
              onZoom={setZoomed}
            />
          )}
        </div>

        <Footer
          index={index}
          reviewIndex={reviewIndex}
          answered={answered}
          total={questions.length}
          canSubmit={canSubmit}
          onBack={() => setIndex((value) => Math.max(0, value - 1))}
          onNext={() => setIndex((value) => Math.min(reviewIndex, value + 1))}
          onSubmit={submit}
          onCancel={cancel}
        />
      </div>

      {zoomed ? <Lightbox src={zoomed} onClose={() => setZoomed(null)} /> : null}
    </div>
  );
}

function QuestionNav({
  count,
  index,
  reviewIndex,
  answers,
  onSelect,
}: {
  count: number;
  index: number;
  reviewIndex: number;
  answers: (AskAnswer | undefined)[];
  onSelect: (index: number) => void;
}): JSX.Element {
  return (
    <div className="max-h-24 shrink-0 overflow-auto border-b border-[var(--pi-border)] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {Array.from({ length: count }, (_, i) => {
          const isCurrent = i === index;
          const isAnswered = Boolean(answers[i]);
          return (
            <button
              key={i}
              type="button"
              title={answers[i]?.answer ?? "Unanswered"}
              onClick={() => onSelect(i)}
              className={`h-6 min-w-6 rounded border px-1.5 text-[11px] ${
                isCurrent
                  ? "border-[var(--pi-purple)] bg-[#172235] text-[var(--pi-text)]"
                  : isAnswered
                    ? "border-swath-good/60 text-swath-good"
                    : "border-[var(--pi-border)] text-swath-muted"
              }`}
            >
              {isAnswered && !isCurrent ? "✓" : i + 1}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSelect(reviewIndex)}
          className={`ml-1 h-6 rounded border px-2 text-[11px] ${
            index === reviewIndex
              ? "border-[var(--pi-purple)] bg-[#172235] text-[var(--pi-text)]"
              : "border-[var(--pi-border)] text-swath-muted"
          }`}
        >
          Review
        </button>
      </div>
    </div>
  );
}

function QuestionPage({
  question,
  index,
  images,
  answer,
  customDraft,
  onCustomDraft,
  onChooseOption,
  onCommitCustom,
  onZoom,
}: {
  question: AskQuestion;
  index: number;
  images: Record<string, AskImage>;
  answer: AskAnswer | undefined;
  customDraft: string | undefined;
  onCustomDraft: (text: string) => void;
  onChooseOption: (optionIndex: number) => void;
  onCommitCustom: () => void;
  onZoom: (src: string) => void;
}): JSX.Element {
  const [customOpen, setCustomOpen] = useState(
    answer?.type === "custom" || customDraft !== undefined,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attached = question.images ?? [];

  useEffect(() => {
    const onMenuPaste = (): void => {
      const textarea = textareaRef.current;
      if (!textarea || document.activeElement !== textarea) return;
      void window.swath.clipboard.readForTerminal().then((payload) => {
        if (!payload.text) return;
        const value = customDraft ?? (answer?.type === "custom" ? answer.answer : "");
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        onCustomDraft(value.slice(0, start) + payload.text + value.slice(end));
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + payload.text.length;
        });
      });
    };
    window.addEventListener("swath:terminal-paste", onMenuPaste);
    return () => window.removeEventListener("swath:terminal-paste", onMenuPaste);
  }, [answer, customDraft, onCustomDraft]);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[13px] leading-relaxed text-[var(--pi-text)]">{question.question}</div>

      {attached.length > 0 ? (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fit, minmax(${attached.length === 1 ? 320 : 220}px, 1fr))`,
          }}
        >
          {attached.map((path) => (
            <ImageTile key={path} path={path} image={images[path]} onZoom={onZoom} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {question.options.map((option, optionIndex) => {
          const selected = answer?.type === "option" && answer.optionIndex === optionIndex;
          return (
            <button
              key={`${index}-${optionIndex}`}
              type="button"
              onClick={() => onChooseOption(optionIndex)}
              className={`rounded border px-3 py-2 text-left text-[12px] ${
                selected
                  ? "border-swath-good bg-[#12281a] text-[var(--pi-text)]"
                  : "border-[var(--pi-border)] text-[var(--pi-text)] hover:border-[var(--pi-purple)]"
              }`}
            >
              <span className="mr-2 text-swath-muted">{optionIndex + 1}.</span>
              {option}
              {selected ? <span className="ml-2 text-swath-good">✓</span> : null}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setCustomOpen(true)}
          className={`rounded border px-3 py-2 text-left text-[12px] ${
            answer?.type === "custom"
              ? "border-swath-good bg-[#12281a] text-[var(--pi-text)]"
              : "border-[var(--pi-border)] text-swath-muted hover:border-[var(--pi-purple)]"
          }`}
        >
          {CUSTOM_OPTION}
          {answer?.type === "custom" ? <span className="ml-2 text-swath-good">✓</span> : null}
        </button>
      </div>

      {customOpen ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            autoFocus
            value={customDraft ?? (answer?.type === "custom" ? answer.answer : "")}
            placeholder="Type your answer, then Ctrl+Enter"
            onChange={(event) => onCustomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onCommitCustom();
              }
            }}
            className="h-24 w-full resize-none rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] p-2 text-[12px] text-[var(--pi-text)] outline-none focus:border-[var(--pi-purple)]"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onCommitCustom}
              className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1 text-[12px] text-swath-text"
            >
              Save answer
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImageTile({
  path,
  image,
  onZoom,
}: {
  path: string;
  image: AskImage | undefined;
  onZoom: (src: string) => void;
}): JSX.Element {
  if (!image) {
    return (
      <div className="grid h-48 place-items-center rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] text-[11px] text-swath-muted">
        Loading…
      </div>
    );
  }
  if (!isLoadedAskImage(image)) {
    return (
      <div className="flex h-48 flex-col justify-center gap-1 rounded border border-swath-bad/50 bg-[var(--pi-surface)] p-3 text-[11px]">
        <div className="truncate text-swath-muted" title={path}>
          {path}
        </div>
        <div className="text-swath-bad">{image.error}</div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onZoom(image.dataUrl)}
      title={`${image.title} — click to enlarge`}
      className="flex flex-col overflow-hidden rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] hover:border-[var(--pi-purple)]"
    >
      <img
        src={image.dataUrl}
        alt={image.title}
        className="h-48 w-full bg-black/30 object-contain"
      />
      <span className="truncate px-2 py-1 text-[11px] text-swath-muted">{image.title}</span>
    </button>
  );
}

function ReviewPage({
  questions,
  answers,
  onEdit,
}: {
  questions: AskQuestion[];
  answers: (AskAnswer | undefined)[];
  onEdit: (index: number) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-[var(--pi-blue)]">Review your answers</div>
      {questions.map((question, i) => {
        const answer = answers[i];
        return (
          <button
            key={i}
            type="button"
            onClick={() => onEdit(i)}
            className="rounded border border-[var(--pi-border)] p-3 text-left hover:border-[var(--pi-purple)]"
          >
            <div className="text-[12px] text-swath-muted">
              {i + 1}. {question.question}
            </div>
            <div className={`mt-1 text-[12px] ${answer ? "text-swath-good" : "text-swath-bad"}`}>
              {answer ? answer.answer : "Unanswered — click to answer"}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Footer({
  index,
  reviewIndex,
  answered,
  total,
  canSubmit,
  onBack,
  onNext,
  onSubmit,
  onCancel,
}: {
  index: number;
  reviewIndex: number;
  answered: number;
  total: number;
  canSubmit: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 border-t border-[var(--pi-border)] px-4 py-2.5">
      <div className="text-[11px] text-swath-muted">
        {answered}/{total} answered · ←→ to move between questions
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-swath-border px-3 py-1 text-[12px] text-swath-muted hover:text-swath-text"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={index === 0}
          onClick={onBack}
          className="rounded border border-swath-border px-3 py-1 text-[12px] text-swath-muted disabled:opacity-40 hover:text-swath-text"
        >
          ← Back
        </button>
        {index === reviewIndex ? (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={onSubmit}
            className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1 text-[12px] text-swath-text disabled:opacity-40"
          >
            Submit
          </button>
        ) : (
          <button
            type="button"
            onClick={onNext}
            className="rounded border border-swath-accent bg-[#1f2a37] px-3 py-1 text-[12px] text-swath-text"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-30 grid cursor-zoom-out place-items-center bg-black/85 p-6"
      onClick={onClose}
    >
      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
    </div>
  );
}
