# CHAVES - Your AI Coding Companion

CHAVES is an intelligent coding companion that brings real-time IDE activity monitoring, terminal awareness, and contextual AI assistance directly into your terminal. It watches your workflow, tracks file changes, and provides proactive summaries and debugging help in a high-performance Terminal UI.

## Features

### 🛠️ Real-Time Activity Monitoring
- **Intelligent Watcher**: Monitors your project for file creations, changes, and deletions with granular diff tracking.
- **Proactive Insights**: Automatically infers your current goal and focus, suggesting the most logical next step before you even ask.

### 🧠 Advanced AI & Memory
- **Durable Session Memory**: Passive learning of your coding style and architectural preferences from chat history.
- **Rolling Context Windows**: Compact conversation summaries to maintain long-term memory while keeping AI response times fast.
- **Multi-Model Support**: Powered by OpenRouter, supporting Claude 3.5, GPT-4, and more.

### 📟 Terminal & tmux Mastery
- **Integrated Dev Shell**: Bootstraps a managed **tmux session** with a split-pane layout (Chat + Dev Terminal).
- **Environment Awareness**: Spawns dev commands in your project's native login shell, preserving all environment variables and aliases.
- **Real-Time Terminal Relay**: Automatically captures and stores stdout/stderr output for proactive error analysis and debugging.

### 📂 Deep Search & Security
- **DB-Backed Code Search**: Project-wide search across indexed files using SQLite's FTS5 engine.
- **Shield Protection**: Built-in security layer to block sensitive files and redact API keys before they reach the LLM.

## Installation

```bash
bun install
```

### Install Glow (Markdown Renderer)
CHAVES uses [Glow](https://github.com/charmbracelet/glow) to render markdown summaries. Install it on your system:

**macOS:** `brew install glow`
**Others:** See [Glow Installation](https://github.com/charmbracelet/glow)

## Usage

### Basic Usage
```bash
bun start [project-path]
```
If no path is provided, CHAVES will watch the current directory.

### Interactive Commands
Query context directly from the chat:
- `/help` - Show all commands
- `/setup` - Configure models and languages
- `/model list` - Browse available OpenRouter models
- `/history [n]` - Review recent chat history
- `/diffs [n]` - See the last `n` diff snapshots
- `/diff <id>` - Inspect a specific code change by ID

## Environment Variables

- `OPENROUTER_API_KEY`: **(Required)** Your OpenRouter API key.
- `CHAVES_DEBUG`: Set to `"true"` for detailed operation logs.
- `CHAVES_INDEX_ON_START`: Set to `"false"` to skip codebase indexing at startup.

## Roadmap

### 1. 🔍 Semantic Search with Local Embeddings
Move beyond simple keyword matching. We are planning to replace or augment FTS5 with a local vector index so CHAVES can find code by meaning. This will improve vague queries like "where is the auth flow?" or "how do I add a new command?".

### 2. 🪲 Automated Debugging Workflows
Leveraging the tmux relay to proactively detect errors and stack traces. CHAVES will analyze failing runs, locate the likely buggy files, and suggest a fix in the chat pane automatically.

### 3. ⚡ High-Performance Intelligent Tracking
Building model-agnostic change tracking that is even more surgical. We aim to optimize how changes are summarized and presented to the LLM, ensuring the highest context quality with minimum token consumption, regardless of which model you choose.

### 4. 🤖 Autonomous Proactivity
Transitioning from a passive "assistant" to an active "agent." This includes enabling CHAVES to perform multi-step research tasks and code validation when granted permission, effectively becoming a collaborative peer programmer that works while you think.

## License
MIT

---
Built with Bun, SQLite, Vercel AI SDK, and OpenRouter.
