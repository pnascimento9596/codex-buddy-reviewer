import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
const supervisor = Number(process.argv[3]);
if (!Number.isInteger(supervisor) || supervisor <= 0) {
  throw new Error('Windows process-tree fixture requires a positive supervisor PID');
}
const grandchild = spawn(process.execPath, [
  '-e',
  'setInterval(() => {}, 60_000)'
], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore'
});
const temporaryPidFile = `${pidFile}.${process.pid}.tmp`;
writeFileSync(temporaryPidFile, JSON.stringify({
  provider: process.ppid,
  child: process.pid,
  grandchild: grandchild.pid,
  supervisor
}));
renameSync(temporaryPidFile, pidFile);
setInterval(() => {}, 60_000);
