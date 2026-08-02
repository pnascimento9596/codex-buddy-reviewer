import assert from 'node:assert/strict';

export const EXCLUSIVE_AUTHORSHIP_PATTERNS = Object.freeze([
  /\b(?:I|we|you|Buddy|(?:the\s+)?worker(?: agent)?|(?:the\s+)?coding agent|(?:the\s+)?agent|(?:the\s+)?user|(?:the\s+)?reviewer)\s+(?:made|wrote|authored|implemented|created|added|changed|modified|updated|fixed|removed|deleted|renamed|moved|refactored|committed)\b/iu,
  /\b(?:my|our|your|Buddy['’]s|(?:the\s+)?worker(?: agent)?['’]s|(?:the\s+)?coding agent['’]s|(?:the\s+)?agent['’]s|(?:the\s+)?user['’]s|(?:the\s+)?reviewer['’]s)\s+(?:changes?|code|implementation|work|patch|diff|commits?|files?|bytes?)\b/iu,
  /\b(?:changes?|code|implementation|work|patch|diff|commits?|files?|bytes?)\s+(?:that\s+)?(?:I|we|you|Buddy|(?:the\s+)?worker(?: agent)?|(?:the\s+)?coding agent|(?:the\s+)?agent|(?:the\s+)?user|(?:the\s+)?reviewer)\s+(?:made|wrote|authored|implemented|created|added|changed|modified|updated|fixed|removed|deleted|renamed|moved|refactored|committed)\b/iu,
  /\b(?:authored|written|implemented|created|changed|modified|fixed|added|removed|deleted|renamed|moved|refactored|committed)\s+(?:(?:entirely|exclusively|solely)\s+)?by\s+(?:me|us|you|Buddy|the worker(?: agent)?|the coding agent|the agent|the user|the reviewer)\b/iu
]);

export function assertNoExclusiveAuthorship(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pattern of EXCLUSIVE_AUTHORSHIP_PATTERNS) assert.doesNotMatch(text, pattern);
}
