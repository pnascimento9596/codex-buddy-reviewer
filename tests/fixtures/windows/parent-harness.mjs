import { runWindowsJobProcess } from '../../../src/windows-job-supervisor.mjs';

const [helperManifestFile, helperRoot, providerFile, pidFile] = process.argv.slice(2);
await runWindowsJobProcess(process.execPath, [providerFile, pidFile, 'wait'], {
  helperManifestFile,
  helperRoot,
  timeoutMs: 60_000
});
