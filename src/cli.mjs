#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LIMITS,
  PRESETS,
  assertManifestSize,
  buildSource,
  inspectSource,
  resolveBuildOptions,
} from "./step2glb.mjs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const usage = `Usage: step2glb <command> [options]

Commands:
  inspect <input>                     Print the assembly manifest as JSON
  build <input> --out <output>        Write a GLB file
  batch <input...> --out-dir <dir>    Convert many files and directories
  worker                              Read one request as JSON on stdin

Options:
  --mapping <file>                    Mapping file for one build
  --mapping-dir <dir>                 Mapping files (<basename>.json) for batch
  --recursive                         Walk directories in batch
  --preset <name>                     Build settings bundle: web or high
  --linear-deflection <ratio>         Tessellation deflection as a bounding-box ratio
  --angular-deflection <radians>      Tessellation angular deflection
  --quantize-position <bits>          Draco position quantization, 8 to 30
  --quantize-normal <bits>            Draco normal quantization, 8 to 30
  --progress                          Print per-file progress to stderr
  -h, --help                          Show this help
  -v, --version                       Show the version`;

const SOURCE_EXTENSIONS = new Set([".step", ".stp", ".glb"]);

class UsageError extends Error {}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function strictKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown request field: ${key}`);
  for (const key of required) if (!(key in value)) throw new Error(`missing request field: ${key}`);
}

