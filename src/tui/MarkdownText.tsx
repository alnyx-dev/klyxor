import React from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";

interface MarkdownTextProps {
  content: string;
}

/* ── inline token renderer ─────────────────────────────────── */

function renderInlineTokens(
  tokens: Token[],
  keyPrefix: string
): React.ReactNode[] {
  return tokens.map((tok, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (tok.type) {
      case "strong":
        return (
          <Text key={k} bold>
            {renderInlineTokens((tok as Tokens.Strong).tokens, k)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} italic>
            {renderInlineTokens((tok as Tokens.Em).tokens, k)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={k} color="cyan">
            {(tok as Tokens.Codespan).text}
          </Text>
        );
      case "link":
        return (
          <Text key={k} color="blue" underline>
            {renderInlineTokens((tok as Tokens.Link).tokens, k)}
          </Text>
        );
      case "del":
        return (
          <Text key={k} strikethrough>
            {renderInlineTokens((tok as Tokens.Del).tokens, k)}
          </Text>
        );
      case "text":
        return <Text key={k}>{(tok as Tokens.Text).text}</Text>;
      case "escape":
        return <Text key={k}>{(tok as Tokens.Escape).text}</Text>;
      case "br":
        return "\n";
      default:
        return <Text key={k}>{(tok as Tokens.Generic).raw}</Text>;
    }
  });
}

/* ── block token renderer ──────────────────────────────────── */

function renderToken(
  token: Token,
  keyPrefix: string
): React.ReactNode {
  switch (token.type) {
    /* ── headings ──────────────────────────────── */
    case "heading": {
      const h = token as Tokens.Heading;
      const inner = renderInlineTokens(h.tokens, `${keyPrefix}-hd`);
      if (h.depth === 1) {
        return (
          <Box key={keyPrefix} marginTop={1} flexDirection="column">
            <Text bold>{inner}</Text>
            <Text dimColor>{"═".repeat(40)}</Text>
          </Box>
        );
      }
      if (h.depth === 2) {
        return (
          <Box key={keyPrefix} marginTop={1} flexDirection="column">
            <Text bold>{inner}</Text>
          </Box>
        );
      }
      return (
        <Box key={keyPrefix} marginTop={1} flexDirection="column">
          <Text bold>{inner}</Text>
        </Box>
      );
    }

    /* ── code blocks ────────────────────────────── */
    case "code": {
      const c = token as Tokens.Code;
      const lang = c.lang || "text";
      const lines = c.text.split("\n");
      return (
        <Box
          key={keyPrefix}
          marginTop={1}
          marginBottom={1}
          flexDirection="column"
        >
          {lang !== "text" && (
            <Text dimColor>{lang}</Text>
          )}
          {lines.map((line, li) => (
            <Text key={`${keyPrefix}-cl-${li}`} color="cyan">
              {line || " "}
            </Text>
          ))}
        </Box>
      );
    }

    /* ── paragraphs ─────────────────────────────── */
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return (
        <Text key={keyPrefix}>{renderInlineTokens(p.tokens, `${keyPrefix}-p`)}</Text>
      );
    }

    /* ── blockquotes ────────────────────────────── */
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      const lines = bq.text.split("\n");
      return (
        <Box key={keyPrefix} flexDirection="column">
          {lines.map((line, li) => (
            <Text key={`${keyPrefix}-bq-${li}`}>
              <Text dimColor>{"│ "}</Text>
              <Text italic>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }

    /* ── lists ──────────────────────────────────── */
    case "list": {
      const lst = token as Tokens.List;
      return (
        <Box key={keyPrefix} flexDirection="column">
          {lst.items.map((item, ii) => {
            const bullet = lst.ordered
              ? `${(lst.start || 1) + ii}. `
              : "- ";
            return (
              <Box key={`${keyPrefix}-li-${ii}`}>
                <Text>
                  {bullet}
                </Text>
                <Text>
                  {renderInlineTokens(
                    item.tokens,
                    `${keyPrefix}-lit-${ii}`
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      );
    }

    /* ── horizontal rule ────────────────────────── */
    case "hr":
      return (
        <Box key={keyPrefix} marginTop={1} marginBottom={1}>
          <Text dimColor>
            {"─".repeat(50)}
          </Text>
        </Box>
      );

    /* ── html passthrough ───────────────────────── */
    case "html":
      return null;

    /* ── space / ignored ────────────────────────── */
    case "space":
      return null;

    default:
      return null;
  }
}

/* ── component ─────────────────────────────────────────────── */

export const MarkdownText = React.memo(function MarkdownText({
  content,
}: MarkdownTextProps) {
  const tokens = React.useMemo(() => marked.lexer(content), [content]);

  const elements = tokens
    .map((tok, i) => renderToken(tok, `md-${i}`))
    .filter(Boolean);

  return <Box flexDirection="column">{elements}</Box>;
});
