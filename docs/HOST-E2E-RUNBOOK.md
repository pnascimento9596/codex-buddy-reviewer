# Codex Host Evidence v2 Runbook

Host evidence v2 is the installed-host acceptance subsystem for a public Buddy
release. It binds one host attempt to the exact public artifact, source commit,
installed plugin snapshot, public pet package, workspace, turn receipt, renderer
outbox event, and observed Stop continuation. A separate human attestation layer
covers facts that filesystem automation cannot establish.

The v2 report is strict and independent. There is no blank template and v1
reports are not accepted. `collect` is the only supported way to create a
report; it derives machine evidence rather than accepting operator-written
claims.

## Acceptance boundary

Machine collection proves all of the following from local, hash-bound data:

- the release manifest names a 40-character source commit and exactly describes
  the public artifact path set and bytes;
- the installed plugin snapshot has exactly the same paths and bytes as that
  artifact, including the plugin manifest, hooks, and release manifest;
- the selected pet is public in the release catalog and its installed
  `pet.json` and `spritesheet.webp` match the catalog hashes;
- the workspace key is derived from the canonical acceptance repository path;
- the hashed session and turn route to an observed `completed.json` record, a
  successful provider-backed changed-turn receipt, and exactly one matching
  `review_completed` outbox event;
- receipt, outbox, and observed-continuation timestamps fall inside the stated
  host-run window.

Machine collection does **not** prove any of these operator-visible facts:

- `/buddy-review` appeared in the host command menu;
- invoking `/buddy-review` with no arguments visibly toggled the intended mode;
- the operator completed the host hook-trust prompt;
- the continued Stop visibly combined the worker and Buddy review;
- the host did not visibly enter a second Stop continuation loop;
- the native pet was visible or moved through Ready and Running states.

Those claims must remain `manual_pass`, `manual_fail`, or `pending`. Never turn
them into an ordinary automated `pass` based only on receipts, state files, or
renderer events.

Machine collection binds the aggregate completed review. The underlying private
receipt and v2 completed event also carry the ordered configured reviewer
outcomes, including provider/model attribution and any partial failure or open
circuit. Adapter unit and lifecycle tests validate that deeper contract. Do not
infer that both lanes succeeded merely because a dual-review aggregate completed
successfully; one successful lane is an accepted partial result and no fallback
is used.

## Prepare the installed attempt

Use a newly built and verified public artifact, then install that exact artifact
without editing it. Keep the artifact directory and the installed plugin
snapshot until acceptance is complete. Also install one public pet package from
that artifact into `<codex-home>/pets/<pet-id>`.

Before starting the host interaction, record:

- an absolute path to the disposable acceptance repository;
- the host session ID and turn ID used by the hook runtime;
- the absolute `PLUGIN_DATA` directory for the installed plugin;
- the absolute Codex home containing the installed pet;
- a private task reference, which should not contain task text or secrets;
- a canonical UTC start time such as `2026-07-18T12:00:00.000Z`.

Also record the intended primary and optional secondary reviewer configuration
in the private operator notes. A representative dual-review profile can use a
direct Claude or Grok subscription as one lane and an OpenCode or Ollama
connection as the other. Host acceptance does not authorize new connections or
prove account eligibility; configure and health-check those connections before
the timed host run.

The report contains hashed workspace, session, and turn identities, not the raw
paths or host IDs. It may still contain private operational metadata, so store
it outside the public artifact and repository when appropriate.

## Exercise the real host

Use a fresh Codex task and make one small, reviewable repository change:

1. Confirm `/buddy-review` is discoverable in the command menu.
2. Invoke `/buddy-review` with no arguments and confirm the visible mode toggle.
3. Open `/pet`, select the public pet being tested, and confirm it is visible and
   Ready before the turn.
4. Complete the installed hook's trust prompt.
5. Ask Codex to make the small change. Confirm the pet visibly enters Running
   while the worker is active.
6. Let Buddy review the changed turn. Confirm the pet remains visibly Running
   during the review.
7. Confirm one continued Stop visibly presents the worker result and Buddy
   review together. For a dual-review profile, confirm the transcript preserves
   provider/model attribution and does not present a failed lane as successful.
