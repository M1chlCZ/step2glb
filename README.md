# step2glb

Convert STEP CAD files to GLB for the web. The output is deterministic.

## Features

- Reads STEP assemblies and writes Draco-compressed GLB files.
- Gives every occurrence a stable ID. A name change does not change the ID.
- Records the semantic role and the material field for each part.
- Enforces limits on depth, occurrences, triangles, vertices, and bytes.
- Reads native GLB assemblies and re-exports them with the same metadata.
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

Run the worker:

```
echo '{"version":1,"operation":"inspect","source_path":"model.step","source_sha256":"..."}' | step2glb worker
```

The worker reads one request on stdin and writes one response on stdout. Use it to convert files in a sandbox.

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

The same source and the same mappings produce the same bytes. Occurrence IDs depend on the hierarchy path, not on names. Draco compression uses 24-bit positions and 12-bit normals.

## Development

```
npm ci
npm test
```

## License

MIT. See `LICENSE`. The third-party licenses are in `THIRD_PARTY.md`.
