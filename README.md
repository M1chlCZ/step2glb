# step2glb

Convert STEP CAD files to GLB for the web. The output is deterministic.

## Features

- Reads STEP assemblies and writes Draco-compressed GLB files.
- Gives every occurrence a stable ID. A name change does not change the ID.
- Records the semantic role and the material field for each part.
- Enforces limits on depth, occurrences, triangles, vertices, and bytes.
- Reads native GLB assemblies and re-exports them with the same metadata.
- Converts many sources in one batch run with a JSON summary.
- Applies build presets (`web`, `high`) with per-setting overrides.
- Prints optional per-file progress to stderr.
- Runs as a CLI or as a stdin worker.

## Install

```
npm install step2glb
```

Node.js 22 or later is required.

## Usage

Inspect an assembly:

```
step2glb inspect model.step
```

The command prints a manifest as JSON. The manifest lists the root, the assemblies, and the parts. The field `units` is `m`.

Build a GLB file:

```
step2glb build model.step --out model.glb
```

Apply mappings from a file:

```
step2glb build model.step --out model.glb --mapping mapping.json
```

A mapping file is a JSON array:

```json
[
  {
    "occurrence_id": "occ_...",
    "display_name": "Body",
    "semantic_role": "body",
    "material_field_key": "body_color",
    "surface_finish": "smooth"
  }
]
```

Apply a preset and override one setting:

```
step2glb build model.step --out model.glb --preset web --quantize-position 20
```

Convert many files or directories:

```
step2glb batch parts/ models/ --out-dir dist --recursive --progress
```

The batch command writes `<out-dir>/<basename>.glb` for every source. A
directory input contributes `.step`, `.stp` and `.glb` files; directories are
walked only with `--recursive`. With `--mapping-dir`, a `<basename>.json` file
in that directory is used as the mapping file when it exists. Files are
converted in sorted order.

The batch command prints a JSON summary on stdout:

```json
{"version":1,"total":2,"succeeded":1,"failed":1,"results":[{"source":"parts/a.step","out":"dist/a.glb","ok":true,"error":null},{"source":"parts/b.step","out":null,"ok":false,"error":"STEP import failed"}]}
```

A failed file does not stop the run. The exit code is 0 when every file
succeeded, 1 when any file failed, and 2 for a usage error. With `--progress`,
the stage lines `[1/2] parts/a.step: inspecting` go to stderr; they never
appear on stdout.

Run the worker:

```
echo '{"version":1,"operation":"inspect","source_path":"model.step","source_sha256":"..."}' | step2glb worker
```

The worker reads one request on stdin and writes one response on stdout. Use it to convert files in a sandbox.

## Build settings

`build` and `batch` accept `--preset web` or `--preset high`. A preset sets the
STEP tessellation deflection and the Draco quantization. An explicit flag
overrides the preset value.

| Setting | `web` | `high` | Override flag |
| --- | --- | --- | --- |
| Linear deflection, bounding-box ratio | 0.005 | 0.0002 | `--linear-deflection <ratio>` |
| Angular deflection, radians | 0.8 | 0.2 | `--angular-deflection <radians>` |
| Draco position bits | 16 | 24 | `--quantize-position <bits>` |
| Draco normal bits | 8 | 12 | `--quantize-normal <bits>` |

Without a preset the STEP reader defaults apply (0.001 bounding-box ratio and
0.5 radians) and Draco uses 24-bit positions with 12-bit normals. The `web`
preset produces smaller files. The `high` preset keeps more detail. The
quantization flags accept integers from 8 to 30. Build settings apply to STEP
sources; native GLB sources are re-exported with their existing compression.

## Units

step2glb requests meters from the STEP reader. The manifest states the unit as `m`. The GLB file also uses meters.

## Limits

| Item | Limit |
| --- | --- |
| Assembly depth | 32 |
| Occurrences | 512 |
| Triangles | 2000000 |
| Vertices | 2000000 |
| Output file | 16 MiB |
| Manifest | 2 MiB |

## GLB metadata

Every node carries `extras` with these fields:

| Field | Meaning |
| --- | --- |
| `step2glb_occurrence_id` | The stable occurrence ID. |
| `step2glb_definition_id` | The stable definition ID. Parts that share a mesh share this ID. |
| `step2glb_display_name` | The display name. |
| `step2glb_semantic_role` | The role of the part. |
| `step2glb_material_field_key` | The material field for the part. |
| `step2glb_surface_finish` | The surface finish. |
| `source_name` | The name in the source file. |

An occurrence with the role `ignore` is not exported.

## Roles

`unassigned`, `body`, `lid`, `insert`, `hardware`, `decoration`, `other`, `ignore`.

## Surface finishes

`inherit`, `fuzzy`, `smooth`.

## Determinism

The same source, the same mappings and the same build settings produce the
same bytes. Occurrence IDs depend on the hierarchy path, not on names. Draco
compression uses 24-bit positions and 12-bit normals by default; a preset or
an explicit flag changes these settings and the bytes.

## Development

```
npm ci
npm test
```

## License

MIT. See `LICENSE`. The third-party licenses are in `THIRD_PARTY.md`.
