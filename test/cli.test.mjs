import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/two-tetrahedra.step", import.meta.url));
const fixtureHash = createHash("sha256").update(readFileSync(fixture)).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 4 << 20, ...options });
}

function callWorker(request) {
  return run(["worker"], { input: `${JSON.stringify(request)}\n` });
}

function inspectFixture() {
  const result = run(["inspect", fixture]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function glbDocument(bytes) {
  return JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
}

test("inspect prints a deterministic manifest in meters", () => {
  const manifest = inspectFixture();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.operation, "inspect");
  assert.equal(manifest.units, "m");
  assert.equal(manifest.triangle_count, 8);
  assert.equal(manifest.occurrences.length, 4);
  assert.equal(manifest.occurrences.filter((item) => item.node_kind === "part").length, 2);
  assert.deepEqual(JSON.parse(run(["inspect", fixture]).stdout), manifest);
});

test("build writes a GLB with verified hashes and mapping metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const manifest = inspectFixture();
  const part = manifest.occurrences.find((item) => item.node_kind === "part");
  const mapping = join(directory, "mapping.json");
  writeFileSync(mapping, JSON.stringify([{
    occurrence_id: part.id,
    display_name: "Body",
    semantic_role: "body",
    material_field_key: "body_color",
    surface_finish: "smooth",
  }]));
  const firstPath = join(directory, "first.glb");
  const secondPath = join(directory, "second.glb");
  const first = run(["build", fixture, "--out", firstPath, "--mapping", mapping]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(["build", fixture, "--out", secondPath, "--mapping", mapping]);
  assert.equal(second.status, 0, second.stderr);
  const bytes = readFileSync(firstPath);
  assert.deepEqual(bytes, readFileSync(secondPath));
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.output_sha256, sha256(bytes));
  assert.equal(summary.byte_size, bytes.length);
  assert.equal(summary.triangle_count, 8);
  const document = glbDocument(bytes);
  assert.ok(document.extensionsRequired.includes("KHR_draco_mesh_compression"));
  const mapped = document.nodes.find((node) => node.extras?.step2glb_occurrence_id === part.id);
  assert.equal(mapped.name, "Body");
  assert.equal(mapped.extras.step2glb_semantic_role, "body");
  assert.equal(mapped.extras.step2glb_material_field_key, "body_color");
  assert.equal(mapped.extras.step2glb_surface_finish, "smooth");
});

test("build rejects a mapping for an unknown occurrence", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const mapping = join(directory, "mapping.json");
  writeFileSync(mapping, JSON.stringify([{ occurrence_id: "occ_missing", semantic_role: "body" }]));
  const result = run(["build", fixture, "--out", join(directory, "out.glb"), "--mapping", mapping]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown occurrence/i);
});

test("worker inspects and builds with a verified hash", () => {
  const request = { version: 1, operation: "inspect", source_path: fixture, source_sha256: fixtureHash };
  const inspected = callWorker(request);
  assert.equal(inspected.status, 0, inspected.stderr);
  const manifest = JSON.parse(inspected.stdout);
  assert.deepEqual(manifest, inspectFixture());
  const part = manifest.occurrences.find((item) => item.node_kind === "part");
  const output = join(mkdtempSync(join(tmpdir(), "step2glb-")), "out.glb");
  const built = callWorker({
    ...request,
    operation: "build",
    output_path: output,
    mappings: [{ occurrence_id: part.id, semantic_role: "hardware" }],
  });
  assert.equal(built.status, 0, built.stderr);
  const response = JSON.parse(built.stdout);
  const bytes = readFileSync(output);
  assert.equal(response.output_sha256, sha256(bytes));
  assert.equal(response.source_sha256, fixtureHash);
  assert.equal(response.occurrence_count, 4);
});

test("worker rejects a wrong source hash and an existing output path", () => {
  const wrong = callWorker({ version: 1, operation: "inspect", source_path: fixture, source_sha256: "0".repeat(64) });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /hash mismatch/i);
  assert.equal(wrong.stdout, "");
  const output = join(mkdtempSync(join(tmpdir(), "step2glb-")), "out.glb");
  writeFileSync(output, "sentinel");
  const existing = callWorker({
    version: 1, operation: "build", source_path: fixture, source_sha256: fixtureHash,
    output_path: output, mappings: [],
  });
  assert.notEqual(existing.status, 0);
  assert.equal(existing.stdout, "");
  assert.equal(readFileSync(output, "utf8"), "sentinel");
});

