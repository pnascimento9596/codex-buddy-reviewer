import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalJson,
  ensurePrivateStatePath,
  readPrivateJson,
  writePrivateJsonExclusive
} from './state.mjs';

const TRANSACTION_ID_PATTERN = /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STEP_FILES = Object.freeze({
  intent: '00-intent.json',
  filesystem_committed: '10-filesystem-committed.json',
  registry_committed: '20-registry-committed.json',
  complete: '30-complete.json'
});
const STEP_ORDER = Object.freeze(Object.keys(STEP_FILES));

function transactionFailure(message) {
  throw new Error(`Buddy pet transaction: ${message}`);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    transactionFailure(`${label} must be an object`);
  }
}

function assertTransactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    transactionFailure('invalid transaction id');
  }
}

function transactionsRoot(homeDataDir) {
  return path.join(homeDataDir, 'transactions');
}

function transactionDirectory(homeDataDir, transactionId) {
  assertTransactionId(transactionId);
  return path.join(transactionsRoot(homeDataDir), transactionId);
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function stepRecord(transactionId, step, payload) {
  return {
    schema_version: '1',
    transaction_id: transactionId,
    step,
    recorded_at: new Date().toISOString(),
    payload
  };
}

function validateStepRecord(record, transactionId, step) {
  assertPlainObject(record, `${step} step`);
  if (record.schema_version !== '1') transactionFailure(`${step} step has an unsupported schema`);
  if (record.transaction_id !== transactionId) transactionFailure(`${step} step transaction id does not match`);
  if (record.step !== step) transactionFailure(`${step} step name does not match`);
  if (typeof record.recorded_at !== 'string' || !Number.isFinite(Date.parse(record.recorded_at))) {
    transactionFailure(`${step} step has an invalid recorded_at`);
  }
  assertPlainObject(record.payload, `${step} step payload`);
  return record;
}

async function readStep(directory, transactionId, step) {
  const file = path.join(directory, STEP_FILES[step]);
  const value = await readPrivateJson(file);
  return value === null ? null : validateStepRecord(value, transactionId, step);
}

export async function beginPetTransaction({ homeDataDir, intent, transactionId }) {
  assertPlainObject(intent, 'intent');
  const id = transactionId ?? `${Date.now()}-${randomUUID()}`;
  assertTransactionId(id);
  const root = transactionsRoot(homeDataDir);
  const directory = transactionDirectory(homeDataDir, id);
  await ensurePrivateStatePath(homeDataDir, directory);
  const transaction = { id, directory, homeDataDir, intent, steps: {} };
  await recordPetTransactionStep(transaction, 'intent', { intent });
  transaction.steps.intent = await readStep(directory, id, 'intent');
  return transaction;
}

export async function recordPetTransactionStep(transaction, step, payload = {}) {
  if (!STEP_ORDER.includes(step)) transactionFailure(`unknown step ${String(step)}`);
  assertTransactionId(transaction?.id);
  assertPlainObject(payload, `${step} payload`);
  const expectedDirectory = transactionDirectory(transaction.homeDataDir, transaction.id);
  if (path.resolve(transaction.directory) !== expectedDirectory) {
    transactionFailure('transaction directory does not match its home scope');
  }
  await ensurePrivateStatePath(transaction.homeDataDir, transaction.directory);

  if (step !== 'intent') {
    const intent = await readStep(transaction.directory, transaction.id, 'intent');
    if (!intent) transactionFailure(`cannot write ${step} before intent`);
  }
  if (step === 'registry_committed') {
    const filesystem = await readStep(transaction.directory, transaction.id, 'filesystem_committed');
    if (!filesystem) transactionFailure('cannot write registry_committed before filesystem_committed');
  }
  if (step === 'complete' && payload.outcome === 'complete') {
    const registry = await readStep(transaction.directory, transaction.id, 'registry_committed');
    if (!registry) transactionFailure('cannot complete a committed transaction before registry_committed');
  }

  const file = path.join(transaction.directory, STEP_FILES[step]);
  const record = stepRecord(transaction.id, step, payload);
  const written = await writePrivateJsonExclusive(file, record);
  if (written) return record;

  const existing = await readStep(transaction.directory, transaction.id, step);
  if (!existing || canonicalJson(existing.payload) !== canonicalJson(payload)) {
    transactionFailure(`${step} is immutable and already contains different data`);
  }
  return existing;
}

async function readTransaction(homeDataDir, entry) {
  if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name)) {
    return {
      id: entry.name,
      directory: path.join(transactionsRoot(homeDataDir), entry.name),
      homeDataDir,
      valid: false,
      status: 'needs_attention',
      reason: 'unexpected transaction entry'
    };
  }
  const directory = transactionDirectory(homeDataDir, entry.name);
  try {
    const details = await detailsOrNull(directory);
    if (!details || details.isSymbolicLink() || !details.isDirectory()) {
      transactionFailure('transaction path must be a non-symlink directory');
    }
    const names = (await readdir(directory)).sort();
    const unexpected = names.filter((name) => !Object.values(STEP_FILES).includes(name));
    if (unexpected.length) transactionFailure('transaction directory contains unexpected entries');
    const steps = {};
    for (const step of STEP_ORDER) steps[step] = await readStep(directory, entry.name, step);
    if (!steps.intent) transactionFailure('transaction is missing its intent step');
    const outcome = steps.complete?.payload?.outcome ?? null;
    return {
      id: entry.name,
      directory,
      homeDataDir,
      intent: steps.intent.payload.intent,
      steps,
      valid: true,
      status: outcome ?? 'pending'
    };
  } catch (error) {
    return {
      id: entry.name,
      directory,
      homeDataDir,
      valid: false,
      status: 'needs_attention',
      reason: error.message
    };
  }
}

export async function readPetTransactions({ homeDataDir }) {
  const root = transactionsRoot(homeDataDir);
  await ensurePrivateStatePath(homeDataDir, root);
  const entries = await readdir(root, { withFileTypes: true });
  const transactions = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    transactions.push(await readTransaction(homeDataDir, entry));
  }
  return transactions;
}

export const PET_TRANSACTION_STEP_FILES = STEP_FILES;
