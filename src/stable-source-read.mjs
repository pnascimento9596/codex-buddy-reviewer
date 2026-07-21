import { lstat, open } from 'node:fs/promises';

const DEFAULT_MAX_BYTES = 1024 * 1024;

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function incomplete(reason) {
  return { status: 'incomplete', reason, bytes: null };
}

async function readBounded(handle, maximum) {
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset <= maximum) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maximum) return null;
  return bytes.subarray(0, offset);
}

/**
 * Read one privacy source without following a final-component symlink and
 * prove that the opened identity remained stable through the read.
 *
 * Errors are collapsed to privacy-safe reason codes. Callers must not include
 * the source path or the original exception in persisted diagnostics.
 */
export async function readStableRegularFile(file, options = {}) {
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAX_BYTES) {
    throw new TypeError('stable source byte limit must be between 1 byte and 1 MiB');
  }

  let beforePath;
  try {
    beforePath = await lstat(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT' && options.optional === true) {
      try {
        await lstat(file, { bigint: true });
      } catch (secondError) {
        if (secondError.code === 'ENOENT') return { status: 'absent', reason: null, bytes: null };
      }
      return incomplete('source_changed');
    }
    return incomplete('source_unreadable');
  }
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    return incomplete('source_type_unsupported');
  }
  if (beforePath.size > BigInt(maximum)) return incomplete('source_size_exceeded');

  let handle;
  try {
    handle = await open(file, 'r');
    const beforeHandle = await handle.stat({ bigint: true });
    if (!beforeHandle.isFile() || !sameIdentity(identity(beforePath), identity(beforeHandle))) {
      return incomplete('source_changed');
    }
    if (beforeHandle.size > BigInt(maximum)) return incomplete('source_size_exceeded');
    if (typeof options.afterOpen === 'function') await options.afterOpen();
    const bytes = await readBounded(handle, maximum);
    if (bytes === null) return incomplete('source_size_exceeded');
    options.budget?.chargeFileBytes(bytes.length);
    const afterHandle = await handle.stat({ bigint: true });
    let afterPath;
    try {
      afterPath = await lstat(file, { bigint: true });
    } catch {
      return incomplete('source_changed');
    }
    if (!afterPath.isFile()
        || !sameIdentity(identity(beforeHandle), identity(afterHandle))
        || !sameIdentity(identity(afterHandle), identity(afterPath))) {
      return incomplete('source_changed');
    }
    return { status: 'complete', reason: null, bytes };
  } catch {
    return incomplete('source_unreadable');
  } finally {
    await handle?.close().catch(() => {});
  }
}