8. Confirm that continued Stop does not cause a second review or continuation
   loop.
9. Confirm the pet visibly returns to Ready after completion.

Record the observer name, observation time, and concise notes while the run is
fresh. Observation times must be canonical UTC timestamps inside the interval
from `--started-at` through report collection.

## Collect machine evidence

Run collection only after the continued Stop has been observed and its runtime
files are durable. Collect all five reports before the 24-hour private recovery
window closes. A later Buddy prune or explicit workspace purge can remove the
content-bearing receipts required by the collector:

```sh
node scripts/verify-host-e2e.mjs collect \
  --artifact /absolute/path/to/public-artifact \
  --installed-snapshot /absolute/path/to/installed-plugin \
  --workspace /absolute/path/to/acceptance-repository \
  --runtime-data-dir /absolute/path/to/plugin-data \
  --codex-home /absolute/path/to/codex-home \
  --pet-id buddy-byte \
  --session-id 'exact-host-session-id' \
  --turn-id 'exact-host-turn-id' \
  --task-reference 'private-host-task-1' \
  --started-at '2026-07-18T12:00:00.000Z' \
  --output /absolute/new/path/buddy-host-evidence-v2.json \
  --json
```

Collection is local-only and does not invoke a model or contact a provider. It
refuses to overwrite an existing report and creates a mode-0600 file. A malformed
or unhashable release anchor stops collection. Evidence downstream of a valid
release is recorded as a bounded machine failure code, never as operator prose
or a manufactured pass.

Exit status 0 from `collect` means every machine check passed. Manual gates are
still pending, so it does not mean host acceptance is complete. Exit status 2
means a machine check failed or collection could not establish a valid release
anchor.

For a dual-review attempt, separately inspect the private receipt's ordered
`reviewer_runs` and the completed event's ordered `payload.reviews` before
discarding runtime state. They must name only the configured connections, use
contiguous primary-then-secondary source indexes, and agree on each lane's
`succeeded`, `failed`, or `circuit_open` status. This is diagnostic evidence for
the feature review. It does not replace any required machine or human gate in
the strict host report schema.

## Add human attestations

Edit only `manual_host_gates` and `manual_visual_gates` in the collected report.
Do not edit the release, installation, workspace, pet, turn, run, machine-check,
or machine-digest fields.

For a resolved manual gate, use this shape:

```json
{
  "status": "manual_pass",
  "observer": "Operator name",
  "observed_at": "2026-07-18T12:04:30.000Z",
  "notes": "Concise description of what was directly observed."
}
```

Use `manual_fail` when the behavior was directly observed to fail. Leave
`pending` with `observer` and `observed_at` set to `null` when it was not
observed. Notes and observer fields must be terminal-safe and bounded; do not
paste terminal output, task content, model prompts, or secrets.

Then validate:

```sh
node scripts/verify-host-e2e.mjs validate \
  --report /absolute/path/to/buddy-host-evidence-v2.json \
  --json
```

Validation recomputes the machine-evidence digest, checks all relational
bindings again, and validates the manual attestation vocabulary and timestamps.
Exit status 0 means every machine check and every required manual gate passed.
Exit status 2 means the report is malformed, incomplete, tampered, or contains
a failed gate.

Run a separate attempt and report for each public pet in the release. Release
acceptance is incomplete until every public pet has machine-bound installation
evidence and the four direct visual attestations.

## Assemble and validate the final bundle

The final release gate accepts one strict JSON bundle, not a single report. Its
only keys are `schema_version` and `reports`:

```json
{
  "schema_version": "1",
  "reports": [
    { "schema_version": "2", "...": "complete Byte report" },
    { "schema_version": "2", "...": "complete Mochi report" },
    { "schema_version": "2", "...": "complete Orbit report" },
    { "schema_version": "2", "...": "complete Bella report" },
    { "schema_version": "2", "...": "complete Lupo report" }
  ]
}
```

Build it from the unmodified per-pet reports instead of copying fields by hand:

