import { logger } from "../logger.js";

// Escape blessed's tag syntax in literal text so it doesn't get interpreted
function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/**
 * Render markdown to blessed tag markup.
 * Handles the subset of markdown that AI responses typically produce:
 * headers, bold, italic, inline code, code blocks, and bullet/numbered lists.
 */
function markdownToBlessedTags(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];

  function flushCodeBlock() {
    const header = codeBlockLang
      ? `{gray-fg}--- ${escapeBlessedTags(codeBlockLang)} ---{/gray-fg}`
      : `{gray-fg}---{/gray-fg}`;
    out.push(header);
    for (const cl of codeLines) {
      out.push(`  {yellow-fg}${escapeBlessedTags(cl)}{/yellow-fg}`);
    }
    out.push(`{gray-fg}---{/gray-fg}`);
    codeLines = [];
    codeBlockLang = "";
  }

  for (const line of lines) {
    // Fenced code block toggle
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // ATX headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const text = renderInline(headerMatch[2]!);
      if (level === 1) {
        out.push(`{bold}{cyan-fg}${text}{/cyan-fg}{/bold}`);
      } else if (level === 2) {
        out.push(`{bold}${text}{/bold}`);
      } else {
        out.push(`{bold}{gray-fg}${text}{/gray-fg}{/bold}`);
      }
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push("{gray-fg}────────────────────{/gray-fg}");
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = " ".repeat(ulMatch[1]!.length);
      out.push(`${indent}{cyan-fg}•{/cyan-fg} ${renderInline(ulMatch[2]!)}`);
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = " ".repeat(olMatch[1]!.length);
      out.push(`${indent}{cyan-fg}${olMatch[2]}.{/cyan-fg} ${renderInline(olMatch[3]!)}`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      out.push(`{gray-fg}│{/gray-fg} ${renderInline(bqMatch[1]!)}`);
      continue;
    }

    // Blank line or regular paragraph text
    out.push(line.trim() === "" ? "" : renderInline(line));
  }

  // Unclosed code block
  if (inCodeBlock) flushCodeBlock();

  return out.join("\n");
}

/**
 * Render inline markdown elements (bold, italic, code, links) to blessed tags.
 * Applied to any text that isn't a block-level element.
 */
function renderInline(text: string): string {
  // We need to process in order and avoid double-processing.
  // Strategy: tokenize into segments of [literal | markup].
  let result = "";
  let i = 0;

  while (i < text.length) {
    // Inline code — highest priority (content inside is literal)
    if (text[i] === "`" && text[i + 1] !== "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        const code = text.slice(i + 1, end);
        result += `{yellow-fg}${escapeBlessedTags(code)}{/yellow-fg}`;
        i = end + 1;
        continue;
      }
    }

    // Bold+italic ***text***
    if (text.slice(i, i + 3) === "***") {
      const end = text.indexOf("***", i + 3);
      if (end !== -1) {
        const inner = renderInline(text.slice(i + 3, end));
        result += `{bold}{underline}${inner}{/underline}{/bold}`;
        i = end + 3;
        continue;
      }
    }

    // Bold **text** or __text__
    if (text.slice(i, i + 2) === "**" || text.slice(i, i + 2) === "__") {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end !== -1) {
        const inner = renderInline(text.slice(i + 2, end));
        result += `{bold}${inner}{/bold}`;
        i = end + 2;
        continue;
      }
    }

    // Italic *text* or _text_
    if ((text[i] === "*" || text[i] === "_") && text[i + 1] !== text[i]) {
      const marker = text[i]!;
      const end = text.indexOf(marker, i + 1);
      if (end !== -1 && text[end - 1] !== marker) {
        const inner = renderInline(text.slice(i + 1, end));
        result += `{underline}${inner}{/underline}`;
        i = end + 1;
        continue;
      }
    }

    // Markdown link [text](url) — show just the text
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = renderInline(text.slice(i + 1, closeBracket));
          result += `{cyan-fg}${linkText}{/cyan-fg}`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Literal character — escape blessed tags
    result += escapeBlessedTags(text[i]!);
    i++;
  }

  return result;
}

export class MarkdownRenderer {
  constructor() {
    logger.debug("MARKDOWN", "Markdown renderer initialized (blessed-tags native)");
  }

  async render(markdown: string): Promise<string> {
    logger.debug("MARKDOWN", "Rendering markdown to blessed tags");
    try {
      return markdownToBlessedTags(markdown);
    } catch (error) {
      logger.error("MARKDOWN", "Markdown render failed, returning escaped plain text:", error);
      return escapeBlessedTags(markdown);
    }
  }
}
