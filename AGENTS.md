# Repository Guidelines

## Project Structure & Module Organization

Core application code lives in `src/`. The CLI entrypoint is `src/index.ts`, with supporting modules for storage, indexing, summaries, setup, tmux integration, and terminal UI split into focused files such as `src/store.ts`, `src/indexer.ts`, and `src/ui.ts`. Markdown rendering is isolated under `src/markdown/`, and chat-specific UI code lives in `src/ui/`.

Repository-level docs such as `README.md`, `CLAUDE.md`, and `SHIELD.md` describe behavior and operational context. Utility scripts live in `scripts/`, notably `scripts/setup-project.sh` for project setup.

## Build, Test, and Development Commands

- `bun install`: install dependencies. `package-lock.json` is also present, but the README and runtime examples use Bun.
- `bun run dev`: start the app in watch mode through `tsx watch src/index.ts`.
- `bun run start [project-path]`: run the CLI once against the current directory or a target project.
- `bun run setup`: launch the interactive setup/onboarding flow.
- `bun run setup:project:path /path/to/project`: run setup for a specific project path.
- `npx tsc --noEmit`: run the TypeScript type checker defined by `tsconfig.json`.

## Coding Style & Naming Conventions

Use TypeScript with ES module imports and strict typing. Follow the existing style: 2-space indentation, double quotes, trailing commas in multiline literals, and small single-purpose modules. Prefer `camelCase` for variables and functions, `PascalCase` for classes and types, and `kebab-case` for filenames such as `terminal-capture.ts`.

There is no dedicated formatter or linter configured today, so match the surrounding file style closely and keep changes minimal.

## Testing Guidelines

This repository currently has no committed test suite or `npm`/`bun` test script. At minimum, run `npx tsc --noEmit` before submitting changes and smoke-test the CLI with `bun run start`. If you add tests, place them in a dedicated `tests/` or `src/**/__tests__/` location and name files `*.test.ts`.

## Commit & Pull Request Guidelines

Recent history is mostly `wip`, which is not a useful long-term convention. Prefer short, imperative commit messages that describe the user-visible change, for example `Add onboarding guard for missing API key`. Pull requests should include a concise summary, manual verification steps, and terminal screenshots when UI behavior changes. Link related issues when applicable and note any new environment variables or database changes.
