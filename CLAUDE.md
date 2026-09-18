# CHAVES

An AI-powered coding companion that watches IDE activity in real-time, tracks file changes, and provides contextual summaries via an interactive terminal UI.

## Tech Stack

- **TypeScript** (strict, ESNext) executed via `tsx`
- **Node.js ES modules**
- **ai** (Vercel AI SDK) with **@openrouter/ai-sdk-provider** for OpenRouter and **@ai-sdk/openai** Responses models for Codex subscription access
- **better-sqlite3** — persistent SQLite per project (`.chaves.db`)
- **chokidar** — file system watcher
- **blessed** — terminal UI
- **diff** — unified diff calculation

## Commands

```bash
bun start [project-path]    # Run chaves in current or specified directory
bun run dev                 # Hot reload (tsx watch)
bun run setup [project-path] # Focused maintenance menu
bun start --onboarding [project-path] # Force the complete onboarding flow
bun run typecheck           # TypeScript verification
```

First run triggers the complete interactive onboarding wizard: provider/account,
provider-scoped model, language, response preferences, and terminal capture.
Pass `--onboarding` to force that full flow. `--setup` is deliberately separate
and offers six focused actions: change model; change provider/account; sign in
again; change language; other preferences; or cancel.

The supported authentication choices are ChatGPT browser login for a Codex
subscription and a per-project OpenRouter API key. There is no direct OpenAI
API-key provider.

## Optional Environment

- `CHAVES_DEBUG=true` — verbose debug logging
- `CHAVES_INDEX_ON_START=true` — index codebase at startup (default true)

## Architecture

```
Watcher (chokidar)
  → DiffTracker (unified diffs)
  → Store (SQLite: events, diffs, messages, files, config)
  → AiProvider (OpenRouter or Codex subscription)
  → Summarizer (provider-neutral AI SDK calls)
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
| `src/summarizer.ts` | Provider-neutral AI SDK calls; proactive summaries, diagnosis, and chat |
| `src/providers/types.ts` | `AiProvider` contract, model metadata, auth status, and typed auth errors |
| `src/providers/factory.ts` | Constructs OpenRouter or Codex provider and the shared Codex auth manager |
| `src/providers/openrouter.ts` | OpenRouter model construction, API-key status, and remote model catalog |
| `src/providers/codex/auth.ts` | Codex credential lifecycle, serialized refresh, and reauthentication state |
| `src/providers/codex/credentials.ts` | Global private credential-path resolution and atomic JSON storage |
| `src/providers/codex/oauth.ts` | Browser OAuth Authorization Code + PKCE flow and token refresh |
| `src/providers/codex/fetch.ts` | Authenticated Codex transport, request rewrite, and one 401 retry |
| `src/providers/codex/provider.ts` | AI SDK OpenAI Responses adapter and provider-scoped Codex catalog |
| `src/indexer.ts` | Startup codebase indexing with FTS5 support |
| `src/ui.ts` | Terminal UI orchestration |
| `src/ui/chat.ts` | blessed chat component |
| `src/chaves-tools.ts` | AI tool definitions (recent_events, get_file, search_files, recent_diffs, get_diff) |
| `src/chatCommands.ts` | Slash commands: /help /setup /model /history /events /diffs /diff |
| `src/shield.ts` | Security: blocks sensitive files, sanitizes API keys from content |
| `src/file-rules.ts` | File classification: ignored patterns, binary extensions, language detection |
| `src/onboarding.ts` | First-run wizard |
| `src/modelSetup.ts` | Provider-aware model and language selection UI |
| `src/configurationSections.ts` | Shared onboarding/setup sections without merging the two flows |
| `src/setup.ts` | Focused six-option maintenance wizard |

## Database Schema (`.chaves.db`)

- `events` — file_create, file_change, file_delete, idle_start, idle_end
- `summaries` — AI-generated activity summaries with event ranges
- `diff_snapshots` — diff history with JSON changes
- `messages` — chat history (role, channel, session_id)
- `chat_summaries` — rolling conversation summaries
- `files` — indexed project files with FTS5 virtual table
- `config` — per-project key/value store (provider, model, language, OpenRouter key, frequency, personality, terminal command)

## Security (Shield)

Three-layer protection applied at file blocking → content scanning → prompt sanitization:
- Blocks `.env`, `.key`, `.pem`, credentials files
- Detects and redacts API key patterns (OpenAI, AWS, Stripe, GitHub, Slack, etc.)
- No configuration required; always active

## Configuration (stored in `.chaves.db`)

- **ai_provider** — `openrouter` or `codex`; missing values default to OpenRouter for backward compatibility
- **openrouter_api_key** — stored OpenRouter API key (BYOK, per-project)
- **summary_model** — active provider-scoped LLM model ID
- **response_language** — UI/output language
- **message_frequency_level** — 1 (conservative), 2 (normal), 3 (aggressive)
- **personality** — technical, collaborative, or creative
- **dev_command** — optional command captured in the managed tmux pane

Codex credentials are not project configuration. They are stored globally at
`$XDG_CONFIG_HOME/chaves/codex-auth.json`, `~/.config/chaves/codex-auth.json`,
or `%APPDATA%\chaves\codex-auth.json`. POSIX directory/file permissions are
`0700`/`0600`, and writes are atomic. Access tokens refresh automatically. A
second `401` after one forced refresh blocks further background AI calls and
shows exactly:

`Your ChatGPT session expired. Run chaves --setup, choose Sign in again, then restart Chaves.`

The TUI `/setup` command is informational only. It reports the active provider
and directs the user to run `chaves --setup`; no `/auth`, `/login`, or `/logout`
commands exist. `/model` listing, search, and selection use only the active
provider's catalog.

## Notes

- Each project gets its own `.chaves.db` — settings and history are per-project
- Summaries are triggered by event/file count thresholds (configurable via env vars)
- Chat context uses rolling summaries every 40 messages to stay within token limits
- FTS5 full-text search on indexed files; falls back to LIKE queries if unavailable
