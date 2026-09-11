#!/usr/bin/env node
// bin/chaves.js — distribution entry point.
// Resolves the tsx runtime via Node's module resolution so the CLI works
// whether installed globally (npm i -g chaves), locally, or from source,
// regardless of how dependencies are hoisted or the target project's deps.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "..", "src", "index.ts");

// createRequire gives us CJS require.resolve, which walks the node_modules
// tree from this file's location — robust against npm hoisting.
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
