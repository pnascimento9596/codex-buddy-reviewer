export const REVIEW_SCHEMA_VERSION = '2';

const GROUNDED_COMMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'category',
    'confidence',
    'title',
    'body',
    'path',
    'line_side',
    'line_start',
    'line_end',
    'evidence',
    'recommendation'
  ],
  properties: {
    category: { enum: ['optimization', 'reliability', 'maintainability', 'testing'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 160 },
    body: { type: 'string', minLength: 1, maxLength: 1600 },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    line_side: { enum: ['new', 'old'] },
    line_start: { type: 'integer', minimum: 1 },
    line_end: { type: 'integer', minimum: 1 },
    evidence: { type: 'string', minLength: 1, maxLength: 1600 },
    recommendation: { type: 'string', minLength: 1, maxLength: 1600 }
  }
};

export const REVIEW_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'summary', 'findings'],
  properties: {
    schema_version: { const: REVIEW_SCHEMA_VERSION },
    status: { enum: ['findings', 'no_findings', 'abstain'] },
    summary: { type: 'string', minLength: 1, maxLength: 1200 },
    findings: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'confidence',
          'title',
          'body',
          'impact',
          'path',
          'line_side',
          'line_start',
          'line_end',
          'evidence',
          'recommendation'
        ],
        properties: {
          severity: { enum: ['blocker', 'high', 'medium', 'low'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 160 },
          body: { type: 'string', minLength: 1, maxLength: 2000 },
          impact: { type: 'string', minLength: 1, maxLength: 1000 },
          path: { type: 'string', minLength: 1, maxLength: 500 },
          line_side: { enum: ['new', 'old'] },
          line_start: { type: 'integer', minimum: 1 },
          line_end: { type: 'integer', minimum: 1 },
          evidence: { type: 'string', minLength: 1, maxLength: 1600 },
          recommendation: { type: 'string', minLength: 1, maxLength: 1600 }
        }
      }
    },
    comments: {
      type: 'array',
      maxItems: 3,
      items: GROUNDED_COMMENT_SCHEMA
    }
  }
};

export const SUMMARY_CLAIM_ADVISORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'advisory', 'notes'],
  properties: {
    schema_version: { const: '1' },
    status: { enum: ['notes', 'no_notes', 'abstain'] },
    advisory: { type: 'string', minLength: 1, maxLength: 800 },
    notes: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'category',
          'confidence',
          'summary_start',
          'summary_end',
          'quote',
          'advice'
        ],
        properties: {
          category: {
            enum: ['unsupported_claim', 'missing_verification', 'overstatement', 'scope_ambiguity']
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          summary_start: { type: 'integer', minimum: 0 },
          summary_end: { type: 'integer', minimum: 1 },
          quote: { type: 'string', minLength: 1, maxLength: 600 },
          advice: { type: 'string', minLength: 1, maxLength: 800 }
        }
      }
    }
  }
};

export const REVIEW_WITH_SUMMARY_ADVISORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['technical_review', 'summary_advisory'],
  properties: {
    technical_review: REVIEW_RESULT_SCHEMA,
    summary_advisory: SUMMARY_CLAIM_ADVISORY_SCHEMA
  }
};

export function validateReviewWithSummaryAdvisoryEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('review-with-summary response must be an object');
  }
  const actual = Object.keys(raw).sort();
  const expected = ['summary_advisory', 'technical_review'];
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error('review-with-summary response must contain exactly technical_review and summary_advisory');
  }
  return raw;
}
