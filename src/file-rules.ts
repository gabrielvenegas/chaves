export const WATCHER_IGNORED_PATTERNS: RegExp[] = [
  /node_modules/,
  /\.git/,
  /\.chaves\.db/,
  /\.chaves\.db-journal/,
  /\.chaves\.db-shm/,
  /\.chaves\.db-wal/,
  /dist/,
  /build/,
  /\.next/,
  /\.DS_Store/,
  /\.venv/,
  /venv/,
  /env/,
  /\.env\..*/, // ignore .env.local, .env.development, etc.
  /__pycache__/,
  /\.pytest_cache/,
  /\.turbo/,
  /out/,
  /target/, // Rust build
];

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".zip",
  ".tar",
  ".gz",
  ".mp3",
  ".mp4",
  ".mov",
  ".woff",
  ".woff2",
]);

export function isIgnoredPath(path: string): boolean {
  return WATCHER_IGNORED_PATTERNS.some((pattern) => pattern.test(path));
}

export function isBinaryPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".js": "javascript",
    ".tsx": "tsx",
    ".jsx": "jsx",
    ".json": "json",
    ".md": "markdown",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
  };

  return map[ext] || "text";
}
