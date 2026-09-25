#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  LIMITS,
  assertManifestSize,
  buildSource,
  inspectSource,
} from "./step2glb.mjs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const usage = `Usage: step2glb <command> [options]

Commands:
  inspect <input>                     Print the assembly manifest as JSON
  build <input> --out <output>        Write a GLB file
                [--mapping <file>]
  worker                              Read one request as JSON on stdin

Options:
  -h, --help                          Show this help
  -v, --version                       Show the version`;

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

async function runInspect(input) {
  if (!input) throw new Error("inspect requires an input file");
  const bytes = readFileSync(input);
  const source = await inspectSource(bytes, sha256(bytes));
  process.stdout.write(assertManifestSize(source.inspection));
}

async function runBuild(input, options) {
  if (!input) throw new Error("build requires an input file");
  if (!options.out) throw new Error("build requires --out");
  const bytes = readFileSync(input);
  const source = await inspectSource(bytes, sha256(bytes));
  const mappings = options.mapping ? JSON.parse(readFileSync(options.mapping, "utf8")) : [];
  const output = await buildSource(source, mappings);
  writeFileSync(options.out, output);
  process.stdout.write(assertManifestSize({
    version: 1,
    operation: "build",
    output_path: options.out,
    output_sha256: sha256(output),
    byte_size: output.length,
    triangle_count: source.inspection.triangle_count,
    occurrence_count: source.inspection.occurrences.length,
  }));
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      mapping: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [command, input] = positionals;
  switch (command) {
    case "worker":
      return runWorker();
    case "inspect":
      return runInspect(input);
    case "build":
      return runBuild(input, values);
    default:
      throw new Error(usage);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
