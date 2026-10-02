#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, '..', 'dist', 'src', 'cli', 'index.js');

if (fs.existsSync(distPath)) {
  const { runCli } = await import(pathToFileURL(distPath).href);
  await runCli(process.argv);
} else {
  console.error("relay: built bundle not found. Please run 'npm run build' or use 'tsx src/cli/index.ts'.");
  process.exit(1);
}
