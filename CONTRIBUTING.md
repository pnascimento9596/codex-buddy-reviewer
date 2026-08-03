# Contributing to Codex Buddy Reviewer

Thank you for helping make independent post-turn review safer and more useful. This project treats privacy, deterministic evidence, provider isolation, and honest failure as product contracts, not optional polish.

## Before you start

- Use Node.js 22 or newer.
- Install Gitleaks for the local secret gate. Maintainers also need a Codex installation that provides the official plugin and skill validators.
- Read `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`, and `docs/SECURITY.md`.
- Open an issue before a broad architecture rewrite, new provider adapter, new persistence format, or native-code expansion.
- Keep the Node ESM core unless concrete evidence justifies a narrower language boundary.
- Never patch Codex application bundles, private IPC, generated vendor files, or system application resources.

## Security and privacy rules

- Never commit credentials, API keys, authorization headers, session files, provider auth stores, private prompts, proprietary diffs, local receipts, scan workspaces, or personal filesystem paths.
- Use synthetic credential-shaped fixtures assembled from separated fragments. Do not paste a real token into a test, issue, log, or pull request.
- External reviewers must remain read-only with no shell, write, web, memory, MCP, repository access, or subagents.
- Provider choice, model, effort, scope, confidence, consent, and retention must never change silently.
- Missing or incomplete privacy coverage must fail closed before provider contact.
- A malformed, ungrounded, under-confident, or privacy-sensitive model result is an abstention or failure, never an all-clear.
- Do not report a sensitive vulnerability in a public issue. Use GitHub private vulnerability reporting once it is enabled for the public repository.

## Development workflow

Install no runtime dependencies. The plugin ships modern ESM source and uses development-only tooling for validation.

Run the narrowest relevant test first, then the portable suite:

```bash
node --test tests/<focused-file>.test.mjs
npm run check:portable
```

Before requesting review, run:

```bash
npm run validate
npm run security:secrets
git diff --check
```

Provider-free tests are the default. Paid or networked model checks must be explicit, bounded, and separately authorized. Never make a successful live provider call a normal test requirement.

Changes to skills or plugin metadata also require the official Codex validators documented in `README.md` and `docs/VALIDATION.md`. Changes to pet assets require atlas validation, visual inspection, a complete `provenance.json`, and documented redistribution authority.

## Pull requests

A pull request should:

- explain the problem and the chosen tradeoff;
- identify privacy, schema, persistence, platform, and rollback implications;
- include adversarial tests for evidence, path policy, result validation, subprocess handling, retention, or consent changes;
- preserve current behavior outside the stated scope;
- list exact commands and results without claiming unrun checks;
- contain no em dash characters;
- keep generated artifacts and private runtime data out of Git.

Reviewers may ask for real Windows x64 evidence, Codex host evidence, an independent model review, or a fresh security scan when the affected boundary warrants it. Local unit tests cannot substitute for those release gates.

## Contribution license

By submitting a contribution, you agree to license it under the repository's Apache-2.0 license. This project does not currently require a separate contributor license agreement or Developer Certificate of Origin sign-off.

## Pet contributions

New pets must use unique `buddy-*` identifiers, meet the V2 atlas contract, include original or properly licensed artwork, and carry machine-readable provenance. Artwork without clear redistribution rights cannot be included in the public catalog.
