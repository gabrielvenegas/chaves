import chalk from "chalk";
import { logger } from "../logger.js";

/**
 * Render markdown to ANSI-styled terminal output.
 * Handles the subset of markdown that AI responses typically produce:
 * headers, bold, italic, inline code, code blocks, and bullet/numbered lists.
 */
function markdownToAnsi(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];

  function flushCodeBlock() {
    const header = codeBlockLang
      ? chalk.gray(`--- ${codeBlockLang} ---`)
      : chalk.gray("---");
    out.push(header);
    for (const cl of codeLines) {
      out.push(`  ${chalk.yellow(cl)}`);
    }
    out.push(chalk.gray("---"));
    codeLines = [];
    codeBlockLang = "";
  }

  for (const line of lines) {
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

    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const text = renderInline(headerMatch[2]!);
      if (level === 1) {
        out.push(chalk.bold.cyan(text));
      } else if (level === 2) {
        out.push(chalk.bold(text));
      } else {
        out.push(chalk.bold.gray(text));
      }
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push(chalk.gray("────────────────────"));
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = " ".repeat(ulMatch[1]!.length);
      out.push(`${indent}${chalk.cyan("•")} ${renderInline(ulMatch[2]!)}`);
      continue;
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = " ".repeat(olMatch[1]!.length);
      out.push(`${indent}${chalk.cyan(`${olMatch[2]}.`)} ${renderInline(olMatch[3]!)}`);
      continue;
    }

    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      out.push(`${chalk.gray("│")} ${renderInline(bqMatch[1]!)}`);
      continue;
    }

    out.push(line.trim() === "" ? "" : renderInline(line));
  }

  if (inCodeBlock) flushCodeBlock();

  return out.join("\n");
}

/**
 * Render inline markdown elements (bold, italic, code, links) to ANSI styles.
 */
function renderInline(text: string): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "`" && text[i + 1] !== "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        result += chalk.yellow(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    if (text.slice(i, i + 3) === "***") {
      const end = text.indexOf("***", i + 3);
      if (end !== -1) {
        result += chalk.bold.underline(renderInline(text.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
    }

    if (text.slice(i, i + 2) === "**" || text.slice(i, i + 2) === "__") {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end !== -1) {
        result += chalk.bold(renderInline(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    if ((text[i] === "*" || text[i] === "_") && text[i + 1] !== text[i]) {
      const marker = text[i]!;
      const end = text.indexOf(marker, i + 1);
      if (end !== -1 && text[end - 1] !== marker) {
        result += chalk.underline(renderInline(text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          result += chalk.cyan(renderInline(text.slice(i + 1, closeBracket)));
          i = closeParen + 1;
          continue;
        }
      }
    }

    result += text[i]!;
    i++;
  }

  return result;
}

export class MarkdownRenderer {
  constructor() {
    logger.debug("MARKDOWN", "Markdown renderer initialized (ANSI terminal)");
  }

  async render(markdown: string): Promise<string> {
    logger.debug("MARKDOWN", "Rendering markdown to ANSI terminal output");
    try {
      return markdownToAnsi(markdown);
    } catch (error) {
      logger.error("MARKDOWN", "Markdown render failed, returning plain text:", error);
      return markdown;
    }
  }
}
