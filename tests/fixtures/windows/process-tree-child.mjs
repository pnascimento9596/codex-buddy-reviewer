import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, [
  '-e',
  'setInterval(() => {}, 60_000)'
], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore'
});
writeFileSync(pidFile, JSON.stringify({
  provider: process.ppid,
  child: process.pid,
  grandchild: grandchild.pid
}));
setInterval(() => {}, 60_000);
