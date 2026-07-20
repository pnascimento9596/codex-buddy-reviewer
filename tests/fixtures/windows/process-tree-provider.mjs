import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
const mode = process.argv[3];
spawn(process.execPath, [
  fileURLToPath(new URL('./process-tree-child.mjs', import.meta.url)),
  pidFile
], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore'
});

while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
writeFileSync(pidFile, JSON.stringify({ ...pids, supervisor: process.ppid }));
if (mode === 'exit_after_tree') process.exit(0);
if (mode === 'flood') setInterval(() => process.stdout.write('x'.repeat(4096)), 1);
setInterval(() => {}, 60_000);
