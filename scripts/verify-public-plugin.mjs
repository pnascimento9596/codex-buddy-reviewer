#!/usr/bin/env node

import { verifyPublicPlugin } from './lib/public-release.mjs';

function parse(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--input' || arg === '--policy-root' || arg === '--policy-config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--input') options.input = value;
      else if (arg === '--policy-root') options.policyRoot = value;
      else options.configFile = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown public verify argument: ${arg}`);
  }
  return options;
}

const help = `Codex Buddy public plugin verifier

Usage:
  verify-public-plugin.mjs --input <artifact-directory>
    [--policy-root <trusted-source-checkout>]
    [--policy-config <trusted-public-files.json>] [--json]

Verification derives the exact path, identity, version, and pet policy from the
trusted source checkout at the manifest's commit, then checks artifact hashes
and private-scope exclusion. It never installs the artifact. Run this script
from the trusted full source checkout, not from inside the artifact.
`;

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else {
    const result = await verifyPublicPlugin(options);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n`
      : `Public plugin verified: ${result.artifact_root}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
