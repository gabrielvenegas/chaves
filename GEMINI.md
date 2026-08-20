# GEMINI.md - CHAVES Project Context

## Project Overview
**CHAVES** (Coding Helper & Activity Visualizer for Engineering Sessions) is an AI-powered coding companion that brings real-time IDE activity monitoring and contextual AI assistance directly into the terminal. It tracks file system changes, calculates diffs, and provides an interactive chat interface powered by OpenRouter models (e.g., Claude 3.5, GPT-4).

### Core Architecture
- **Watcher (chokidar)**: Monitors the project directory for file creations, changes, and deletions.
- **DiffTracker**: Calculates unified diffs for file changes to provide granular context to the AI.
- **Store (better-sqlite3)**: Maintains a persistent project-specific database (`.chaves.db`) containing:
  - Activity events and diff snapshots.
  - Full-text searchable code index (FTS5).
  - Chat history and rolling conversation summaries.
  - Captured terminal output (via tmux relay).
- **Summarizer (Vercel AI SDK + OpenRouter)**: Generates proactive summaries of coding activity and handles interactive chat queries using specialized tools.
- **UI (blessed)**: A terminal-based user interface featuring a chat pane and an optional integrated development terminal.
- **Shield**: A built-in security layer that blocks sensitive files (e.g., `.env`, `.pem`) and redacts API keys from AI prompts.

## Key Technologies
- **Runtime**: [Bun](https://bun.sh/) / Node.js (ESM)
- **Language**: TypeScript (Strict mode)
- **AI Stack**: Vercel AI SDK (`ai`), OpenRouter Gateway
- **Database**: SQLite (`better-sqlite3`)
- **UI/UX**: `blessed` (TUI), `chalk` (styling), built-in markdown renderer
- **Tooling**: `chokidar` (watching), `diff` (patching/diffing), `tsx` (execution)

## Building and Running

### Prerequisites
- An OpenRouter API key (collected during onboarding, stored per-project in `.chaves.db`).

### Commands
- `bun install`: Install project dependencies.
- `bun start [project-path]`: Launch CHAVES for the current or specified directory.
- `bun run dev`: Run in development mode with `tsx watch` enabled.
- `bun run setup [project-path]`: Run the interactive model and language configuration wizard.
- `bun run setup:project:path /path/to/project`: Targeted setup for a specific directory.

### Optional Environment Variables
- `CHAVES_DEBUG`: Set to `true` for verbose logging.
- `CHAVES_INDEX_ON_START`: Set to `false` to skip codebase indexing at startup.

## Development Conventions

### Coding Style
- **TypeScript & ESM**: Always use strict TypeScript and Node.js ES Modules.
- **Logging**: Use the centralized `logger.js` for all application logs. Categories include `APP`, `WATCHER`, `AI`, `STORE`, `UI`, and `SHIELD`.
- **Error Handling**: Use the `UI` and `Logger` instances to surface errors to the user while maintaining a clean TUI state.

### AI Tool Usage
The AI has access to several tools defined in `src/chaves-tools.ts`:
- `recent_events`: Query file system activity.
- `search_code`: Full-text search across the indexed codebase.
- `get_file`: Retrieve specific file contents (respecting Shield blocks).
- `terminal_output`: Inspect recent stdout/stderr from the dev process.
- `recent_diffs` / `get_diff`: Analyze specific code changes.

### Security
- **Shield**: Never bypass the `ShieldParser`. It is the primary defense against leaking secrets to the LLM.
- **Database**: `.chaves.db` contains plaintext chat history and should never be committed to source control (it is ignored by default).

## Project Structure
- `src/index.ts`: Orchestration and main application loop.
- `src/watcher.ts`: File system monitoring logic.
- `src/store.ts`: SQLite database schema and access layer.
- `src/summarizer.ts`: LLM prompt engineering and AI interaction logic.
- `src/ui/`: Terminal UI components (Chat, Renderer, etc.).
- `src/chaves-tools.ts`: Tool definitions for the AI SDK.
- `src/shield.ts`: Content sanitization and file blocking.
- `scripts/`: Shell scripts for environment setup and project initialization.
