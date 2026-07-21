import { escapeTerminalControls } from './policy.mjs';

export const MAX_VISIBLE_REVIEW_CHARS = 700;
export const MAX_VISIBLE_REVIEW_SENTENCES = 3;

function safeText(value) {
  return escapeTerminalControls(String(value ?? ''))
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\u2014', ',')
    .replaceAll('\u2013', '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstSentence(value, maximum) {
  const safe = safeText(value).split(/(?<=[.!?])\s+/u, 1)[0].replace(/[.!?]+$/u, '').trim();
  if (safe.length <= maximum) return safe;
  return `${safe.slice(0, Math.max(0, maximum - 1)).trimEnd()}\u2026`;
}

function location(item) {
  const path = firstSentence(item?.path, 180);
  if (!path) return 'the captured change set';
  return Number.isInteger(item?.line_start) ? `${path}:${item.line_start}` : path;
}

function sentence(value) {
  const safe = safeText(value).replace(/[.!?]+$/u, '').trim();
  return safe ? `${safe}.` : null;
}

function supportedByBoth(output, kind, index) {
  const source = output?.sources?.[kind]?.find((item) => item.aggregate_index === index);
  return Array.isArray(source?.review_indices) && source.review_indices.length > 1;
}

function operationalWarning(output) {
  return (output?.reviews ?? []).some((review) => review?.run?.cleanup_status === 'failed');
}

function summaryQualifier(output) {
  const advisory = output?.summaryAdvisory;
  if (advisory?.status !== 'notes' || !Array.isArray(advisory.notes) || advisory.notes.length === 0) {
    return null;
  }
  const note = advisory.notes[0];
  return sentence(`Summary check: ${firstSentence(note.advice, 155)}`);
}

function finalQualifier(output, result, primaryKind = null, primaryIndex = null) {
  if (operationalWarning(output)) {
    return sentence('A reviewer completed, but cleanup of its private temporary state failed; inspect the private receipt');
  }
  const failures = Array.isArray(output?.failures) ? output.failures.length : 0;
  if (failures > 0) {
    return sentence('One configured reviewer connection did not complete, so this is a partial review');
  }
  if (primaryKind && supportedByBoth(output, primaryKind, primaryIndex)) {
    return sentence('Both configured reviewers independently supported this item');
  }
  const comment = result.comments?.[0];
  if (primaryKind !== 'comments' && comment) {
    return sentence(
      `Optimization: ${firstSentence(comment.title, 90)} at ${location(comment)}; ${firstSentence(comment.recommendation, 95)}`
    );
  }
  return summaryQualifier(output);
}

function sentencesFor(output) {
  const result = output?.result;
  if (!result || !['findings', 'no_findings', 'abstain'].includes(result.status)) {
    return [sentence('Buddy review could not produce a validated result')];
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const comments = Array.isArray(result.comments) ? result.comments : [];
  if (result.status === 'findings' && findings.length > 0) {
    const item = findings[0];
    const count = findings.length === 1 ? 'one validated issue' : `${findings.length} validated issues`;
    return [
      sentence(
        `Buddy review found ${count}; highest priority is ${safeText(item.severity)} severity: ${firstSentence(item.title, 145)} at ${location(item)}`
      ),
      sentence(`Recommended action: ${firstSentence(item.recommendation, 205)}`),
      finalQualifier(output, { ...result, comments }, 'findings', 0)
    ];
  }
  if (result.status === 'abstain') {
    return [
      sentence('Buddy review abstained because the captured evidence did not support a grounded conclusion'),
      sentence(firstSentence(result.summary, 210)),
      finalQualifier(output, { ...result, comments })
    ];
  }
  const primaryComment = comments[0];
  return [
    sentence('Buddy review found no actionable correctness defect above the configured confidence threshold'),
    primaryComment
      ? sentence(
          `Suggestion: ${firstSentence(primaryComment.title, 110)} at ${location(primaryComment)}; ${firstSentence(primaryComment.recommendation, 145)}`
        )
      : null,
    finalQualifier(output, { ...result, comments }, primaryComment ? 'comments' : null, primaryComment ? 0 : null)
  ];
}

export function visibleReviewParagraph(output) {
  const sentences = sentencesFor(output).filter(Boolean).slice(0, MAX_VISIBLE_REVIEW_SENTENCES);
  let paragraph = sentences.join(' ');
  if (paragraph.length > MAX_VISIBLE_REVIEW_CHARS) {
    paragraph = `${paragraph.slice(0, MAX_VISIBLE_REVIEW_CHARS - 1).trimEnd()}\u2026`;
  }
  if (!paragraph || paragraph.includes('\n') || paragraph.includes('\r')) {
    throw new Error('Buddy visible review must be one non-empty paragraph');
  }
  return paragraph;
}
