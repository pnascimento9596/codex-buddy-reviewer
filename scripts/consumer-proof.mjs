// Consumer-path proof: run the 40-finding no-loss shapes and the defect
// probes against a given codex-buddy-reviewer installation root.
const root = process.argv[2];
const { validateReviewResult } = await import(`${root}/src/result.mjs`);
const { aggregateReviewOutcomes } = await import(`${root}/src/review-aggregate.mjs`);
const { parseOpenCodeTransport } = await import(`${root}/src/providers/opencode.mjs`);
const { parseGrokTransport } = await import(`${root}/src/provider-contract.mjs`);

const finding = (i) => ({ severity: 'low', confidence: 0.99, title: `Finding ${i}`, body: 'Synthetic body.',
  impact: 'Synthetic impact.', path: 'src/app.js', line_side: 'new', line_start: 1, line_end: 1,
  evidence: 'Synthetic evidence.', recommendation: 'Synthetic recommendation.' });
const result40 = { schema_version: '2', status: 'findings', summary: 'Synthetic 40.',
  findings: Array.from({ length: 40 }, (_, i) => finding(i + 1)), comments: [] };
const evidence = { changed_paths: ['src/app.js'],
  path_evidence: [{ path: 'src/app.js', disposition: 'complete', transmitted: true, file_state: 'modified' }],
  hunk_ranges: { 'src/app.js': [{ start: 1, end: 1, side: 'new' }] },
  line_counts: { 'src/app.js': 1 }, old_line_counts: { 'src/app.js': 1 },
  incomplete_paths: [], excluded_paths: [], sensitive_change_count: 0, ignored_change_count: 0 };

const out = { root };
try {
  const validated = validateReviewResult(result40, evidence);
  const agg = aggregateReviewOutcomes([{ provider: 'ollama', model: 'glm-5.2:cloud', result: result40 }]);
  out.fortyFindingComplete = validated.findings.length === 40 && agg.reviews[0].result.findings.length === 40;
} catch (e) { out.fortyFindingComplete = `THREW: ${e.message}`; }
const review = JSON.stringify({ schema_version: '2', status: 'no_findings', summary: 'ok', findings: [], comments: [] });
try {
  parseOpenCodeTransport([
    JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 't', time: { start: 1, end: 2 } } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: review, time: { start: 1, end: 3 } } })
  ].join('\n'));
  out.reasoningTolerated = true;
} catch (e) { out.reasoningTolerated = `REJECTED: ${e.message}`; }
try {
  parseGrokTransport(JSON.stringify({ text: review, stopReason: 'end_turn', num_turns: 1 }));
  out.endTurnAccepted = true;
} catch (e) { out.endTurnAccepted = `REJECTED: ${e.message}`; }
console.log(JSON.stringify(out, null, 2));