test("native GLB sources round-trip through the worker", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const built = join(directory, "model.glb");
  const first = run(["build", fixture, "--out", built]);
  assert.equal(first.status, 0, first.stderr);
  const source = readFileSync(built);
  const hash = sha256(source);
  const inspected = callWorker({ version: 1, operation: "inspect", source_path: built, source_sha256: hash });
  assert.equal(inspected.status, 0, inspected.stderr);
  const manifest = JSON.parse(inspected.stdout);
  assert.equal(manifest.units, "m");
  assert.equal(manifest.triangle_count, 8);
  const part = manifest.occurrences.find((item) => item.node_kind === "part");
  const output = join(directory, "native.glb");
  const rebuilt = callWorker({
    version: 1, operation: "build", source_path: built, source_sha256: hash, output_path: output,
    mappings: [{ occurrence_id: part.id, display_name: "Native body", semantic_role: "body" }],
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const document = glbDocument(readFileSync(output));
  const node = document.nodes.find((item) => item.extras?.step2glb_occurrence_id === part.id);
  assert.equal(node.name, "Native body");
  assert.equal(node.extras.step2glb_semantic_role, "body");
});

test("worker stops reading stdin as soon as the manifest exceeds its limit", async () => {
  const child = spawn(process.execPath, [cli, "worker"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.write(Buffer.alloc((2 << 20) + 1, 0x20));

  let timer;
  try {
    const status = await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("worker waited for stdin EOF")), 3_000);
      }),
    ]);
    assert.notEqual(status, 0);
    assert.equal(stdout, "");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});

test("help and version flags work without arguments", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: step2glb/);
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\n$/);
});

test("batch converts files in sorted order and prints a versioned summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const sources = join(directory, "sources");
  mkdirSync(sources);
  writeFileSync(join(sources, "beta.step"), readFileSync(fixture));
  writeFileSync(join(sources, "alpha.step"), readFileSync(fixture));
  const outDir = join(directory, "out");
  const result = run(["batch", join(sources, "beta.step"), join(sources, "alpha.step"), "--out-dir", outDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('{"version":1,"total":2,"succeeded":2,"failed":0,"results":['));
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(
    summary.results.map((item) => item.source),
    [join(sources, "alpha.step"), join(sources, "beta.step")],
  );
  assert.deepEqual(
    summary.results.map((item) => item.out),
    [join(outDir, "alpha.glb"), join(outDir, "beta.glb")],
  );
  assert.deepEqual(summary.results.map((item) => item.ok), [true, true]);
  assert.deepEqual(summary.results.map((item) => item.error), [null, null]);
  for (const item of summary.results) {
    assert.equal(readFileSync(item.out).toString("ascii", 0, 4), "glTF");
  }
});

test("batch scans directories and walks them only with --recursive", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const root = join(directory, "models");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "top.step"), readFileSync(fixture));
  writeFileSync(join(root, "notes.txt"), "not a model");
  writeFileSync(join(root, "nested", "deep.step"), readFileSync(fixture));
  const flatOut = join(directory, "flat");
  const flat = run(["batch", root, "--out-dir", flatOut]);
  assert.equal(flat.status, 0, flat.stderr);
  assert.deepEqual(
    JSON.parse(flat.stdout).results.map((item) => item.source),
    [join(root, "top.step")],
  );
  assert.ok(!existsSync(join(flatOut, "deep.glb")));
  const deepOut = join(directory, "deep");
  const deep = run(["batch", root, "--out-dir", deepOut, "--recursive"]);
  assert.equal(deep.status, 0, deep.stderr);
  assert.deepEqual(
    JSON.parse(deep.stdout).results.map((item) => item.source),
    [join(root, "nested", "deep.step"), join(root, "top.step")],
  );
  assert.ok(existsSync(join(deepOut, "deep.glb")));
  assert.ok(existsSync(join(deepOut, "top.glb")));
});

test("batch continues after a failed source and exits 1", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const sources = join(directory, "sources");
  mkdirSync(sources);
  writeFileSync(join(sources, "broken.step"), "not a step file\n");
  writeFileSync(join(sources, "good.step"), readFileSync(fixture));
  const outDir = join(directory, "out");
  const result = run(["batch", sources, "--out-dir", outDir]);
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  const [broken, good] = summary.results;
  assert.equal(broken.source, join(sources, "broken.step"));
  assert.equal(broken.out, null);
  assert.equal(broken.ok, false);
  assert.match(broken.error, /STEP import failed/i);
  assert.equal(good.ok, true);
  assert.equal(good.error, null);
  assert.ok(existsSync(join(outDir, "good.glb")));
  assert.match(result.stderr, /broken\.step: failed: STEP import failed/i);
});

