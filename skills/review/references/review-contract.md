# Review Contract

## Result states

- `findings`: one or more validated findings remain at or above the configured confidence threshold.
- `no_findings`: the reviewer found no defensible defect in the supplied evidence.
- `abstain`: the evidence was incomplete, the reviewer was uncertain, or all findings were below the publication threshold.

Every published finding must cite a changed path and a current line range. Local validation rejects unknown fields, out-of-scope paths, impossible line ranges, and malformed results. Reviewer receipts preserve every validated finding; bounded companion or aggregate presentations may show a deterministic subset while retaining the complete source result.

The optional `comments` array contains at most three grounded optimization, reliability, maintainability, or testing observations. Comments remain separate from defects, must cite a transmitted changed current line, and may accompany `findings` or `no_findings`. `abstain` never carries comments.

## Privacy boundary

The collector sends only an allowlisted Git patch plus minimal metadata. It excludes common secret locations and credential filenames. Excluded path names are not included in the model prompt. The default local receipt contains hashes and metadata but omits patch text.

Path filtering reduces accidental disclosure; it is not a general-purpose secret scanner. Review the dry-run metadata before using the tool on unusually sensitive repositories.

## Provider boundary

The selected reviewer adapter runs for one turn with its documented isolation boundary; Ollama uses `ollama run` with history disabled. No provider may edit the repository through this plugin.

Automatic mode uses the same provider and validator boundary but derives evidence from private start/final turn snapshots. The worker summary is used only for local final presentation and is not sent to the reviewer.
