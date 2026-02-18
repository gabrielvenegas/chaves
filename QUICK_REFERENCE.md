# CHAVES Model Setup - Quick Reference

## Commands

### Setup Model
```bash
bun run setup
```
Interactive menu to choose your AI model.

### Run CHAVES
```bash
bun run start [project-path]
```
Runs with your configured model.

### Development Mode
```bash
bun run dev
```
Hot-reload during development.

---

## Quick Model Guide

| Model | Speed | Cost | Best For |
|-------|-------|------|----------|
| **Claude 3.5 Haiku** ⭐ | ⚡⚡⚡⚡⚡ | 💰 | Default, fast |
| Claude 3 Sonnet | ⚡⚡⚡ | 💰💰 | Balanced |
| Claude 3 Opus | ⚡⚡ | 💰💰💰 | Best quality |
| GPT-4 Turbo | ⚡⚡⚡ | 💰💰💰 | Advanced |
| GPT-3.5 Turbo | ⚡⚡⚡⚡ | 💰 | Budget |
| Mistral Large | ⚡⚡⚡ | 💰 | Open source |

---

## Setup Wizard Steps

1. Run: `bun run setup`
2. See numbered menu (1-10)
3. Enter number:
   - **1-8**: Choose preset model
   - **9**: Enter custom model ID
   - **10**: Cancel
4. Confirm selection
5. Done! Model saved to project

---

## Check Current Model

```bash
sqlite3 .chaves.db "SELECT value FROM config WHERE key = 'summary_model';"
```

---

## Change Model

```bash
cd /your/project
bun run setup
# Select different option
```

---

## Environment Setup

```bash
export OPENROUTER_API_KEY="your-api-key"
# Get one at: https://openrouter.ai/
```

Debug mode:
```bash
CHAVES_DEBUG=true bun run start
```

---

## File Storage

Configuration saved in: `.chaves.db` (SQLite)
- Per-project (each directory has own config)
- Persists across runs
- Can be deleted to reset (will use default model)

---

## Default Model

If no model configured:
- Uses: `anthropic/claude-3.5-haiku`
- Fast enough for real-time use
- Cheapest option

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Invalid selection | Enter number 1-10 |
| Custom model fails | Check model ID at openrouter.io |
| API errors | Verify OPENROUTER_API_KEY is set |
| Can't find model | Run `CHAVES_DEBUG=true bun run start` |

---

## Multi-Project Setup

Each project directory gets its own `.chaves.db`:

```bash
cd ~/project-a && bun run setup  # Choose Model 1
cd ~/project-b && bun run setup  # Choose Model 5
# Projects keep separate models
```

---

## Documentation

- **Full Guide**: `MODEL_SETUP.md`
- **Examples**: `SETUP_EXAMPLES.md`
- **Changes**: `SETUP_CHANGES.md`
- **Main Docs**: `README.md`

---

## Quick Start

```bash
# First time
bun install
bun run setup      # Pick a model
bun run start      # Run with that model

# Later
bun run start      # Uses saved model
bun run setup      # Change model anytime
```

---

**Tip**: Start with Claude 3.5 Haiku (#1) - it's fast, cheap, and works great! 🚀
