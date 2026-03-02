### Option 2 — Override `console` at runtime (library approach)

If it's a **JS/TS project**, you can import a tiny module that monkey-patches `console`:

```typescript
// just add this to your entry point
import "@chaves/listener";
```

Internally it does:

```typescript
const original = { ...console };
const db = new Database(resolveDbPath());

(["log", "warn", "error", "info"] as const).forEach((level) => {
  console[level] = (...args) => {
    original[level](...args); // passthrough
    db.run(`INSERT INTO terminal_events ...`, {
      level,
      raw: args.join(" "),
    });
  };
});
```

This is **zero config** for the user — one import and done.
