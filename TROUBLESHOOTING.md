# CHAVES Troubleshooting Guide

This guide covers common issues and their solutions when using CHAVES.

## Table of Contents

1. [Application Appears Stuck](#application-appears-stuck)
2. [No File Events Detected](#no-file-events-detected)
3. [AI Summaries Not Generating](#ai-summaries-not-generating)
4. [Database Errors](#database-errors)
5. [Logging Issues](#logging-issues)
6. [Performance Issues](#performance-issues)

---

## Application Appears Stuck

### Symptoms

- CHAVES shows "⚡ CHAVES Online" but doesn't respond
- No file events appear in the console
- Application seems frozen

### Diagnosis

The application is likely working correctly but waiting for file changes. CHAVES is an event-driven system that only displays output when files are modified.

### Solutions

#### 1. Verify Watcher is Ready

Look for this log message:

```
[TIME] INFO  [WATCHER] ✅ Watcher ready and listening for changes
```

If you see this, the watcher is running correctly.

#### 2. Test the Watcher

Create or modify a file in the watched directory:

```bash
echo "test" > test-file.txt
```

You should see:

```
[TIME] INFO  [WATCHER] 🔔 Event: file_create - test-file.txt
[TIME] INFO  [FILE] 📄 Created file: test-file.txt
```

#### 3. Check Ignored Directories

CHAVES ignores these directories by default:

- `node_modules/`
- `.git/`
- `.chaves.db`
- `dist/`
- `.next/`

Make sure you're editing files outside these directories.

#### 4. Verify File Permissions

Ensure CHAVES has read permissions:

```bash
ls -la /path/to/your/project
```

---

## No File Events Detected

### Symptoms

- Files are being modified but no events appear
- Watcher shows as ready but doesn't respond to changes

### Diagnosis

The watcher may not have proper permissions, or files are in ignored directories.

### Solutions

#### 1. Enable Debug Mode

Enable debug mode when you need more detail. Check for detailed logs:

```
[TIME] DEBUG [WATCHER] Ignored patterns: [...]
[TIME] DEBUG [WATCHER] Idle timer set for 30000ms
```

#### 2. Check File Location

Verify the file is in the watched directory:

```bash
pwd  # Should match the project path shown by CHAVES
```

#### 3. Verify Watcher Scope

CHAVES watches the entire project directory tree (except ignored paths). Check:

```bash
# This should trigger an event
touch src/new-file.ts

# This should NOT trigger an event (ignored)
touch node_modules/test.txt
```

#### 4. Check for Symlinks

Symlinks may not be followed correctly. Check:

```bash
ls -la | grep "^l"
```

---

## AI Summaries Not Generating

### Symptoms

- File events are logged but no summaries appear
- Error messages about API failures

### Diagnosis

AI summaries require a valid OpenRouter API key and sufficient events.

### Solutions

#### 1. Check API Key

Verify the API key is set:

```bash
echo $OPENROUTER_API_KEY
```

If empty, set it:

```bash
export OPENROUTER_API_KEY="your-key-here"
```

Or create a `.env` file:

```bash
cp .env.example .env
# Edit .env with your API key
```

#### 2. Check Event Threshold

Summaries generate every 10 events by default. Check the counter:

```
[TIME] DEBUG [APP] Events since last summary: 5/10
```

Generate more file changes to reach the threshold.

#### 3. Verify API Key Validity

Test your API key:

```bash
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/models
```

#### 4. Check for AI Errors

Look for error logs:

```
[TIME] ERROR [AI] ❌ Request failed
[TIME] ERROR [AI] Error message: ...
```

Common errors:

- **401 Unauthorized**: Invalid API key
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: OpenRouter service issue

#### 5. Check Network Connectivity

Ensure you can reach OpenRouter:

```bash
ping openrouter.ai
```

---

## Database Errors

### Symptoms

- SQLite errors in logs
- Events not being saved
- Application crashes on startup

### Diagnosis

Database file may be corrupted or have permission issues.

### Solutions

#### 1. Check File Permissions

```bash
ls -la .chaves.db
```

Should be readable/writable by your user.

#### 2. Recreate Database

Backup and recreate:

```bash
mv .chaves.db .chaves.db.backup
bun run start
```

#### 3. Check Disk Space

```bash
df -h .
```

Ensure sufficient disk space is available.

#### 4. Verify SQLite Installation

```bash
sqlite3 --version
```

#### 5. Check Database Integrity

```bash
sqlite3 .chaves.db "PRAGMA integrity_check;"
```

---

## Logging Issues

### Symptoms

- No logs appearing
- Debug logs not showing
- Too many logs

### Diagnosis

Logging configuration may be incorrect.

### Solutions

#### 1. Reduce Log Noise (Recommended)

```bash
export CHAVES_DEBUG=false
bun run start
```

#### 2. Enable Debug Mode (More Detail)

```bash
export CHAVES_DEBUG=true
bun run start
```

#### 3. Check Environment Variable

```bash
echo $CHAVES_DEBUG
```

Should be `"true"` or `"false"` (or unset for default).

#### 4. Redirect Logs to File

```bash
bun run start 2>&1 | tee chaves.log
```

---

## Performance Issues

### Symptoms

- High CPU usage
- Slow response to file changes
- Memory leaks

### Diagnosis

Large number of files or frequent changes may impact performance.

### Solutions

#### 1. Check Watched Files

```bash
find . -type f | wc -l
```

Large projects (>10,000 files) may be slower.

#### 2. Add More Ignore Patterns

Edit `src/watcher.ts` to ignore more directories:

```typescript
const ignored = [
  /node_modules/,
  /\.git/,
  /\.chaves\.db/,
  /dist/,
  /\.next/,
  /build/, // Add custom patterns
  /coverage/,
];
```

#### 3. Adjust Idle Threshold

Edit `src/watcher.ts`:

```typescript
private readonly idleThreshold = 60_000; // Increase to 60 seconds
```

#### 4. Monitor Resource Usage

```bash
top -pid $(pgrep -f "tsx src/index.ts")
```

---

## Common Error Messages

### "OPENROUTER_API_KEY not set"

**Solution**: Set the API key in environment or `.env` file.

### "Watcher error: EMFILE"

**Solution**: Too many open files. Increase ulimit:

```bash
ulimit -n 10240
```

### "SQLITE_BUSY"

**Solution**: Database is locked. Close other connections:

```bash
lsof .chaves.db
```

### "Permission denied"

**Solution**: Check file/directory permissions:

```bash
chmod 755 .
chmod 644 .chaves.db
```

---

## Getting Help

If these solutions don't resolve your issue:

1. **Enable debug mode** and capture full logs:

   ```bash
   CHAVES_DEBUG=true bun run start 2>&1 | tee chaves-debug.log
   ```

2. **Check the logs** for error messages or warnings

3. **Create an issue** with:
   - Full log output
   - Steps to reproduce
   - Your environment (OS, Node/Bun version)
   - Project size and structure

4. **Join the community** for support

---

## Environment Information

When reporting issues, include:

```bash
# System info
uname -a

# Runtime version
bun --version  # or node --version

# Package versions
bun pm ls  # or npm list

# Project structure
tree -L 2 -I 'node_modules'
```

This helps diagnose environment-specific issues.
