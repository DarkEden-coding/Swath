import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FIVE_MINUTES = 5 * 60 * 1000;
const PLACEHOLDER_PREFIX = "SWATH_SECRET";
const PLACEHOLDER_PATTERN = /\[SWATH_SECRET_[A-Za-z0-9]+\]/g;

interface StoredSecret {
  value?: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const KNOWN_SECRET_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:(?:proj|or-v1|ant-api\d{2})-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];
const LABELED_SECRET_PATTERN =
  /\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|credential)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})["']?/gi;
const GENERIC_TOKEN_PATTERN =
  /\b(?:[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})+|[A-Za-z0-9_-]{24,})\b/g;

/** Finds common token formats, labelled credentials, and long mixed letter-number tokens. */
export function findSecrets(text: string): string[] {
  const scannable = text.replace(PLACEHOLDER_PATTERN, "");
  const found = new Set<string>();
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of scannable.matchAll(pattern)) found.add(match[0]);
  }
  LABELED_SECRET_PATTERN.lastIndex = 0;
  for (const match of scannable.matchAll(LABELED_SECRET_PATTERN)) found.add(match[1]);
  GENERIC_TOKEN_PATTERN.lastIndex = 0;
  for (const match of scannable.matchAll(GENERIC_TOKEN_PATTERN)) {
    if (/[A-Za-z]/.test(match[0]) && /\d/.test(match[0])) found.add(match[0]);
  }
  return [...found].sort((left, right) => right.length - left.length);
}

/** Returns the first unused numeric placeholder after those already present in text. */
export function nextSecretId(text: string, current = 1): number {
  for (const match of text.matchAll(/\[SWATH_SECRET_(\d+)\]/g)) {
    current = Math.max(current, Number(match[1]) + 1);
  }
  return current;
}

/** Replaces every exact secret occurrence with its assigned placeholder. */
export function redactSecrets(text: string, replacements: ReadonlyMap<string, string>): string {
  let redacted = text;
  for (const [secret, placeholder] of replacements) {
    redacted = redacted.split(secret).join(placeholder);
  }
  return redacted;
}

/** Keeps pasted credentials out of Pi's model context and expands them only for bash execution. */
export default function secretPlaceholders(pi: ExtensionAPI): void {
  const secrets = new Map<string, StoredSecret>();
  let nextId = 1;

  /** Keeps generated labels above placeholders already present in the message or session. */
  const reservePlaceholderIds = (text: string): void => {
    nextId = nextSecretId(text, nextId);
  };

  pi.on("session_start", (_event, ctx) => {
    reservePlaceholderIds(JSON.stringify(ctx.sessionManager.getEntries()));
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    reservePlaceholderIds(event.text);
    const detected = findSecrets(event.text);
    if (detected.length === 0) return;

    const replacements = new Map<string, string>();
    for (const value of detected) {
      const existing = [...secrets].find(([, secret]) => secret.value === value)?.[0];
      const placeholder = existing ?? `[${PLACEHOLDER_PREFIX}_${nextId++}]`;
      const previous = secrets.get(placeholder);
      if (previous) clearTimeout(previous.timer);
      const stored: StoredSecret = {
        value,
        expiresAt: Date.now() + FIVE_MINUTES,
        timer: setTimeout(() => {
          stored.value = undefined;
        }, FIVE_MINUTES),
      };
      secrets.set(placeholder, stored);
      replacements.set(value, placeholder);
    }
    ctx.ui.notify(
      `Protected ${detected.length} secret${detected.length === 1 ? "" : "s"} for 5 minutes`,
      "info",
    );
    return { action: "transform" as const, text: redactSecrets(event.text, replacements) };
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      `\n\nSwath may replace credentials with placeholders such as [${PLACEHOLDER_PREFIX}_1]. Use the placeholder verbatim in a bash command when the credential is needed. Never ask the user to reveal its value. Placeholders expire after five minutes; if a bash call reports expiry, ask the user to paste the credential again.`,
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") return;

    const placeholders = [...new Set(input.command.match(PLACEHOLDER_PATTERN) ?? [])];
    if (placeholders.length === 0) return;
    const now = Date.now();
    for (const placeholder of placeholders) {
      const secret = secrets.get(placeholder);
      if (!secret || !secret.value || secret.expiresAt <= now) {
        if (secret) secret.value = undefined;
        return {
          block: true,
          reason: `${placeholder} has expired. Ask the user to paste the credential again.`,
        };
      }
      input.command = input.command.split(placeholder).join(secret.value);
    }
  });

  pi.on("session_shutdown", () => {
    for (const secret of secrets.values()) clearTimeout(secret.timer);
    secrets.clear();
  });
}
