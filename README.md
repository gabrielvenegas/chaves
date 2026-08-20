# CHAVES

Your AI coding companion in the terminal. It watches what you code, understands your changes, and gives proactive help — summaries, debug insights, contextual chat — without leaving your workflow.

## Quick Start

```bash
npm install -g chaves
chaves
```

That's it. On first run, an interactive wizard walks you through:

- **API key** — paste your [OpenRouter](https://openrouter.ai) key (stored locally per project)
- **Model** — pick from Claude, GPT-4, and more
- **Language** — responses in your preferred language
- **Dev command** — optional: your `npm run dev` / `bun dev` / etc. for terminal capture

No config files. No environment variables. Just run `chaves` and the wizard handles the rest.

### Prerequisites

- **tmux** — for the split-pane mode (chat + dev terminal): `brew install tmux`
- **Glow** — for markdown rendering: `brew install glow`

If you skip these, CHAVES falls back to chat-only mode automatically.

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
```

### Chat Commands

Type these directly in the chat:

- `/help` — show all commands
- `/setup` — reconfigure model, language, or dev command
- `/model list` — browse available models
- `/history [n]` — review recent chat history
- `/diffs [n]` — see recent code changes
- `/diff <id>` — inspect a specific change

### Keyboard Shortcuts

- `Ctrl+H` or `?` — show all shortcuts (in-app)
- `Alt+1`–`Alt+4` — filter by message type (all / chat / insights / logs)
- `Ctrl+T` — cycle theme
- `Ctrl+L` — toggle between chat and dev pane

## Data

Everything is stored locally in a `.chaves.db` SQLite file inside your project. Chat history, diffs, events, and settings are per-project. Add `.chaves.db` to `.gitignore` (it's ignored by default).

## License

MIT
