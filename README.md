# CHAVES - Your AI Coding Companion

CHAVES is an intelligent coding companion that watches your IDE activity, tracks file changes, and provides AI-powered summaries of your work sessions.

## Features

- 📁 **File System Monitoring**: Tracks file creates, changes, and deletions
- 🤖 **AI Summaries**: Generates contextual summaries of your coding activity
- 💾 **Persistent Storage**: SQLite database for event history
- 🧠 **Persistent Chat Memory**: Keeps user/assistant history across restarts
- 🔎 **DB-Backed Code Search**: Indexes project files for chat-time retrieval
- 🛠️ **Interactive Commands**: Query saved history/events/diffs from chat
- 🎨 **Beautiful CLI**: Clean terminal UI with colored output
- 🐛 **Comprehensive Logging**: Detailed debug logs for troubleshooting
- 📝 **Markdown Rendering**: Beautiful markdown display using Glow (system dependency)

## Installation

```bash
bun install
```

### Install Glow (Markdown Renderer)

CHAVES uses [Glow](https://github.com/charmbracelet/glow) to render markdown summaries. Install it on your system:

**macOS (using Homebrew):**

```bash
brew install glow
```

**Other platforms:**
Follow the installation instructions at https://github.com/charmbracelet/glow

## Usage

### Basic Usage

```bash
bun run start [project-path]
```

If no path is provided, CHAVES will watch the current directory.

### Onboarding (First Run)

On first run per project, CHAVES starts a short onboarding wizard (saved to that project's `.chaves.db`) that configures:

- Inference mode: Managed inference or BYOK (Bring Your Own Key)
- Model and language
- Message frequency (verbosity + how often proactive updates fire)
- Personality (tone)

Notes:

- Managed inference currently uses the global `OPENROUTER_API_KEY` from your environment.
- BYOK stores an OpenRouter API key in plaintext in `.chaves.db`. Do not commit or share `.chaves.db`.

To force rerunning onboarding:

```bash
bun run start --onboarding [project-path]
```

### Chat Commands

You can query stored context directly from chat input:

- `/help`
- `/setup`
- `/model`
- `/model list`
- `/model set <id|number>`
- `/history [n]`
- `/events [n]`
- `/diffs [n]`
- `/diff <id>`

### Configure AI Model and Language

CHAVES uses OpenRouter to access various AI models and supports multiple languages for summaries. By default, it uses Claude 3.5 Haiku and English, but you can customize both:

```bash
bun run setup
```

To run setup for a specific project path:

```bash
bun run setup:project:path /path/to/your/project
```

Or directly using the script:

```bash
./scripts/setup-project.sh /path/to/your/project
```

This command will start an interactive wizard that lets you:

1. **Choose from popular models**:
   - Claude 3.5 Haiku (fast and efficient) ⭐ Default
   - Claude 3 Opus (most capable)
   - Claude 3 Sonnet (balanced)
   - GPT-4 Turbo
   - GPT-4
   - GPT-3.5 Turbo
   - Llama 2 70B
   - Mistral Large
   - And more...

2. **Enter a custom model ID** if you want to use a model not in the list

3. **Select a response language**:
   - English (en)
   - Spanish (es)
   - French (fr)
   - German (de)
   - Italian (it)
   - Portuguese (pt)
   - Russian (ru)
   - Japanese (ja)
   - Korean (ko)
   - Chinese (zh)

The setup configuration is saved to the specified project's `.chaves.db` file.

Once selected, your choices are saved to the project database and will be used for all future summaries. You can run the setup wizard again anytime to change the model or language.

**Example Output**:

```
🎯 Starting model selection...

📋 Available OpenRouter Models:

1. Claude 3.5 Haiku
   └─ Fast and efficient for code analysis
2. Claude 3 Opus
   └─ Most capable for complex tasks
...

Select a model (enter number): 1

✅ Selected: Claude 3.5 Haiku (anthropic/claude-3.5-haiku)

🌐 Starting language selection...

📋 Available Languages:

1. English (en)
2. Spanish (es)
3. French (fr)
...

Select a language (enter number): 1

✅ Selected: English (en)

✨ Setup complete! Using model: anthropic/claude-3.5-haiku and language: en
```

### Development Mode

```bash
bun run dev
```

This runs CHAVES with hot-reload enabled.

### Configure Model and Language

CHAVES uses OpenRouter to access various AI models and supports response language selection:

```bash
bun run setup
```

To run setup for a specific project path:

```bash
bun run setup:project:path /path/to/your/project
```

Or directly using the script:

```bash
./scripts/setup-project.sh /path/to/your/project
```

This command will start an interactive wizard that lets you:

1. **Choose from popular models**:
   - Claude 3.5 Haiku (fast and efficient) ⭐ Default
   - Claude 3 Opus (most capable)
   - Claude 3 Sonnet (balanced)
   - GPT-4 Turbo
   - GPT-4
   - GPT-3.5 Turbo
   - Llama 2 70B
   - Mistral Large
   - And more...

2. **Enter a custom model ID** if you want to use a model not in the list

The setup configuration is saved to the specified project's `.chaves.db` file.

Once selected, your choice is saved to the project database and will be used for all future summaries. You can run the setup wizard again anytime to change the model.

**Example Output**:

```
🎯 Starting model selection...

📋 Available OpenRouter Models:

1. Claude 3.5 Haiku
   └─ Fast and efficient for code analysis
2. Claude 3 Opus
   └─ Most capable for complex tasks
...

Select a model (enter number): 1

✅ Selected: Claude 3.5 Haiku (anthropic/claude-3.5-haiku)

✨ Setup complete! Using model: anthropic/claude-3.5-haiku
```

## Environment Variables

### Required

- `OPENROUTER_API_KEY`: Your OpenRouter API key for AI features

Get your API key at [OpenRouter](https://openrouter.ai/)

### Optional

- `CHAVES_DEBUG`: Set to `"true"` to enable debug logs (default: `"false"`)
- `CHAVES_INDEX_ON_START`: Enable startup indexing (default: `"true"`)
- `CHAVES_INDEX_MAX_FILE_SIZE`: Max indexed file size in bytes (default: `1048576`)
- `CHAVES_CHAT_CONTEXT_MESSAGES`: Recent chat messages injected into prompts (default: `20`)
- `CHAVES_CHAT_SUMMARY_THRESHOLD`: New chat messages before rolling chat summary updates (default: `40`)

Example:

```bash
CHAVES_DEBUG=true bun run start
```

## Logging System

CHAVES includes a comprehensive logging system for debugging and monitoring, with concise output by default to keep the terminal UX clean while still surfacing important information.

### Log Levels

- **DEBUG**: Detailed technical information (only shown when debug mode is enabled)
- **INFO**: General operational information
- **WARN**: Warning messages for non-critical issues
- **ERROR**: Error messages for critical failures

### Log Categories

The logger organizes messages by category:

- **APP**: Application lifecycle events
- **FILE**: File operations (open, read, write, close)
- **WATCHER**: File system monitoring events
- **STORE**: Database operations
- **AI**: AI/LLM requests and responses
- **UI**: User interface events
- **CONFIG**: Configuration settings

### Example Log Output (Concise Default)

```
[14:23:45.123] INFO  [APP] ⚡ CHAVES starting
[14:23:45.124] INFO  [APP] 📁 Project: /Users/dev/myproject
[14:23:45.135] INFO  [WATCHER] ✅ Watcher ready and listening for changes

[14:23:50] ✏️  src/index.ts
```

### Enabling/Disabling Debug Logs

By default, debug mode is **DISABLED** to reduce noise. To enable detailed logs:

```bash
export CHAVES_DEBUG=true
bun run start
```

Or inline:

```bash
CHAVES_DEBUG=true bun run start
```

## Troubleshooting

### CHAVES appears stuck at "CHAVES Online"

**Symptoms**: The application shows the welcome screen but doesn't respond to file changes.

**Solutions**:

1. **Check if files are being ignored**: CHAVES ignores `node_modules`, `.git`, `.chaves.db`, `dist`, and `.next` directories. Make sure you're editing files outside these directories.

2. **Enable debug logs**: Debug mode is disabled by default. Enable it to see watcher events in the logs:

   ```
   [TIME] INFO  [WATCHER] 🔔 Event: file_change - your-file.ts
   ```

3. **Check file permissions**: Ensure CHAVES has read permissions for the watched directory.

4. **Verify watcher is ready**: Look for this log message:
   ```
   [TIME] INFO  [WATCHER] ✅ Watcher ready and listening for changes
   ```

### Glow not installed or not working

**Symptoms**: Summaries are displayed as plain text instead of formatted markdown, or you see an error about Glow.

**Solutions**:

1. **Install Glow**: Make sure Glow is installed on your system. Follow the installation instructions at https://github.com/charmbracelet/glow

2. **Check if Glow is in your PATH**: Verify that the `glow` command is available in your terminal:

   ```bash
   which glow
   ```

3. **Check Glow version**: Ensure you have a recent version of Glow:

   ```bash
   glow --version
   ```

4. **Fallback to plain text**: If Glow is not available, CHAVES will automatically fall back to plain text rendering for summaries.

### AI summaries not generating

**Symptoms**: File events are logged but no summaries appear.

**Solutions**:

You can tune the summary heuristics with environment variables: `CHAVES_SUMMARY_THRESHOLD` (default 10), `CHAVES_SUMMARY_MIN_EVENTS` (default 6), and `CHAVES_SUMMARY_MIN_FILES` (default 2). These control when event-based summaries trigger based on countable events and unique files (idle events are excluded).

1. **Check API key**: Verify `OPENROUTER_API_KEY` is set:

   ```bash
   echo $OPENROUTER_API_KEY
   ```

2. **Check event threshold**: Summaries are generated every 10 events by default. Check the counter:

   ```
   [TIME] DEBUG [APP] Events since last summary: 5/10
   ```

3. **Check for AI errors**: Look for error logs:
   ```
   [TIME] ERROR [AI] ❌ Request failed
   ```

### Database errors

**Symptoms**: SQLite errors in logs.

**Solutions**:

1. **Check file permissions**: Ensure the directory is writable for `.chaves.db` creation.

2. **Delete and recreate**: Remove the database file and restart:
   ```bash
   rm .chaves.db
   bun run start
   ```

### No logs appearing

**Symptoms**: No debug or info logs visible.

**Solutions**:

1. **Check debug mode**: Ensure `CHAVES_DEBUG` is set to `"true"`:

   ```bash
   echo $CHAVES_DEBUG
   ```

2. **Enable debug explicitly**:
   ```bash
   CHAVES_DEBUG=true bun run start
   ```

## Project Structure

```
chaves/
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── src/
│   ├── index.ts          # Entry point and main loop
│   ├── watcher.ts        # File system observer (chokidar)
│   ├── store.ts          # Persistent memory + project DB (SQLite)
│   ├── indexer.ts        # Startup codebase indexing into DB
│   ├── chaves-tools.ts   # Tool-calling surface for DB queries
│   ├── summarizer.ts     # AI chat/summaries (OpenRouter)
│   ├── ui.ts             # Terminal chat UI
│   ├── logger.ts         # Logging utility
│   ├── file-rules.ts     # Shared ignore/binary/language rules
│   └── markdown/         # Markdown rendering
│       └── renderer.ts  # Glow-based markdown renderer
└── .chaves.db            # SQLite database (auto-created)
```

## Architecture

### Event Flow

1. **Watcher** detects file system changes via chokidar
2. **Store** persists events, diffs, messages, and indexed code to SQLite
3. **Indexer** builds/updates a searchable code snapshot in `.chaves.db`
4. **Summarizer** generates proactive summaries and tool-enabled chat replies
5. **UI** displays chat, status, and command output to the user
6. **Logger** tracks operations for debugging

### Idle Detection

CHAVES tracks idle time (30 seconds by default) and logs:

- `idle_start`: When no activity is detected
- `idle_end`: When activity resumes after idle period

## Development

### Building

```bash
bun run build
```

### Running Tests

```bash
bun test
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT

### Credits

Built with:

- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [Chokidar](https://github.com/paulmillr/chokidar) - File system watcher
- [Better SQLite3](https://github.com/WiseLibs/better-sqlite3) - SQLite bindings
- [Vercel AI SDK](https://sdk.vercel.ai/) - AI integration
- [OpenRouter](https://openrouter.ai/) - LLM API gateway
- [Chalk](https://github.com/chalk/chalk) - Terminal styling
- [Glow](https://github.com/charmbracelet/glow) - Markdown rendering
