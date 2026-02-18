# Model Setup Guide

## Overview

CHAVES integrates with OpenRouter to access a wide variety of AI models for generating code activity summaries. The model setup feature allows you to choose which model to use without modifying code or configuration files.

## Quick Start

To configure your preferred AI model:

```bash
bun run setup
```

This interactive wizard will guide you through:
1. Viewing available models
2. Selecting a model or entering a custom model ID
3. Saving your choice to the project database

Your selection is persisted and will be used for all future summary generations until you change it again.

## Available Models

### Recommended Models (Pre-configured)

#### Claude Models (Anthropic)
- **Claude 3.5 Haiku** ⭐ (Default)
  - ID: `anthropic/claude-3.5-haiku`
  - Speed: ⚡⚡⚡⚡⚡ (Fastest)
  - Cost: 💰 (Cheapest)
  - Best for: Quick, efficient code analysis
  - Context: 200K tokens

- **Claude 3 Sonnet**
  - ID: `anthropic/claude-3-sonnet`
  - Speed: ⚡⚡⚡ (Fast)
  - Cost: 💰💰 (Moderate)
  - Best for: Balanced performance and cost
  - Context: 200K tokens

- **Claude 3 Opus**
  - ID: `anthropic/claude-3-opus`
  - Speed: ⚡⚡ (Slower)
  - Cost: 💰💰💰 (More expensive)
  - Best for: Complex reasoning and detailed analysis
  - Context: 200K tokens

#### OpenAI Models
- **GPT-4 Turbo**
  - ID: `openai/gpt-4-turbo`
  - Speed: ⚡⚡⚡ (Fast)
  - Cost: 💰💰💰 (Expensive)
  - Best for: Advanced capabilities, vision
  - Context: 128K tokens

- **GPT-4**
  - ID: `openai/gpt-4`
  - Speed: ⚡⚡ (Slower)
  - Cost: 💰💰💰💰 (Very expensive)
  - Best for: Maximum capability
  - Context: 8K tokens

- **GPT-3.5 Turbo**
  - ID: `openai/gpt-3.5-turbo`
  - Speed: ⚡⚡⚡⚡ (Very fast)
  - Cost: 💰 (Cheap)
  - Best for: Budget-conscious use
  - Context: 16K tokens

#### Open Source Models
- **Llama 2 70B**
  - ID: `meta-llama/llama-2-70b-chat`
  - Speed: ⚡⚡ (Moderate)
  - Cost: 💰 (Cheap)
  - Best for: Fully open source, no proprietary concerns
  - Context: 4K tokens

- **Mistral Large**
  - ID: `mistralai/mistral-large`
  - Speed: ⚡⚡⚡ (Fast)
  - Cost: 💰 (Cheap)
  - Best for: Efficient open source
  - Context: 32K tokens

## Using the Setup Wizard

### Step-by-Step Example