async function readWorkerRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > LIMITS.maxManifestBytes) {
      process.stdin.destroy();
      throw new Error("request manifest limit exceeded");
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("request manifest limit exceeded");
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function validateWorkerRequest(request) {
  if (request.version !== 1) throw new Error("unsupported protocol version");
  if (request.operation === "inspect") {
    strictKeys(request, ["version", "operation", "source_path", "source_sha256"]);
  } else if (request.operation === "build") {
    strictKeys(request, ["version", "operation", "source_path", "source_sha256", "output_path"], ["mappings"]);
  } else {
    throw new Error("unsupported operation");
  }
  if (typeof request.source_path !== "string" || !request.source_path) throw new Error("invalid source path");
  if (!/^[a-f0-9]{64}$/i.test(request.source_sha256)) throw new Error("invalid source SHA-256");
  if (request.operation === "build" && (typeof request.output_path !== "string" || !request.output_path)) {
    throw new Error("invalid output path");
  }
  return request;
}

async function runWorker() {
  const request = validateWorkerRequest(await readWorkerRequest());
  const sourceBytes = readFileSync(request.source_path);
  const sourceHash = sha256(sourceBytes);
  if (sourceHash !== request.source_sha256.toLowerCase()) {
    throw new Error(`source hash mismatch: expected ${request.source_sha256}, got ${sourceHash}`);
  }
  const source = await inspectSource(sourceBytes, sourceHash);
  if (request.operation === "inspect") {
    process.stdout.write(assertManifestSize(source.inspection));
    return;
  }
  const output = await buildSource(source, request.mappings ?? []);
  const handle = openSync(request.output_path, "wx", 0o600);
  try {
    writeFileSync(handle, output);
  } finally {
    closeSync(handle);
  }
  process.stdout.write(assertManifestSize({
    version: 1,
    operation: "build",
    source_sha256: sourceHash,
    output_path: request.output_path,
    output_sha256: sha256(output),
    byte_size: output.length,
    triangle_count: source.inspection.triangle_count,
    occurrence_count: source.inspection.occurrences.length,
  }));
}

function positiveNumber(name, value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${name} must be a positive number`);
  return number;
}

function quantizationBits(name, value) {
  if (value === undefined) return undefined;
  const bits = Number(value);
  if (!Number.isInteger(bits) || bits < 8 || bits > 30) {
    throw new UsageError(`${name} must be an integer between 8 and 30`);
  }
  return bits;
}

function buildOptions(values) {
  if (values.preset !== undefined && !Object.hasOwn(PRESETS, values.preset)) {
    throw new UsageError(`unknown preset: ${values.preset}`);
  }
  return resolveBuildOptions(values.preset, {
    linearDeflection: positiveNumber("--linear-deflection", values["linear-deflection"]),
    angularDeflection: positiveNumber("--angular-deflection", values["angular-deflection"]),
    quantizePosition: quantizationBits("--quantize-position", values["quantize-position"]),
    quantizeNormal: quantizationBits("--quantize-normal", values["quantize-normal"]),
  });
}

function progressLine(index, total, source, stage) {
  process.stderr.write(`[${index}/${total}] ${source}: ${stage}\n`);
}

async function convertOne(input, outputPath, mappingPath, options, report) {
  report("inspecting");
  const bytes = readFileSync(input);
  const source = await inspectSource(bytes, sha256(bytes), options);
  const mappings = mappingPath === null ? [] : JSON.parse(readFileSync(mappingPath, "utf8"));
  report("building");
  const output = await buildSource(source, mappings, options);
  report(`writing ${outputPath}`);
  writeFileSync(outputPath, output);
  return { output, source };
}

async function runInspect(input) {
  if (!input) throw new UsageError("inspect requires an input file");
  const bytes = readFileSync(input);
  const source = await inspectSource(bytes, sha256(bytes));
  process.stdout.write(assertManifestSize(source.inspection));
}

async function runBuild(input, values) {
  if (!input) throw new UsageError("build requires an input file");
  if (!values.out) throw new UsageError("build requires --out");
  const options = buildOptions(values);
  const report = values.progress ? (stage) => progressLine(1, 1, input, stage) : () => {};
  const { output, source } = await convertOne(input, values.out, values.mapping ?? null, options, report);
  process.stdout.write(assertManifestSize({
    version: 1,
    operation: "build",
    output_path: values.out,
    output_sha256: sha256(output),
    byte_size: output.length,
    triangle_count: source.inspection.triangle_count,
    occurrence_count: source.inspection.occurrences.length,
  }));
}

function collectDirectory(directory, recursive, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) collectDirectory(path, recursive, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
}

function collectSources(inputs, recursive) {
  const files = [];
  for (const input of inputs) {
    let stats;
    try {
      stats = statSync(input);
    } catch {
      throw new UsageError(`input not found: ${input}`);
    }
    if (stats.isDirectory()) collectDirectory(input, recursive === true, files);
    else if (stats.isFile()) files.push(input);
    else throw new UsageError(`input is not a file or directory: ${input}`);
  }
  const seen = new Set();
  return files.sort().filter((file) => {
    const key = resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function runBatch(inputs, values) {
  if (inputs.length === 0) throw new UsageError("batch requires at least one input");
  if (!values["out-dir"]) throw new UsageError("batch requires --out-dir");
  const options = buildOptions(values);
  if (values["mapping-dir"] !== undefined && !isDirectory(values["mapping-dir"])) {
    throw new UsageError(`--mapping-dir is not a directory: ${values["mapping-dir"]}`);
  }
  const sources = collectSources(inputs, values.recursive === true);
  try {
    mkdirSync(values["out-dir"], { recursive: true });
  } catch {
    throw new UsageError(`cannot create --out-dir: ${values["out-dir"]}`);
  }
  const results = [];
  let succeeded = 0;
  let failed = 0;
  for (const [index, source] of sources.entries()) {
    const name = basename(source, extname(source));
    const outputPath = join(values["out-dir"], `${name}.glb`);
    const candidate = values["mapping-dir"] === undefined ? null : join(values["mapping-dir"], `${name}.json`);
    const mappingPath = candidate !== null && existsSync(candidate) ? candidate : null;
    const report = values.progress
      ? (stage) => progressLine(index + 1, sources.length, source, stage)
      : () => {};
    try {
      await convertOne(source, outputPath, mappingPath, options, report);
      results.push({ source, out: outputPath, ok: true, error: null });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[${index + 1}/${sources.length}] ${source}: failed: ${message}\n`);
      results.push({ source, out: null, ok: false, error: message });
      failed += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({
    version: 1,
    total: sources.length,
    succeeded,
    failed,
    results,
  })}\n`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        out: { type: "string" },
        "out-dir": { type: "string" },
        mapping: { type: "string" },
        "mapping-dir": { type: "string" },
        recursive: { type: "boolean" },
        preset: { type: "string" },
        progress: { type: "boolean" },
        "linear-deflection": { type: "string" },
        "angular-deflection": { type: "string" },
        "quantize-position": { type: "string" },
        "quantize-normal": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [command, ...inputs] = positionals;
  switch (command) {
    case "worker":
      return runWorker();
    case "inspect":
      return runInspect(inputs[0]);
    case "build":
      return runBuild(inputs[0], values);
    case "batch":
      return runBatch(inputs, values);
    default:
      throw new UsageError(usage);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