```sh
jq -s '{schema_version: "1", reports: .}' \
  /private/evidence/buddy-byte.json \
  /private/evidence/buddy-mochi.json \
  /private/evidence/buddy-orbit.json \
  /private/evidence/buddy-bella.json \
  /private/evidence/buddy-lupo.json \
  > /private/evidence/host-evidence-v2-bundle.json

node scripts/verify-host-e2e.mjs validate-bundle \
  --artifact /absolute/path/to/public-artifact \
  --bundle /private/evidence/host-evidence-v2-bundle.json \
  --json
```

Bundle validation independently validates every v2 report, requires every
machine and manual gate to be complete, binds the report and selected pet bytes
to the supplied artifact, rejects duplicate or unknown pet IDs, and requires
the report ID set to equal `release-manifest.json.public_pet_ids` exactly.

Create one canonical single-member gzip stream, encode it as single-line base64,
and store that value in the protected `public-release` environment secret
`HOST_EVIDENCE_V2_BUNDLE_GZIP_B64`:

```sh
node -e 'const fs=require("node:fs"),z=require("node:zlib");process.stdout.write(z.gzipSync(fs.readFileSync(process.argv[1]),{level:9,mtime:0}).toString("base64"))' \
  /private/evidence/host-evidence-v2-bundle.json \
  > /private/evidence/host-evidence-v2-bundle.gzip.b64
```

The bundle is private operational evidence. Do not add the JSON or encoded value
to the public artifact or source repository. The release decoder requires
canonical single-line base64, one gzip member with no trailing data, at most 36
KiB of compressed bytes, at most 48 KiB of encoded secret text, and at most 128
KiB after decompression. Keep observer notes concise.

## Exact final-candidate to tag sequence

This order makes it possible to collect host evidence for the exact final
version before the tag exists:

1. Land the final version and cachebuster commit on the protected default
   branch, with `package.json` declaring the exact final semver (for example,
   `0.5.0`). Stop merging changes while host acceptance is in progress.
2. From that protected default-branch head, manually dispatch the release
   workflow with the exact final version. The workflow calls the complete
   Ubuntu/macOS/Windows and Node 22/24 validation matrix first, then produces a
   deterministic **final-candidate** artifact without requiring host evidence.
3. Download and reverify that candidate. Install that exact positive artifact
   and run one fresh host attempt for every public pet in its release manifest.
4. Validate every report, assemble the strict bundle above, validate the bundle
   against the downloaded artifact, create the canonical gzip plus base64 value,
   and set `HOST_EVIDENCE_V2_BUNDLE_GZIP_B64` in the protected
   `public-release` environment.
5. Confirm the protected default-branch head is still the candidate SHA. Manually
   dispatch the release workflow again with the same final version and
   `publish: true`. Do not create a source-tree version tag by hand.
6. The protected-source workflow reruns the complete validation matrix,
   deterministically rebuilds and reverifies the artifact, validates the complete
   evidence bundle, issues provenance for the tarball, distribution bundle, and
   binding receipt, then hands the candidate to the least-privilege publication
   job.
7. The publication job reconciles or pushes only the parentless artifact-only
   annotated tag, creates or reconciles the GitHub Release, and verifies that its
   metadata and downloaded asset bytes equal the candidate. Confirm those object
   IDs and assets before announcing the release.

If the default branch moves, package bytes change, a report is replaced, or the
public pet set changes, discard the bundle for promotion purposes and repeat
from a new final-candidate artifact. RC dispatches remain available for exact
`X.Y.Z-rc.N` package versions and never satisfy the final host gate. The final
install tag must come only from the verified parentless distribution candidate.

## Failure handling

Preserve the first failing report, artifact, installed snapshot, and relevant
private runtime files before retrying. Use a new report path for each attempt.
If Stop loops, disable Buddy for that workspace before further diagnosis. Do
not patch the Codex application bundle or private desktop IPC; the supported
boundary is the installed command skill, hook contract, private receipt,
renderer outbox, and native `/pet` UI.

On Windows x64, run the host gate only with the exact reviewed, hash-pinned Job
Object helper packaged in the artifact. A source-only helper, an ephemeral CI
binary, or a successful non-Windows run is not substitute evidence. There is no
direct-spawn fallback, and Windows ARM64 remains unsupported until its own
helper bytes and runtime tree behavior are built and exercised.
