import { basename } from "path";
import { logger } from "./logger.js";

export class ShieldParser {
  private readonly blockedFilePatterns = [
    /^\.env/i,
    /\.key$/i,
    /\.pem$/i,
    /secret/i,
    /credentials/i,
    /oauth/i,
  ];

  private readonly apiKeyPatterns = [
    /sk-[A-Za-z0-9]{20,}/g, // OpenAI
    /AKIA[0-9A-Z]{16}/g, // AWS
    /stripe_(test|live)_[A-Za-z0-9]{24,}/gi, // Stripe
    /ghp_[A-Za-z0-9]{36,}/g, // GitHub
    /xoxb-[A-Za-z0-9-]{25,}/g, // Slack
    /mongodb\+srv:\/\/[^\s]+/gi, // MongoDB
    /postgres:\/\/[^\s]+/gi, // PostgreSQL
    /mysql:\/\/[^\s]+/gi, // MySQL
  ];

  isSensitiveFile(filePath: string): boolean {
    const fileName = basename(filePath);
    for (const pattern of this.blockedFilePatterns) {
      if (pattern.test(fileName)) {
        logger.warn("SHIELD", `🔒 Blocked: ${fileName}`);
        return true;
      }
    }
    return false;
  }

  hasApiKey(content: string): boolean {
    for (const pattern of this.apiKeyPatterns) {
      if (pattern.test(content)) {
        logger.warn("SHIELD", "⚠️  API key detected, content blocked");
        return true;
      }
    }
    return false;
  }

  sanitize(content: string): string {
    let sanitized = content;
    for (const pattern of this.apiKeyPatterns) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
  }
}

export const shield = new ShieldParser();
