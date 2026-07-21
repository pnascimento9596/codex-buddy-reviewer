import { performance } from 'node:perf_hooks';

const DEFAULTS = Object.freeze({
  deadlineMs: 45_000,
  maxPaths: 50_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxGitBytes: 256 * 1024 * 1024,
  maxGitInputBytes: 256 * 1024 * 1024,
  maxObjectBytes: 128 * 1024 * 1024,
  maxGitOperations: 100_000
});

const SAFE_CODES = new Set([
  'capture_deadline_exceeded',
  'capture_path_limit_exceeded',
  'capture_file_bytes_exceeded',
  'capture_git_bytes_exceeded',
  'capture_git_input_exceeded',
  'capture_object_bytes_exceeded',
  'capture_git_operations_exceeded'
]);

export class CaptureBudgetError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError('invalid capture budget error code');
    super(code);
    this.name = 'CaptureBudgetError';
    this.code = code;
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

export class CaptureBudget {
  #startedAt;
  #limits;
  #usage;

  constructor(options = {}) {
    this.#startedAt = options.startedAt ?? performance.now();
    this.#limits = Object.freeze({
      deadlineMs: positiveInteger(options.deadlineMs ?? DEFAULTS.deadlineMs, 'deadlineMs'),
      maxPaths: positiveInteger(options.maxPaths ?? DEFAULTS.maxPaths, 'maxPaths'),
      maxFileBytes: positiveInteger(options.maxFileBytes ?? DEFAULTS.maxFileBytes, 'maxFileBytes'),
      maxGitBytes: positiveInteger(options.maxGitBytes ?? DEFAULTS.maxGitBytes, 'maxGitBytes'),
      maxGitInputBytes: positiveInteger(options.maxGitInputBytes ?? DEFAULTS.maxGitInputBytes, 'maxGitInputBytes'),
      maxObjectBytes: positiveInteger(options.maxObjectBytes ?? DEFAULTS.maxObjectBytes, 'maxObjectBytes'),
      maxGitOperations: positiveInteger(options.maxGitOperations ?? DEFAULTS.maxGitOperations, 'maxGitOperations')
    });
    this.#usage = {
      paths: 0,
      fileBytes: 0,
      gitBytes: 0,
      gitInputBytes: 0,
      objectBytes: 0,
      gitOperations: 0
    };
  }

  remainingMs(now = performance.now()) {
    const remaining = Math.floor(this.#limits.deadlineMs - (now - this.#startedAt));
    if (remaining < 1) throw new CaptureBudgetError('capture_deadline_exceeded');
    return remaining;
  }

  #charge(field, bytes, limitField, code) {
    this.remainingMs();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('capture charge must be a non-negative safe integer');
    this.#usage[field] += bytes;
    if (this.#usage[field] > this.#limits[limitField]) throw new CaptureBudgetError(code);
  }

  chargePaths(count) {
    this.#charge('paths', count, 'maxPaths', 'capture_path_limit_exceeded');
  }

  chargeFileBytes(bytes) {
    this.#charge('fileBytes', bytes, 'maxFileBytes', 'capture_file_bytes_exceeded');
  }

  chargeGitBytes(bytes) {
    this.#charge('gitBytes', bytes, 'maxGitBytes', 'capture_git_bytes_exceeded');
  }

  chargeGitInputBytes(bytes) {
    this.#charge('gitInputBytes', bytes, 'maxGitInputBytes', 'capture_git_input_exceeded');
  }

  chargeObjectBytes(bytes) {
    this.#charge('objectBytes', bytes, 'maxObjectBytes', 'capture_object_bytes_exceeded');
  }

  chargeGitOperation() {
    this.#charge('gitOperations', 1, 'maxGitOperations', 'capture_git_operations_exceeded');
  }

  snapshot() {
    return Object.freeze({
      elapsed_ms: Math.max(0, Math.floor(performance.now() - this.#startedAt)),
      ...this.#usage
    });
  }
}

export function captureFailureCode(error) {
  return error instanceof CaptureBudgetError ? error.code : null;
}
