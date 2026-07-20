#!/usr/bin/env node

import { buildPublicPlugin } from './lib/public-release.mjs';

function parse(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--output' || arg === '--source-commit') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--output') options.output = value;
      else options.sourceCommit = value;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown public build argument: ${arg}`);
  }
  return options;
}

const help = `Codex Buddy public plugin builder

Usage:
  build-public-plugin.mjs --output <new-directory> [--source-commit <sha>] [--json]

The destination must not exist and must be outside the source repository. The
builder materializes only allowlisted blobs from Git HEAD and creates an exact
release-manifest.json. Selected source paths must have no staged, modified,
untracked, or ignored changes, and --source-commit must equal HEAD when provided.
The builder never publishes or installs the artifact.
`;

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else {
    const result = await buildPublicPlugin(options);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n`
      : `Public plugin built and verified: ${result.artifact_root}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
