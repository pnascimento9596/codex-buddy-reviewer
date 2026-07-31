import { performance } from 'node:perf_hooks';

export const DEFAULT_CAPTURE_DEADLINE_MS = 180_000;
// Evidence capture can legitimately span hundreds of bounded Git and privacy
// operations. Responsive progress earns only the same eight 30-second graces
// used by provider process deadlines; a stalled capture cannot re-arm itself.
const CAPTURE_PROGRESS_REARM_GRACE_MS = 30_000;
const CAPTURE_PROGRESS_REARM_LIMIT = 8;

const DEFAULTS = Object.freeze({
  deadlineMs: DEFAULT_CAPTURE_DEADLINE_MS,
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
  #deadlineAt;
  #limits;
  #usage;
  #now;
  #progressRevision;
  #progressRevisionAtArm;
  #deadlineRearms;

  constructor(options = {}) {
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('capture monotonic clock must be callable');
    }
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = options.startedAt ?? this.#now();
    this.#limits = Object.freeze({
      deadlineMs: positiveInteger(options.deadlineMs ?? DEFAULTS.deadlineMs, 'deadlineMs'),
      maxPaths: positiveInteger(options.maxPaths ?? DEFAULTS.maxPaths, 'maxPaths'),
      maxFileBytes: positiveInteger(options.maxFileBytes ?? DEFAULTS.maxFileBytes, 'maxFileBytes'),
      maxGitBytes: positiveInteger(options.maxGitBytes ?? DEFAULTS.maxGitBytes, 'maxGitBytes'),
      maxGitInputBytes: positiveInteger(options.maxGitInputBytes ?? DEFAULTS.maxGitInputBytes, 'maxGitInputBytes'),
      maxObjectBytes: positiveInteger(options.maxObjectBytes ?? DEFAULTS.maxObjectBytes, 'maxObjectBytes'),
      maxGitOperations: positiveInteger(options.maxGitOperations ?? DEFAULTS.maxGitOperations, 'maxGitOperations')
    });
    this.#deadlineAt = this.#startedAt + this.#limits.deadlineMs;
    this.#progressRevision = 0;
    this.#progressRevisionAtArm = 0;
    this.#deadlineRearms = 0;
    this.#usage = {
      paths: 0,
      fileBytes: 0,
      gitBytes: 0,
      gitInputBytes: 0,
      objectBytes: 0,
      gitOperations: 0
    };
  }

  remainingMs(now = this.#now()) {
    let remaining = Math.floor(this.#deadlineAt - now);
    if (remaining < 1) {
      const responsiveProgress = this.#progressRevision > this.#progressRevisionAtArm;
      if (!responsiveProgress || this.#deadlineRearms >= CAPTURE_PROGRESS_REARM_LIMIT) {
        throw new CaptureBudgetError('capture_deadline_exceeded');
      }
      this.#deadlineRearms += 1;
      this.#progressRevisionAtArm = this.#progressRevision;
      this.#deadlineAt = now + Math.min(this.#limits.deadlineMs, CAPTURE_PROGRESS_REARM_GRACE_MS);
      remaining = Math.floor(this.#deadlineAt - now);
    }
    return Math.max(1, remaining);
  }

  #charge(field, bytes, limitField, code) {
    this.remainingMs();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('capture charge must be a non-negative safe integer');
    this.#usage[field] += bytes;
    if (this.#usage[field] > this.#limits[limitField]) throw new CaptureBudgetError(code);
    if (bytes > 0) this.#progressRevision += 1;
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
      elapsed_ms: Math.max(0, Math.floor(this.#now() - this.#startedAt)),
      ...this.#usage
    });
  }
}

export function captureFailureCode(error) {
  return error instanceof CaptureBudgetError ? error.code : null;
}
