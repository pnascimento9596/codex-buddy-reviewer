import assert from 'node:assert/strict';
import test from 'node:test';
import { pathPolicy } from '../src/policy.mjs';

test('auth store and direnv basenames are denied by path policy', () => {
  for (const repoPath of [
    'auth.json', 'config/auth.json', 'auth.json.bak', '.envrc', 'app/.envrc',
    '.docker/config.json', 'docker/config.json', 'kubeconfig', 'deploy/prod-kubeconfig.yaml', 'prod_kubeconfig.yaml', 'kubeconfig_prod',
    'local.settings.json'
  ]) {
    const decision = pathPolicy(repoPath);
    assert.equal(decision.allowed, false, repoPath);
    assert.equal(typeof decision.reason, 'string');
  }
  // ordinary source remains allowed
  assert.equal(pathPolicy('src/index.mjs').allowed, true);
});
