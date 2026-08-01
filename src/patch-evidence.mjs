import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseChangedLineRanges(patchText, options = {}) {
  const deletedFile = options.fileState === 'deleted';
  const lines = patchText.split('\n');
  const changed = [];
  let oldLine = null;
  let newLine = null;
  let hunkAnchor = null;
  let hunkAdded = false;
  let hunkDeleted = false;
  let sawHunk = false;
  const synthetic = [];
  const finishHunk = () => {
    if (!deletedFile && hunkAnchor !== null && hunkDeleted && !hunkAdded) {
      synthetic.push({ start: Math.max(1, hunkAnchor), end: Math.max(1, hunkAnchor), kind: 'deletion' });
    }
  };
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      finishHunk();
      sawHunk = true;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunkAnchor = newLine;
      hunkAdded = false;
      hunkDeleted = false;
      continue;
    }
    if (oldLine === null || newLine === null) continue;
    if (line.startsWith('+')) {
      if (!deletedFile) changed.push(newLine);
      hunkAdded = true;
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (deletedFile) changed.push(oldLine);
      hunkDeleted = true;
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  if (!deletedFile) finishHunk();

  const ranges = [];
  for (const line of changed) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line, ...(deletedFile ? { side: 'old' } : {}) });
  }
  if (!sawHunk && patchText.trim()) {
    synthetic.push({ start: 1, end: 1, kind: 'metadata' });
  }
  return [...ranges, ...synthetic].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function applyPatchBudget(entries, maxPatchBytes) {
  const selected = [];
  const pathEvidence = [];
  const hunkRanges = {};
  let usedBytes = 0;

  for (const original of entries) {
    const patchBytes = Buffer.byteLength(original.patch, 'utf8');
    let disposition = original.disposition;
    let transmitted = disposition === 'complete';
    if (!transmitted) {
      // Keep only local metadata for incomplete/non-file evidence. Raw Git
      // patches can contain symlink targets or other material we promised not
      // to transmit for an omitted path.
    } else if (usedBytes + patchBytes > maxPatchBytes) {
      disposition = 'patch_truncated';
      transmitted = false;
    } else {
      selected.push(original.patch);
      usedBytes += patchBytes;
    }
    const ranges = transmitted && disposition === 'complete'
      ? parseChangedLineRanges(original.patch, { fileState: original.fileState })
      : [];
    hunkRanges[original.path] = ranges;
    pathEvidence.push({
      path: original.path,
      disposition,
      patch_bytes: patchBytes,
      transmitted,
      hunk_ranges: ranges,
      ...(original.fileState === 'deleted' ? {
        file_state: 'deleted',
        old_line_count: original.oldLineCount
      } : {})
    });
  }

  const patch = selected.filter(Boolean).join('\n');
  return {
    patch,
    patchHash: sha256(patch),
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    pathEvidence,
    hunkRanges,
    incompletePaths: pathEvidence.filter((item) => item.disposition !== 'complete').map((item) => item.path),
    truncated: pathEvidence.some((item) => item.disposition === 'patch_truncated')
  };
}
