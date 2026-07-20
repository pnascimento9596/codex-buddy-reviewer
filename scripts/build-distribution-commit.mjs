#!/usr/bin/env node

import {
  buildDistributionRepository,
  publicDistributionReceipt
} from './lib/distribution-commit.mjs';

function parse(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--artifact' || arg === '--output' || arg === '--policy-root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--artifact') options.artifact = value;
      else if (arg === '--output') options.output = value;
      else options.policyRoot = value;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown distribution commit argument: ${arg}`);
  }
  return options;
}

const help = `Codex Buddy artifact-only distribution commit builder

Usage:
  build-distribution-commit.mjs --artifact <verified-artifact-directory>
    --output <new-repository-directory> --policy-root <trusted-source-checkout>
    [--json]

The builder re-verifies the positive artifact against the trusted source HEAD,
applies bounded credential and personal-path checks, and creates a separate Git
repository with one parentless artifact commit plus one annotated version tag.
The commit tree is byte-identical to the artifact. Deterministic sanitized bot
metadata replaces ambient Git identity, and no source objects or history are
inherited. The new repository has no remote. This command never pushes, publishes,
changes repository visibility, or modifies the trusted source checkout.
`;

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else {
    const result = await buildDistributionRepository(options);
    process.stdout.write(options.json ? `${JSON.stringify(publicDistributionReceipt(result))}\n`
      : `Artifact-only distribution candidate built and verified: ${result.repository_root}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