```
$ bun run setup

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

### Selecting a Custom Model

If you want to use a model not in the pre-configured list, select option "Enter custom model ID" and provide the full model ID from OpenRouter.

**Example**:
```
Select a model (enter number): 9
Enter model ID: mistralai/mistral-7b
```

To find valid model IDs, visit [OpenRouter Models](https://openrouter.ai/models).

## How It Works

### Storage

Your model choice is stored in the SQLite database (`.chaves.db`) in the `config` table:

```sql
SELECT * FROM config WHERE key = 'summary_model';
-- Returns: anthropic/claude-3.5-haiku
```

### Default Behavior

If no model is configured, CHAVES defaults to **Claude 3.5 Haiku** (`anthropic/claude-3.5-haiku`).

### Runtime Selection

When CHAVES starts:
1. It loads the configured model from the database
2. Initializes the Summarizer with that model
3. Uses it for all summary generations during that session

## Choosing the Right Model

### For Speed and Cost (Default Choice)
**Claude 3.5 Haiku** - Perfect for quick summaries with minimal API costs.

### For Best Quality
**Claude 3 Opus** - Most capable model for complex code analysis and detailed insights.

### For Balanced Performance
**Claude 3 Sonnet** - Good quality-to-cost ratio, fast enough for real-time use.

### For OpenAI Preference
**GPT-4 Turbo** - Powerful and capable, good if you're already using GPT models.

### For Budget-Conscious Usage
**GPT-3.5 Turbo** - Cheapest option while remaining capable.

### For Open Source Preference
**Mistral Large** - Efficient open source option that's fast and affordable.

## Troubleshooting

### "Setup cancelled. Please try again."
You likely selected an invalid option number. Make sure to enter a number between 1 and the maximum option shown.

### Custom model not working
1. Verify the model ID is correct on [OpenRouter](https://openrouter.ai/models)
2. Check that your API key has access to that model
3. See the API error logs with: `CHAVES_DEBUG=true bun run start`

### Model not changing after setup
The configuration is saved per project directory (in `.chaves.db`). If you:
- Run CHAVES in a different directory, it will use that directory's configured model (or default)
- Delete `.chaves.db`, the default model will be used again

### API errors when using new model
Some models may have different capabilities or limits:
- Check your OpenRouter API key has sufficient credits
- Verify the model is available in your region
- Check OpenRouter's model documentation for rate limits

## Advanced Usage

### Checking Current Model

View the configured model by looking at the database directly:

```bash
sqlite3 .chaves.db "SELECT value FROM config WHERE key = 'summary_model';"
```

Or during a run, enable debug mode to see which model is being used:

```bash
CHAVES_DEBUG=true bun run start
```

Look for:
```
[TIME] DEBUG [AI] Using model: anthropic/claude-3.5-haiku
```

### Changing Models Without Setup Wizard

If you prefer, you can update the database directly:

```bash
sqlite3 .chaves.db "INSERT OR REPLACE INTO config (key, value) VALUES ('summary_model', 'openai/gpt-4-turbo');"
```

### Project-Specific Models

Since models are stored per project directory, you can use different models for different projects:

```bash
# Project A uses Claude
cd ~/projects/project-a
bun run setup
# Select: Claude 3.5 Haiku

# Project B uses GPT-4
cd ~/projects/project-b
bun run setup
# Select: GPT-4 Turbo
```

Each project's `.chaves.db` remembers its configured model.

## API Key Requirements

Your `OPENROUTER_API_KEY` must have:
- Valid credentials
- Sufficient API credits
- Access to the chosen model (some models may have restricted access)

Get your API key at [OpenRouter](https://openrouter.ai/).

## Performance Considerations

### Response Times (Approximate)
- **Haiku**: 2-5 seconds
- **Sonnet**: 3-7 seconds
- **Opus**: 5-15 seconds
- **GPT-4 Turbo**: 3-8 seconds
- **GPT-3.5 Turbo**: 2-5 seconds

### Token Costs (Per Summary)
Code activity summaries typically use 300-500 tokens. Costs vary by model:
- **Haiku**: ~0.01¢ per summary
- **Sonnet**: ~0.02¢ per summary
- **Opus**: ~0.05¢ per summary
- **GPT-3.5 Turbo**: ~0.001¢ per summary
- **GPT-4 Turbo**: ~0.03¢ per summary

*Costs are approximate and relative. Check OpenRouter for current pricing.*

## Tips

1. **Start with Haiku**: It's fast, cheap, and works well for code summaries
2. **Test models**: Try different models to see which you prefer
3. **Monitor costs**: Keep an eye on your OpenRouter usage dashboard
4. **Use debug mode**: Enable `CHAVES_DEBUG=true` to see model selection logs
5. **Check API health**: If you get errors, verify your API key and credits on OpenRouter

## Related Documentation

- [CHAVES README](./README.md) - Main project documentation
- [OpenRouter Models](https://openrouter.ai/models) - Full list of available models
- [OpenRouter Docs](https://openrouter.ai/docs) - API documentation
