/**
 * Markdown rendering for assistant messages.
 *
 * Walks marked's token tree straight to React elements rather than generating HTML, so no
 * `dangerouslySetInnerHTML` and no sanitizer are involved: model output is never treated as markup.
 */

import { Highlight, themes } from "prism-react-renderer";
import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

/** Languages worth highlighting; anything else renders as plain monospace. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  rust: "rust",
  py: "python",
  python: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  html: "markup",
  sql: "sql",
  go: "go",
  diff: "diff",
};

export function CodeBlock({ code, lang }: { code: string; lang?: string }): JSX.Element {
  const language = LANGUAGE_ALIASES[(lang ?? "").toLowerCase()] ?? "";

  if (!language) {
    return (
      <pre className="my-2 overflow-x-auto rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] p-2 font-mono text-[12px] text-[var(--pi-text)]">
        {code}
      </pre>
    );
  }

  return (
    <Highlight theme={themes.vsDark} code={code.replace(/\n$/, "")} language={language}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="my-2 overflow-x-auto rounded border border-[var(--pi-border)] bg-[var(--pi-surface)] p-2 font-mono text-[12px]">
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, j) => (
                <span key={j} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

/** Renders inline tokens (emphasis, code spans, links, …). */
function renderInline(tokens: Token[] | undefined, keyPrefix: string): ReactNode {
  if (!tokens) return null;
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline((token as Tokens.Strong).tokens, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline((token as Tokens.Em).tokens, key)}</em>;
      case "del":
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, key)}</del>;
      case "codespan":
        return (
          <code
            key={key}
            className="rounded bg-[var(--pi-surface)] px-1 font-mono text-[12px] text-[var(--pi-purple)]"
          >
            {(token as Tokens.Codespan).text}
          </code>
        );
      case "link": {
        const link = token as Tokens.Link;
        return (
          <button
            key={key}
            type="button"
            className="text-[var(--pi-cyan)] underline"
            onClick={() => void window.swath.browser.openExternal(link.href)}
          >
            {renderInline(link.tokens, key) ?? link.href}
          </button>
        );
      }
      case "br":
        return <br key={key} />;
      case "escape":
        return <span key={key}>{(token as Tokens.Escape).text}</span>;
      default:
        return <span key={key}>{"text" in token ? (token.text as string) : ""}</span>;
    }
  });
}

function renderBlocks(tokens: Token[], keyPrefix: string): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "paragraph":
        return (
          <p key={key} className="my-1.5 leading-relaxed">
            {renderInline((token as Tokens.Paragraph).tokens, key)}
          </p>
        );

      case "heading": {
        const heading = token as Tokens.Heading;
        return (
          <div
            key={key}
            className={`mt-3 mb-1 font-semibold ${heading.depth <= 2 ? "text-[15px]" : "text-[13px]"}`}
          >
            {renderInline(heading.tokens, key)}
          </div>
        );
      }

      case "code": {
        const code = token as Tokens.Code;
        return <CodeBlock key={key} code={code.text} lang={code.lang} />;
      }

      case "blockquote":
        return (
          <blockquote
            key={key}
            className="my-2 border-l-2 border-[var(--pi-purple)] pl-3 text-[var(--pi-muted)]"
          >
            {renderBlocks((token as Tokens.Blockquote).tokens, key)}
          </blockquote>
        );

      case "list": {
        const list = token as Tokens.List;
        const Tag = list.ordered ? "ol" : "ul";
        return (
          <Tag
            key={key}
            className={`my-1.5 pl-5 ${list.ordered ? "list-decimal" : "list-disc"}`}
            start={list.ordered && typeof list.start === "number" ? list.start : undefined}
          >
            {list.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="my-0.5">
                {renderBlocks(item.tokens, `${key}-${itemIndex}`)}
              </li>
            ))}
          </Tag>
        );
      }

      case "table": {
        const table = token as Tokens.Table;
        return (
          <div key={key} className="my-2 overflow-x-auto">
            <table className="border-collapse text-[12px]">
              <thead>
                <tr>
                  {table.header.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      className="border border-[var(--pi-border)] px-2 py-1 text-left font-semibold"
                    >
                      {renderInline(cell.tokens, `${key}-h-${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border border-[var(--pi-border)] px-2 py-1">
                        {renderInline(cell.tokens, `${key}-${rowIndex}-${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      case "hr":
        return <hr key={key} className="my-3 border-[var(--pi-border)]" />;

      case "space":
        return null;

      case "text": {
        const text = token as Tokens.Text;
        return <span key={key}>{text.tokens ? renderInline(text.tokens, key) : text.text}</span>;
      }

      // Raw HTML in model output is shown as text, never parsed as markup.
      case "html":
        return (
          <span key={key} className="whitespace-pre-wrap">
            {(token as Tokens.HTML).raw}
          </span>
        );

      default:
        return (
          <span key={key} className="whitespace-pre-wrap">
            {"raw" in token ? (token.raw as string) : ""}
          </span>
        );
    }
  });
}

/** Renders a markdown string as React elements. */
export function Markdown({ text }: { text: string }): JSX.Element {
  const tokens = marked.lexer(text);
  return <div className="text-[13px] text-[var(--pi-text)]">{renderBlocks(tokens, "md")}</div>;
}
