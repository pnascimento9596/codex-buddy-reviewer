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
- the manifest/provenance contracts describe an available host-compatible package
  with the expected redistribution scope;
- every public provenance record carries a validated rights basis,
  authorization source, rights-holder role, exact Apache-2.0 grant, and
  catalog-matching derived-atlas SHA-256;
- recorded and unavailable lineage values use internally consistent value and
  status fields, with unknown identity and local-path fields rejected;
- the file is a bounded RIFF/WEBP container with an exact declared length and
  valid chunk padding;
- there is one non-animated `VP8` or `VP8L` image bitstream and at most one
  consistent `VP8X` canvas;
- header dimensions are exactly 1536 by 1872, producing the expected 8 by 9
  grid of 192 by 208 cells required by Codex CLI 0.146.0 custom pets; and
- alpha usage is declared.

Installed package manifests intentionally match the host `pet.json` shape used by
working legacy pets (`id`, `displayName`, `description`, `spritesheetPath`) and
omit `spriteVersionNumber`. The catalog still records
`spriteVersionNumber: 1` as the Buddy-side label for this host-compatible base
atlas. Extended 8×11 look-direction rows are not packaged for 0.146.0.

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

Before shipping an atlas change, install the packages into a real Codex
marketplace/pets directory and inspect each pet with `/pet` inside a
graphics-capable terminal (Kitty or Sixel). The local release evidence must
include host selector discovery plus human observation of the relevant idle,
Running, and Ready animation states.

The host pet decoder currently installed on the test machine is authoritative.
It is not patched or vendored into this repository. If CI structure passes but
Codex discovery/render or visual inspection fails, the asset does not pass the
release gate.
