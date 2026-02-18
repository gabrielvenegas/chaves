# CHAVES Quick Start Guide

Get up and running with CHAVES in under 5 minutes!

## Prerequisites

- **Bun** (recommended) or Node.js installed
- OpenRouter API key ([Get one here](https://openrouter.ai/))
- **Glow** for markdown rendering ([Install here](https://github.com/charmbracelet/glow))

## Installation

1. **Clone or navigate to the project**:

   ```bash
   cd /path/to/chaves
   ```

2. **Install dependencies**:

   ```bash
   bun install
   ```

3. **Install Glow** (for markdown rendering):
   ```bash
   brew install glow  # macOS
   # Follow instructions for other platforms at https://github.com/charmbracelet/glow
   ```

## Configuration

1. **Set your OpenRouter API key**:

   Option A - Environment variable (temporary):

   ```bash
   export OPENROUTER_API_KEY="your-api-key-here"
   ```

   Option B - .env file (permanent):

   ```bash
   cp .env.example .env
   # Edit .env and add your API key
   ```

2. **Verify configuration**:
   ```bash
   echo $OPENROUTER_API_KEY
   ```

## Running CHAVES

### Basic Usage

```bash
bun run start
```

This will watch the current directory.

### Watch a Specific Project

```bash
bun run start /path/to/your/project
```

### Development Mode (with hot-reload)

```bash
bun run dev
```

## Verifying It Works

1. **Start CHAVES**:

   ```bash
   bun run start
   ```

2. **You should see**:

   ```
   [TIME] INFO  [APP] ⚡ CHAVES starting
   [TIME] INFO  [WATCHER] ✅ Watcher ready and listening for changes

   [ASCII art banner]

   ⚡ CHAVES Online

   Project: /your/project/path
   ```

3. **Test the watcher** - Open a new terminal and create a test file:

   ```bash
   echo "test" > test-file.txt
   ```

4. **You should see in CHAVES**:

   ```
   [TIME] 📄 test-file.txt
   ```

5. **Test AI summaries** - Make 10+ file changes:

   ```bash
   for i in {1..11}; do echo "test $i" > "test-$i.txt"; done
   ```

   After the 10th change, you should see a beautifully formatted markdown summary:

   ```
   # 🤖 CHAVES

   **Current Focus**: Working on test files in project root
   **Recent Steps**:
   - Created multiple test files
   - Testing file watcher functionality
   **Likely Next**: Continue testing or clean up test files
   ```

## Debug Mode

Debug mode is **disabled by default** to keep output concise.

### Enable Debug Logs

```bash
CHAVES_DEBUG=true bun run start
```

### Disable Debug Logs (if previously enabled)

```bash
CHAVES_DEBUG=false bun run start
```

## Common Issues

### "OPENROUTER_API_KEY not set"

**Solution**: Set your API key (see Configuration section above).

### No events appearing

**Solution**:

- Make sure you're editing files in the watched directory
- Check that files aren't in ignored directories (`node_modules`, `.git`, etc.)
- Verify the watcher is ready: look for "✅ Watcher ready and listening for changes"

### Application appears stuck

**Solution**: This is normal! CHAVES is waiting for file changes. Try creating or editing a file to see it respond.

### Markdown not rendering properly

**Solution**: CHAVES uses Glow for markdown rendering. If summaries appear as plain text:

1. Make sure Glow is installed: `brew install glow` (macOS) or follow instructions for your platform
2. Verify Glow is in your PATH: `which glow`
3. Check if Glow is working: `glow --version`
4. CHAVES will fall back to plain text if Glow is not available

### Configure AI model and language

**Solution**: Use the setup wizard to customize your AI model and response language:

```bash
bun run setup
```

This lets you select from various AI models and choose your preferred language for summaries.

## What CHAVES Does

1. **Monitors your project** for file changes
2. **Tracks all activity** in a SQLite database
3. **Generates AI summaries** every 10 events
4. **Detects idle time** after 30 seconds of inactivity

## Next Steps

- Read the [README.md](README.md) for detailed documentation
- Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if you encounter issues
- Customize the summary threshold in `src/index.ts` (default: 10 events)
- Adjust idle timeout in `src/watcher.ts` (default: 30 seconds)

## Stopping CHAVES

Press `Ctrl+C` to stop CHAVES gracefully.

You'll see:

```
[TIME] INFO  [APP] 👋 CHAVES shutting down
[TIME] INFO  [WATCHER] 🛑 Stopping watcher...
[TIME] INFO  [WATCHER] ✅ Watcher stopped

👋 Chaves offline
```

## Need Help?

1. Enable debug mode: `CHAVES_DEBUG=true bun run start`
2. Check logs for error messages
3. Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
4. Check that your API key is valid at [OpenRouter](https://openrouter.ai/)

---

**That's it!** You're ready to use CHAVES. Happy coding! 🚀
