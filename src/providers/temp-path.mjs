import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const TEMP_PARENT_PREFIX = 'codex-buddy-provider-v1-';

function stableUserKey() {
  if (typeof process.getuid === 'function') return `uid-${process.getuid()}`;
  return `user-${createHash('sha256')
    .update(`${os.homedir()}\0${os.userInfo().username}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function providerTempParent(tempBase = os.tmpdir()) {
  if (typeof tempBase !== 'string' || !path.isAbsolute(tempBase)) {
    throw new TypeError('Provider temporary base must be an absolute path');
  }
  return path.join(tempBase, `${TEMP_PARENT_PREFIX}${stableUserKey()}`);
}
