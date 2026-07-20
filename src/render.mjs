const SEVERITY_LABEL = {
  blocker: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3'
};

function appendField(lines, label, value) {
  const parts = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  lines.push(`${label}: ${parts[0]}`);
  for (const continuation of parts.slice(1)) lines.push(`  | ${continuation}`);
}

function appendHeading(lines, prefix, value) {
  const parts = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  lines.push(`${prefix}${parts[0]}`);
  for (const continuation of parts.slice(1)) lines.push(`  | ${continuation}`);
}

export function renderHuman({ evidence, result, provider, model, receiptDir, run = null }) {
  const lines = [
    `Buddy review · ${provider}/${model}`,
    `Status: ${result.status} · patch ${evidence.patch_hash.slice(0, 12)} · ${evidence.changed_paths.length} changed path(s)`,
  ];
  appendField(lines, 'Summary', result.summary);

  for (const finding of result.findings) {
    lines.push('');
    appendHeading(lines, `[${SEVERITY_LABEL[finding.severity]} · ${(finding.confidence * 100).toFixed(0)}%] `, finding.title);
    lines.push(`${finding.path}:${finding.line_side === 'old' ? 'old:' : ''}${finding.line_start}`);
    appendField(lines, 'Body', finding.body);
    appendField(lines, 'Impact', finding.impact);
    appendField(lines, 'Evidence', finding.evidence);
    appendField(lines, 'Recommendation', finding.recommendation);
  }

  for (const comment of result.comments ?? []) {
    lines.push('');
    appendHeading(lines, `[${comment.category} · ${(comment.confidence * 100).toFixed(0)}%] `, comment.title);
    lines.push(`${comment.path}:${comment.line_side === 'old' ? 'old:' : ''}${comment.line_start}`);
    appendField(lines, 'Body', comment.body);
    appendField(lines, 'Evidence', comment.evidence);
    appendField(lines, 'Recommendation', comment.recommendation);
  }

  const excludedCount = evidence.excluded_paths.length
    + (evidence.sensitive_change_count ?? 0)
    + (evidence.ignored_change_count ?? 0);
  if (excludedCount) {
    lines.push('');
    lines.push(`Privacy policy excluded ${excludedCount} path(s); their contents were not sent.`);
  }
  if (evidence.truncated) {
    lines.push('The review patch was truncated; treat no-findings as lower confidence.');
  }
  if (evidence.incomplete_paths.length) {
    lines.push(`Evidence was incomplete for ${evidence.incomplete_paths.length} allowlisted path(s).`);
  }
  if (run?.cleanup_status === 'failed') {
    lines.push('Warning: the reviewer completed, but its private temporary-state cleanup failed. Inspect the private receipt and local temporary storage before sharing diagnostics.');
  }
  if (receiptDir) lines.push(`Receipt: ${receiptDir}`);
  return `${lines.join('\n')}\n`;
}
