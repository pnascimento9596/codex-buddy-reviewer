# Reviewer Evaluation

Buddy separates deterministic fixture validation from live model evaluation. CI
does not contact Grok, Ollama Cloud, or any other provider.

## Deterministic corpus

The corpus manifest at `evals/corpus/manifest.json` pins every case file and
patch by SHA-256. It contains one intentionally small case for each required
behavior:

| Category | Expected behavior |
|---|---|
| `clean` | Review completes without inventing a defect. |
| `defect` | The seeded changed-line defect is reported and grounded. |
| `abstain` | Incomplete evidence causes a local abstention and no egress. |
| `privacy` | Sensitive-only evidence remains aggregate-only and never reaches a provider. |
| `deletion` | A finding may use a synthetic new-side deletion anchor. |

Run the offline integrity gate with:

```sh
npm run eval:validate
```

The validator checks exact manifest fields, category coverage, path
containment, non-symlink fixture files, hashes and byte counts, evidence
anchors, and each case's provider-call policy. It imports no provider adapter.

Score a previously produced artifact without contacting a provider:

```sh
node scripts/buddy-eval.mjs score \
  --results /absolute/path/to/live-eval.json \
  --json
```

Scoring verifies the artifact covers every selected case/run exactly once,
respects required and forbidden provider calls, produces allowed statuses and
finding counts, and grounds findings to the fixture's transmitted paths and
anchors. It is an integrity and contract score, not a semantic benchmark or a
claim that a model is generally correct.

## Explicit live-provider runs

Live evaluation is deliberately opt-in and excluded from CI. Every run must pin
the provider, model, effort, cases, repetition count, timeout, exact provider
call count, prompt-byte ceiling, total time budget, confidence threshold, and a
new output path. The `live` action and `--live` acknowledgement are both
required.

Example for GLM 5.2 through Ollama Cloud:

```sh
node scripts/buddy-live-eval.mjs live --live \
  --provider ollama \
  --model glm-5.2:cloud \
  --effort high \
  --cases clean-extract-local,defect-reversed-subtraction,abstain-binary-omitted,privacy-sensitive-aggregate,deletion-auth-guard \
  --runs 1 \
  --timeout-seconds 480 \
  --max-calls 3 \
  --max-prompt-bytes 65536 \
  --max-total-seconds 1440 \
  --confidence 0.75 \
  --output /absolute/new/path/glm-5.2-eval.json
```

The runner makes exactly one attempt for each provider-eligible case/run. It
does not retry and does not fall back to another provider or model. Privacy and
abstention fixtures are handled locally and do not consume provider calls. The
output file must not already exist and is reserved before any provider call;
this prevents a late overwrite failure after evidence egress. Results record
provider/model identity and hashes of diagnostics rather than raw provider
stderr.

Grok uses the same contract with `--provider grok` and an explicitly selected
model. Its existing fail-closed isolation preflight remains in force. Do not
weaken provider isolation to obtain an evaluation result.

After a live run, score the artifact using the offline command above. A failed
provider attempt is recorded once and never retried. No live provider was called
as part of adding these tools.
