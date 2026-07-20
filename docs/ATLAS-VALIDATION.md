# Pet Atlas Validation

Buddy uses two complementary atlas gates. They prove different things and must
not be conflated.

## Deterministic structural gate

CI runs:

```sh
npm run check:atlas-structure
```

For each allowlisted pet, the Node validator checks:

- catalog, manifest, spritesheet, and provenance paths remain contained and do
  not traverse symlinked components;
- catalog-pinned manifest and spritesheet SHA-256 values match exact bytes;
- the manifest/provenance contracts describe an available V2 package with the
  expected redistribution scope;
- every public provenance record carries a validated rights basis,
  authorization source, rights-holder role, exact Apache-2.0 grant, and
  catalog-matching derived-atlas SHA-256;
- recorded and unavailable lineage values use internally consistent value and
  status fields, with unknown identity and local-path fields rejected;
- the file is a bounded RIFF/WEBP container with an exact declared length and
  valid chunk padding;
- there is one non-animated `VP8` or `VP8L` image bitstream and at most one
  consistent `VP8X` canvas;
- header dimensions are exactly 1536 by 2288, producing the expected 8 by 11
  grid of 192 by 208 cells; and
- alpha usage is declared.

The JSON result intentionally reports:

```json
{
  "validation_scope": "container-structure-and-catalog-integrity",
  "full_pixel_decode": false
}
```

The structural parser does not decode compressed pixel data, evaluate sprite
semantics, or prove that every platform decoder accepts the file. Passing CI is
not Linux pixel-decode parity.

The provenance checks validate a closed schema, catalog-bound derived hashes,
and cross-field consistency. They do not independently prove that an owner
attestation, source hash, tool, or historical date is true. Checked-in tests pin
the current five records, including their explicit `not-recorded` values and
verified first repository record date.

## App-bundled release gate

Before shipping an atlas change, run the installed app's official hatch-pet
validator with the V2 requirement on every changed package, then inspect the
atlas in Codex with `/pet`. The local release evidence must include successful
full decoding plus human observation of the relevant idle, Running, and Ready
animation states.

The app-bundled validator is authoritative for the native pet decoder currently
installed on the test host. It is not patched or vendored into this repository.
If CI structure passes but the app-bundled validator or visual inspection fails,
the asset does not pass the release gate.