test("batch applies <basename>.json mappings from --mapping-dir when present", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const sources = join(directory, "sources");
  mkdirSync(sources);
  writeFileSync(join(sources, "mapped.step"), readFileSync(fixture));
  writeFileSync(join(sources, "plain.step"), readFileSync(fixture));
  const manifest = inspectFixture();
  const part = manifest.occurrences.find((item) => item.node_kind === "part");
  const mappingDir = join(directory, "mappings");
  mkdirSync(mappingDir);
  writeFileSync(join(mappingDir, "mapped.json"), JSON.stringify([{
    occurrence_id: part.id,
    display_name: "Mapped body",
    semantic_role: "body",
  }]));
  const outDir = join(directory, "out");
  const result = run(["batch", sources, "--out-dir", outDir, "--mapping-dir", mappingDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).succeeded, 2);
  const mapped = glbDocument(readFileSync(join(outDir, "mapped.glb")));
  const plain = glbDocument(readFileSync(join(outDir, "plain.glb")));
  assert.ok(mapped.nodes.some((node) => node.name === "Mapped body"));
  assert.ok(!plain.nodes.some((node) => node.name === "Mapped body"));
});

test("batch and build report usage errors with exit code 2", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const cases = [
    { args: ["batch", fixture], message: /--out-dir/ },
    { args: ["batch", "--out-dir", join(directory, "out")], message: /at least one input/ },
    { args: ["batch", fixture, "--out-dir", join(directory, "out"), "--preset", "bogus"], message: /unknown preset/i },
    { args: ["batch", fixture, "--out-dir", join(directory, "out"), "--quantize-normal", "40"], message: /--quantize-normal/ },
    { args: ["batch", fixture, "--out-dir", join(directory, "out"), "--mapping-dir", fixture], message: /--mapping-dir is not a directory/i },
    { args: ["build", fixture, "--out", join(directory, "x.glb"), "--preset", "bogus"], message: /unknown preset/i },
    { args: ["batch", join(directory, "missing.step"), "--out-dir", join(directory, "out")], message: /input not found/i },
  ];
  for (const item of cases) {
    const result = run(item.args);
    assert.equal(result.status, 2, `${item.args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, item.message);
    assert.equal(result.stdout, "");
  }
});

test("presets change the build and explicit flags override them", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const build = (out, extra = []) => {
    const result = run(["build", fixture, "--out", out, ...extra]);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(out);
  };
  const defaults = build(join(directory, "default.glb"));
  const web = build(join(directory, "web.glb"), ["--preset", "web"]);
  const high = build(join(directory, "high.glb"), ["--preset", "high"]);
  const overridden = build(join(directory, "override.glb"), [
    "--preset", "web",
    "--linear-deflection", "0.001",
    "--angular-deflection", "0.5",
    "--quantize-position", "24",
    "--quantize-normal", "12",
  ]);
  assert.notDeepEqual(web, defaults);
  assert.deepEqual(high, defaults);
  assert.deepEqual(overridden, defaults);
  const batchOut = join(directory, "batch");
  const batch = run(["batch", fixture, "--out-dir", batchOut, "--preset", "web"]);
  assert.equal(batch.status, 0, batch.stderr);
  assert.deepEqual(readFileSync(join(batchOut, "two-tetrahedra.glb")), web);
});

test("progress lines go to stderr only", () => {
  const directory = mkdtempSync(join(tmpdir(), "step2glb-"));
  const sources = join(directory, "sources");
  mkdirSync(sources);
  writeFileSync(join(sources, "a.step"), readFileSync(fixture));
  writeFileSync(join(sources, "b.step"), readFileSync(fixture));
  const outDir = join(directory, "out");
  const result = run(["batch", sources, "--out-dir", outDir, "--progress"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).succeeded, 2);
  assert.ok(!result.stdout.includes("inspecting"));
  const lines = result.stderr.trimEnd().split("\n");
  for (const line of lines) {
    assert.match(line, /^\[\d\/2\] .+: (inspecting|building|writing .+|failed: .+)$/);
  }
  assert.ok(lines.some((line) => line.startsWith("[1/2]") && line.endsWith(": inspecting")));
  assert.ok(lines.some((line) => line.startsWith("[2/2]") && line.includes(": writing ")));
  const quiet = run(["batch", sources, "--out-dir", join(directory, "quiet")]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, "");
  const single = run(["build", fixture, "--out", join(directory, "single.glb"), "--progress"]);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stderr, /^\[1\/1\] .+: inspecting$/m);
});
