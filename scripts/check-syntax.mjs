#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const roots = ['hooks', 'scripts', 'src'];

async function collect(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`syntax tree contains a symlink: ${target}`);
    if (entry.isDirectory()) await collect(target, files);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target);
    else if (!entry.isFile()) throw new Error(`syntax tree contains an unsupported entry: ${target}`);
  }
}

const files = [];
for (const relative of roots) {
  const directory = path.join(projectRoot, relative);
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`syntax root must be a regular directory: ${relative}`);
  }
  await collect(directory, files);
}

for (const file of files) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { windowsHide: true });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(`syntax check failed: ${path.relative(projectRoot, file)}`, { cause: error });
  }
}

process.stdout.write(`Syntax checked ${files.length} modules.\n`);
