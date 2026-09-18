# CHAVES

Your AI coding companion in the terminal. It watches what you code, understands your changes, and gives proactive help — summaries, debug insights, contextual chat — without leaving your workflow.

## Quick Start

```bash
npm install -g chaves
chaves
```

That's it. On first run, an interactive wizard walks you through:

- **AI provider** — sign in with ChatGPT to use your Codex subscription, or paste an [OpenRouter](https://openrouter.ai) API key
- **Model** — pick from the models offered by the selected provider
- **Language** — responses in your preferred language
- **Preferences** — choose response frequency, personality, and an optional dev command for terminal capture

No config files. No environment variables. Just run `chaves` and the wizard handles the rest.

ChatGPT sign-in opens a browser and uses your Codex subscription. Chaves does
not support a direct OpenAI API key: use ChatGPT subscription login for Codex
models or OpenRouter for API-key access.

This transport follows the OAuth and Codex backend protocol used by Codex
clients. It is separate from the public OpenAI API and may require maintenance
when that upstream protocol changes.

### Prerequisites

- **tmux** — for the split-pane mode (chat + dev terminal): `brew install tmux`

If tmux isn't installed, CHAVES falls back to chat-only mode automatically.

## Features

**Real-time monitoring** — Watches file changes, calculates diffs, and tracks your activity as you code.

**Proactive insights** — Infers your current goal and suggests the next logical step before you ask.

**Contextual chat** — Ask questions about your codebase. CHAVES knows what you've changed, what errors appeared in your terminal, and where to look.

**Terminal awareness** — Captures dev server output (stdout/stderr) and proactively flags errors and stack traces.

**Codebase search** — Full-text search across your indexed files via SQLite FTS5.

**Session memory** — Learns your preferences and architectural decisions across conversations.

**Security shield** — Blocks sensitive files (`.env`, keys, credentials) and redacts API keys before anything reaches the LLM. Always on, zero config.

## Usage

```bash
chaves                    # Watch current directory
chaves /path/to/project   # Watch a specific project
chaves --chat-only        # Skip tmux split, chat only
chaves --setup [path]     # Change one part of an existing configuration
chaves --onboarding [path] # Re-run the complete onboarding wizard
```

First run and `--onboarding` run the complete flow: provider/account, model,
language, response preferences, and terminal capture. `--setup` is a focused
maintenance menu and does not rerun onboarding. It offers:

1. Change model
2. Change AI provider or account
3. Sign in again
4. Change language
5. Other preferences
6. Cancel

Changing only the model keeps the current provider and credentials. Model lists
are scoped to the active provider: Codex shows the supported Codex catalog,
while OpenRouter shows its own catalog and allows a custom model ID.

### Chat Commands

Type these directly in the chat:

- `/help` — show all commands
- `/setup` — show the active provider and configuration; run `chaves --setup` outside the TUI to change it
- `/model list` — browse models from the active provider
- `/model search <query>` — search models from the active provider
- `/model set <id|number>` — select a model from the active provider
- `/history [n]` — review recent chat history
- `/diffs [n]` — see recent code changes
- `/diff <id>` — inspect a specific change

### Keyboard Shortcuts

- `Ctrl+H` or `?` — show all shortcuts (in-app)
- `Alt+1`–`Alt+4` — filter by message type (all / chat / insights / logs)
- `Ctrl+T` — cycle theme
- `Ctrl+L` — toggle between chat and dev pane

## Credentials and data

Project data is stored locally in a `.chaves.db` SQLite file inside the project.
Chat history, diffs, events, settings, and the OpenRouter API key are
per-project. The OpenRouter key is stored as plaintext in that database, so do
not commit or share it. `.chaves.db` is ignored by default.

Codex OAuth credentials are global to your user account and are never stored in
`.chaves.db`:

- `$XDG_CONFIG_HOME/chaves/codex-auth.json` when `XDG_CONFIG_HOME` is set to an absolute path
- `~/.config/chaves/codex-auth.json` on macOS and Linux otherwise
- `%APPDATA%\chaves\codex-auth.json` on Windows

On POSIX systems Chaves creates the containing directory with mode `0700` and
the credential file with mode `0600`, and replaces the file atomically.
Credentials are refreshed automatically before expiry. A backend `401` forces
one refresh and one retry; authorization failures do not disable file watching,
indexing, history, diffs, or the TUI.

If the session must be renewed, Chaves shows this recovery instruction once:

> Your ChatGPT session expired. Run chaves --setup, choose Sign in again, then restart Chaves.

## License

MIT
