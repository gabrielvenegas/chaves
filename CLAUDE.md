# CHAVES

An AI-powered coding companion that watches IDE activity in real-time, tracks file changes, and provides contextual summaries via an interactive terminal UI.

## Tech Stack

- **TypeScript** (strict, ESNext) executed via `tsx`
- **Node.js ES modules**
- **@ai-sdk/openai** + **ai** (Vercel AI SDK) — OpenRouter as LLM gateway
- **better-sqlite3** — persistent SQLite per project (`.chaves.db`)
- **chokidar** — file system watcher
- **blessed** — terminal UI
- **diff** — unified diff calculation

## Commands

```bash
bun start [project-path]    # Run chaves in current or specified directory
bun run dev                 # Hot reload (tsx watch)
bun run setup [project-path] # Configure model/language
```

First run triggers an interactive onboarding wizard that collects your OpenRouter API key and stores it per-project. Pass `--onboarding` to re-run it.

## Optional Environment

- `CHAVES_DEBUG=true` — verbose debug logging
- `CHAVES_INDEX_ON_START=true` — index codebase at startup (default true)

## Architecture

```
Watcher (chokidar)
  → DiffTracker (unified diffs)
  → Store (SQLite: events, diffs, messages, files, config)
  → Summarizer (OpenRouter LLM)
  → UI (blessed chat terminal)
  → Tools (chaves-tools: AI-callable DB tools)
```

**Event flow:** file change → diff → store → threshold check → LLM summary → UI display

## Key Source Files

| File | Role |
|------|------|
| `src/index.ts` | Main entry; orchestrates all modules |
| `src/store.ts` | SQLite layer; events, messages, summaries, files, config |
| `src/watcher.ts` | chokidar file watcher; idle detection (30s) |
| `src/diff-tracker.ts` | Diff calculation; caches previous content in-memory |
| `src/summarizer.ts` | LLM calls via OpenRouter; proactive summaries + chat |
| `src/indexer.ts` | Startup codebase indexing with FTS5 support |
| `src/ui.ts` | Terminal UI orchestration |
| `src/ui/chat.ts` | blessed chat component |
| `src/chaves-tools.ts` | AI tool definitions (recent_events, get_file, search_files, recent_diffs, get_diff) |
| `src/chatCommands.ts` | Slash commands: /help /setup /model /history /events /diffs /diff |
| `src/shield.ts` | Security: blocks sensitive files, sanitizes API keys from content |
| `src/file-rules.ts` | File classification: ignored patterns, binary extensions, language detection |
| `src/onboarding.ts` | First-run wizard |
| `src/modelSetup.ts` | Model + language selection UI |

## Database Schema (`.chaves.db`)

- `events` — file_create, file_change, file_delete, idle_start, idle_end
- `summaries` — AI-generated activity summaries with event ranges
- `diff_snapshots` — diff history with JSON changes
- `messages` — chat history (role, channel, session_id)
- `chat_summaries` — rolling conversation summaries
- `files` — indexed project files with FTS5 virtual table
- `config` — key/value store (model, language, api key, frequency, personality)

## Security (Shield)

Three-layer protection applied at file blocking → content scanning → prompt sanitization:
- Blocks `.env`, `.key`, `.pem`, credentials files
- Detects and redacts API key patterns (OpenAI, AWS, Stripe, GitHub, Slack, etc.)
- No configuration required; always active

## Configuration (stored in `.chaves.db`)

- **openrouter_api_key** — stored OpenRouter API key (BYOK, per-project)
- **model** — active LLM model ID
- **language** — UI/output language
- **message_frequency_level** — 1 (conservative), 2 (normal), 3 (aggressive)
- **personality** — technical, collaborative, or creative

## Notes

- Each project gets its own `.chaves.db` — settings and history are per-project
- Summaries are triggered by event/file count thresholds (configurable via env vars)
- Chat context uses rolling summaries every 40 messages to stay within token limits
- FTS5 full-text search on indexed files; falls back to LIKE queries if unavailable
