import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import { logger } from "../logger.js";

// Build the terminal renderer extension
const termExt = markedTerminal({ reflowText: true, width: 80 }) as any;

// Patch the `text` renderer in-place before registering with marked.
// marked-terminal's default text() extracts token.text (raw markdown source)
// instead of calling parseInline(token.tokens), so inline elements like
// **bold**, _italic_, and `code` inside list items are never rendered.
const originalText = termExt.renderer.text;
termExt.renderer.text = function (token: any): string {
  if (token && Array.isArray(token.tokens) && token.tokens.length > 0) {
    return (this as any).parser.parseInline(token.tokens);
  }
  // Fall back to marked-terminal's own implementation for simple text nodes
  return originalText.call(this, token);
};

marked.use(termExt);

export class MarkdownRenderer {
  constructor() {
    logger.debug(
      "MARKDOWN",
      "Markdown renderer initialized (marked + marked-terminal)",
    );
  }

  async render(markdown: string): Promise<string> {
    logger.debug("MARKDOWN", "Rendering markdown");

    try {
      const result = await marked(markdown);
      logger.debug("MARKDOWN", "Markdown rendering completed");
      return result as string;
    } catch (error) {
      logger.error("MARKDOWN", "Failed to render markdown:", error);
      // Graceful fallback: apply basic chalk styling manually
      const plain = markdown
        .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => chalk.bold.green(t))
        .replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
        .replace(/_(.+?)_/g, (_, t) => chalk.italic(t))
        .replace(/`([^`]+)`/g, (_, t) => chalk.yellow(t))
        .replace(/^[-*]\s+/gm, "  • ");
      return plain;
    }
  }

  async renderFile(filePath: string): Promise<string> {
    logger.debug("MARKDOWN", `Rendering markdown file: ${filePath}`);

    const { readFileSync, existsSync } = await import("fs");

    if (!existsSync(filePath)) {
      throw new Error(`Markdown file not found: ${filePath}`);
    }

    const content = readFileSync(filePath, "utf8");
    return this.render(content);
  }
}
