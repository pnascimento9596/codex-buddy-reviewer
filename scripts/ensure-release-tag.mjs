#!/usr/bin/env node

/**
 * Ensure the remote annotated release tag equals the distribution receipt's
 * tag_object. Performs the only remote tag mutation (git push of the exact
 * local tag ref) and post-push consistency reads with bounded backoff.
 *
 * Does not create GitHub Releases. Does not move or delete tags.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_POST_PUSH_BACKOFF_MS,
  ensureRemoteTagMatches,
  isSha1
} from './lib/release-tag-publish.mjs';

const scriptName = path.basename(fileURLToPath(import.meta.url));

function parse(argv) {
  const options = {
    json: false,
    postPushBackoffMs: [...DEFAULT_POST_PUSH_BACKOFF_MS]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--repository') options.repository = take();
    else if (arg === '--tag') options.tag = take();
    else if (arg === '--tag-ref') options.tagRef = take();
    else if (arg === '--expected-tag-object') options.expectedTagObject = take();
    else if (arg === '--receipt') options.receipt = take();
    else if (arg === '--local-repository') options.localRepository = take();
    else if (arg === '--github-server-url') options.githubServerUrl = take();
    else if (arg === '--post-push-backoff-ms') {
      options.postPushBackoffMs = take().split(',').map((part) => {
        const ms = Number(part);
        if (!Number.isInteger(ms) || ms < 0) throw new Error('invalid --post-push-backoff-ms list');
        return ms;
      });
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const help = `Codex Buddy release tag ensure

Usage:
  ${scriptName} --repository <owner/name> --tag <vX.Y.Z> --tag-ref <refs/tags/vX.Y.Z>
    --local-repository <distribution-checkout> --expected-tag-object <sha1>
    [--receipt <distribution.json>] [--github-server-url <url>]
    [--post-push-backoff-ms 200,400,800,1600,3200] [--json]

Looks up the remote annotated tag, reuses it when it already equals the receipt
tag_object, pushes the exact local tag ref when proven absent, and verifies the
remote object with bounded backoff after push. Never force-pushes or deletes.
`;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code === null ? 1 : code, stdout, stderr });
    });
  });
}

function loadExpectedTagObject(options) {
  if (options.expectedTagObject) {
    if (!isSha1(options.expectedTagObject)) {
      throw new Error('--expected-tag-object must be a 40-character lowercase SHA-1');
    }
    return options.expectedTagObject;
  }
  if (!options.receipt) throw new Error('either --expected-tag-object or --receipt is required');
  const receipt = JSON.parse(readFileSync(options.receipt, 'utf8'));
  if (!isSha1(receipt.tag_object)) throw new Error('receipt.tag_object is not a valid SHA-1');
  if (options.tag && receipt.tag !== options.tag) {
    throw new Error('receipt.tag does not match --tag');
  }
  if (options.tagRef && receipt.tag_ref !== options.tagRef) {
    throw new Error('receipt.tag_ref does not match --tag-ref');
  }
  return receipt.tag_object;
}

async function lookupRemoteTag({ repository, tag }) {
  // Prefer structured JSON so annotated-tag object identity is distinct from a
  // peeled commit. Fall back classification still accepts bare SHA stdout.
  const result = await run('gh', [
    'api',
    `repos/${repository}/git/ref/tags/${tag}`,
    '--jq',
    '{sha:.object.sha,type:.object.type}'
  ]);

  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      return {
        exitCode: 0,
        stdout: typeof parsed.sha === 'string' ? parsed.sha : '',
        objectType: typeof parsed.type === 'string' ? parsed.type : null
      };
    } catch {
      return { exitCode: 1, stdout: result.stdout, objectType: null };
    }
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout || result.stderr,
    objectType: null
  };
}

async function pushLocalTag({ localRepository, tagRef, repository, githubServerUrl }) {
  const server = githubServerUrl || process.env.GITHUB_SERVER_URL || 'https://github.com';
  const remoteUrl = `${server.replace(/\/$/u, '')}/${repository}.git`;

  const auth = await run('gh', ['auth', 'setup-git']);
  if (auth.exitCode !== 0) {
    return {
      exitCode: auth.exitCode,
      stdout: auth.stdout,
      stderr: auth.stderr || 'gh auth setup-git failed\n'
    };
  }

  // Replace any prior origin so reruns are deterministic.
  await run('git', ['remote', 'remove', 'origin'], { cwd: localRepository });
  const add = await run('git', ['remote', 'add', 'origin', remoteUrl], { cwd: localRepository });
  if (add.exitCode !== 0) {
    // remote add can fail if remove was a no-op and origin still exists with same URL; try set-url
    const setUrl = await run('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: localRepository });
    if (setUrl.exitCode !== 0) {
      return {
        exitCode: setUrl.exitCode,
        stdout: `${add.stdout}${setUrl.stdout}`,
        stderr: `${add.stderr}${setUrl.stderr}`
      };
    }
  }

  return run('git', ['push', '--porcelain', 'origin', `${tagRef}:${tagRef}`], {
    cwd: localRepository
  });
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
  } else {
    if (!options.repository) throw new Error('--repository is required');
    if (!options.tag) throw new Error('--tag is required');
    if (!options.tagRef) throw new Error('--tag-ref is required');
    if (!options.localRepository) throw new Error('--local-repository is required');
    if (!options.tagRef.startsWith('refs/tags/')) {
      throw new Error('--tag-ref must start with refs/tags/');
    }
    if (options.tagRef !== `refs/tags/${options.tag}`) {
      throw new Error('--tag-ref must equal refs/tags/<tag>');
    }

    const expectedTagObject = loadExpectedTagObject(options);
    const localTag = await run('git', ['rev-parse', options.tagRef], {
      cwd: options.localRepository
    });
    if (localTag.exitCode !== 0 || localTag.stdout.trim() !== expectedTagObject) {
      throw new Error('local distribution tag object does not match the expected receipt tag_object');
    }

    const result = await ensureRemoteTagMatches({
      expectedTagObject,
      lookup: () => lookupRemoteTag({ repository: options.repository, tag: options.tag }),
      push: () => pushLocalTag({
        localRepository: options.localRepository,
        tagRef: options.tagRef,
        repository: options.repository,
        githubServerUrl: options.githubServerUrl
      }),
      postPushBackoffMs: options.postPushBackoffMs
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        tag: options.tag,
        tag_ref: options.tagRef,
        expected_tag_object: expectedTagObject,
        ...result
      })}\n`);
    } else {
      process.stdout.write(
        `Release tag ${options.tag} ensured (${result.outcome}); object ${result.remoteSha}\n`
      );
    }
  }
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
