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
    /\.ssh\//i,
    /\.aws\//i,
    /id_rsa/i,
    /id_ed25519/i,
    /kube\/config/i,
    /\.p12$/i,
    /\.pfx$/i,
  ];

  private readonly apiKeyRegex = new RegExp([
    "sk-[A-Za-z0-9]{20,}", // OpenAI
    "AKIA[0-9A-Z]{16}", // AWS
    "stripe_(test|live)_[A-Za-z0-9]{24,}", // Stripe
    "ghp_[A-Za-z0-9]{36,}", // GitHub
    "xoxb-[A-Za-z0-9-]{25,}", // Slack
    "mongodb\\+srv://[^\\s]+", // MongoDB
    "postgres://[^\\s]+", // PostgreSQL
    "mysql://[^\\s]+", // MySQL
    "AIza[0-9A-Za-z-_]{35}", // Google Cloud
    "-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----", // Private Keys
    "[a-f0-9]{32,}", // Generic long hex (potential hashes/keys)
  ].join("|"), "gi");

  isSensitiveFile(filePath: string): boolean {
    const fileName = basename(filePath);
    // Check both filename and full path for sensitive markers
    for (const pattern of this.blockedFilePatterns) {
      if (pattern.test(fileName) || pattern.test(filePath)) {
        logger.warn("SHIELD", `🔒 Blocked: ${filePath}`);
        return true;
      }
    }
    return false;
  }

  hasApiKey(content: string): boolean {
    const hasMatch = this.apiKeyRegex.test(content);
    // Reset regex state because of 'g' flag
    this.apiKeyRegex.lastIndex = 0;
    if (hasMatch) {
      logger.warn("SHIELD", "⚠️  Sensitive pattern detected, content blocked/redacted");
    }
    return hasMatch;
  }

  sanitize(content: string): string {
    return content.replace(this.apiKeyRegex, "[REDACTED]");
  }
}

export const shield = new ShieldParser();
