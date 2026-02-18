# Model Setup Examples

## Example 1: First-Time Setup (Default Model)

A new user wants to start using CHAVES and configure it for their project.

```bash
$ cd ~/my-project
$ bun run setup
```

**Output:**
```
🎯 Starting model selection...

📋 Available OpenRouter Models:

1. Claude 3.5 Haiku
   └─ Fast and efficient for code analysis
2. Claude 3 Opus
   └─ Most capable for complex tasks
3. Claude 3 Sonnet
   └─ Balanced performance and cost
4. GPT-4 Turbo
   └─ Powerful model with vision capabilities
5. GPT-4
   └─ Reliable and capable general model
6. GPT-3.5 Turbo
   └─ Fast and cost-effective
7. Llama 2 70B
   └─ Open source model
8. Mistral Large
   └─ Efficient open source option

9. Enter custom model ID
10. Cancel setup

Select a model (enter number): 1

✅ Selected: Claude 3.5 Haiku (anthropic/claude-3.5-haiku)

✨ Setup complete! Using model: anthropic/claude-3.5-haiku
```

**Then:**
```bash
$ bun run start
```

CHAVES now runs with Claude 3.5 Haiku model automatically.

---

## Example 2: Choosing a Premium Model

A developer wants better quality summaries and chooses Claude 3 Opus.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 2

✅ Selected: Claude 3 Opus (anthropic/claude-3-opus)

✨ Setup complete! Using model: anthropic/claude-3-opus
```

**Result:** All future summaries use Claude 3 Opus (more capable but slower and more expensive).

---

## Example 3: Using a Custom Model

A developer wants to use a specific model not in the preset list.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 9
Enter model ID: mistralai/mistral-7b

✨ Setup complete! Using model: mistralai/mistral-7b
```

**Note:** They can find valid model IDs at https://openrouter.ai/models

---

## Example 4: Canceling Setup

User starts setup but decides to cancel.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 10
Setup cancelled.
```

**Result:** No changes made. CHAVES continues using the previous model (or default if none set).

---

## Example 5: Invalid Input Handling

User enters an invalid option number.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 99

❌ Invalid selection. Please try again.

📋 Available OpenRouter Models:

1. Claude 3.5 Haiku
   ...
Select a model (enter number): 3

✅ Selected: Claude 3 Sonnet (anthropic/claude-3-sonnet)

✨ Setup complete! Using model: anthropic/claude-3-sonnet
```

---

## Example 6: Multiple Projects with Different Models

Developer manages multiple projects with different model preferences.

**Project A (Production code review):**
```bash
$ cd ~/projects/production-app
$ bun run setup
# Select: 2 (Claude 3 Opus - best quality)
$ bun run start
# Uses Claude 3 Opus
```

**Project B (Side project/experiments):**
```bash
$ cd ~/projects/side-project
$ bun run setup
# Select: 6 (GPT-3.5 Turbo - cheap and fast)
$ bun run start
# Uses GPT-3.5 Turbo
```

Each project's `.chaves.db` stores its own configuration independently.

---

## Example 7: Checking Configured Model

User wants to see which model is currently configured.

```bash
$ sqlite3 .chaves.db "SELECT value FROM config WHERE key = 'summary_model';"
anthropic/claude-3.5-haiku
```

Or with debug mode:
```bash
$ CHAVES_DEBUG=true bun run start
```

**Output contains:**
```
[14:23:45.135] DEBUG [AI] Using model: anthropic/claude-3.5-haiku
```

---

## Example 8: Changing Models for a Project

Project was using Claude Haiku but needs better quality summaries.

```bash
$ cd ~/my-project
$ cat .chaves.db | sqlite3 - "SELECT value FROM config WHERE key = 'summary_model';"
anthropic/claude-3.5-haiku

$ bun run setup
# Select: 2 (Claude 3 Opus)

$ sqlite3 .chaves.db "SELECT value FROM config WHERE key = 'summary_model';"
anthropic/claude-3-opus
```

Next run of CHAVES will use Claude 3 Opus for all summaries.

---

## Example 9: Cost-Conscious Budget Setup

User wants cheapest possible option.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 6

✅ Selected: GPT-3.5 Turbo (openai/gpt-3.5-turbo)

✨ Setup complete! Using model: openai/gpt-3.5-turbo
```

**Result:** ~0.001¢ per summary, very affordable for frequent use.

---

## Example 10: Open Source Preference Setup

User prefers fully open-source models with no proprietary concerns.

```bash
$ bun run setup
```

**Selection:**
```
Select a model (enter number): 8

✅ Selected: Mistral Large (mistralai/mistral-large)

✨ Setup complete! Using model: mistralai/mistral-large
```

---

## Example 11: Batch Setup for Multiple Projects

Setting up a team's projects with a preferred model.

```bash
#!/bin/bash
for project in ~/projects/*/; do
  echo "Setting up $project..."
  cd "$project"
  # Use echo to automate selection (option 3 = Claude Sonnet)
  echo "3" | bun run setup
done
```

---

## Example 12: Resume After Crash

User's CHAVES crashed and restarted. Configuration is preserved.

```bash
$ bun run start
# Previous configuration loaded automatically
# Uses the previously selected model
```

The model choice persists in the database even after crashes or system restarts.

---

## Example 13: Debugging Model Issues

User gets an API error with their chosen model.

```bash
$ CHAVES_DEBUG=true bun run start
```

**Output shows:**
```
[14:23:45.135] DEBUG [AI] Using model: openai/gpt-4-turbo
[14:23:50.000] ERROR [AI] ❌ Request failed
[14:23:50.001] ERROR [AI] Error message: 401 Unauthorized
```

This indicates the API key doesn't have access to GPT-4 Turbo.

**Solution:**
```bash
$ bun run setup
# Select: 1 (Claude 3.5 Haiku - usually available to all keys)
```

---

## Example 14: Verifying Setup Completed

After setup, verify the model was saved.

```bash
$ bun run setup
Select a model (enter number): 4
...
✨ Setup complete! Using model: openai/gpt-4-turbo

$ sqlite3 .chaves.db ".tables"
config  events  summaries

$ sqlite3 .chaves.db "SELECT * FROM config;"
summary_model|openai/gpt-4-turbo
```

---

## Example 15: Using Setup in CI/CD

Automate model configuration in a deployment script.

```bash
#!/bin/bash
set -e

# Clone/setup project
cd /opt/my-project

# Run setup with automatic selection (option 1 = Haiku)
echo "1" | npx tsx src/index.ts --setup

# Verify
sqlite3 .chaves.db "SELECT value FROM config WHERE key = 'summary_model';"

# Start CHAVES with configured model
npx tsx src/index.ts /opt/my-project
```
