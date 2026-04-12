# CHAVES: Coding Helper & Activity Visualizer for Engineering Sessions

CHAVES is an AI-powered coding companion that brings real-time IDE activity monitoring and contextual AI assistance directly into your terminal. It tracks your workflow, understands your code, and provides proactive insights to keep you in the flow.

## Core Features

### 🛠️ Real-Time Activity Monitoring
- **Intelligent Watcher**: Monitors your project directory for file creations, changes, and deletions using `chokidar`.
- **Granular Diff Tracking**: Calculates and stores unified diffs for every file change, providing the AI with precise context about your implementation steps.
- **Idle Detection**: Tracks active vs. idle periods to provide better session summaries.

### 🧠 Advanced AI Orchestration
- **Multi-Model Support**: Powered by OpenRouter, supporting state-of-the-art models like Claude 3.5 Sonnet and GPT-4.
- **Proactive Insights**: Automatically analyzes your recent activity to infer your current goal, focus, and suggest the most logical next step before you even ask.
- **Context-Aware Chat**: A built-in terminal chat interface that knows exactly what you've been working on, what files you've changed, and what errors are appearing in your terminal.

### 📂 Deep Codebase Understanding
- **Full-Text Search (FTS5)**: Instant, project-wide search across all indexed files directly from the chat using SQLite's FTS5 engine.
- **Smart Indexing**: Automatically indexes your codebase on startup, respecting `.gitignore` and security rules.
- **Language Detection**: Automatically identifies programming languages for better syntax highlighting and AI reasoning.

### 💾 Durable Session Memory
- **Passive Preference Learning**: CHAVES learns your coding style, architectural preferences, and project goals by analyzing your chat history in the background.
- **Long-Term Fact Storage**: Remembers durable decisions (e.g., "we use Vitest over Jest") across restarts, reducing the need for repeated explanations.
- **Rolling Summaries**: Maintains a compact, high-value summary of your entire conversation history to stay within LLM context limits without losing track of the big picture.

### 📟 Terminal & tmux Integration
- **Integrated Dev Environment**: When a `dev_command` is configured, CHAVES automatically bootstraps a managed **tmux session** with a side-by-side split.
- **Shell-Aware Dev Pane**: Spawns your project's dev command in a dedicated pane using your system's native login shell (e.g., `zsh`, `bash`), ensuring all your environment variables and aliases are preserved.
- **Seamless Relay**: Uses `tmux pipe-pane` to capture all stdout/stderr from your running dev process and stream it directly into the CHAVES database for real-time analysis.
- **Hotkey Navigation**: Use `Ctrl+L` to instantly toggle focus between the AI chat and your development terminal.

### ⚡ Performance Optimizations
- **Asynchronous Processing**: Background tasks handle indexing, diffing, and memory extraction to keep the TUI responsive.
- **Incremental Indexing**: Only updates changed files in the FTS5 index, minimizing I/O and CPU overhead.
- **Rolling Context Windows**: Intelligently summarizes chat history and file events to provide maximum AI "intelligence" while keeping token consumption and latency low.

### 🛡️ Security & Privacy
- **Shield Layer**: Built-in protection that blocks sensitive files (e.g., `.env`, `.pem`, `.git`) from being read by the AI.
- **API Key Redaction**: Automatically detects and redacts potential secrets and API keys from file contents before they are sent to the LLM.
- **Local-First Data**: All activity logs, diffs, and chat history are stored in a local SQLite database (`.chaves.db`) within your project.

## Technical Stack
- **Runtime**: Bun / Node.js (ESM)
- **Language**: TypeScript (Strict)
- **Database**: SQLite (`better-sqlite3`)
- **AI Integration**: Vercel AI SDK
- **UI**: Blessed (TUI) + Glow (Markdown Rendering)
