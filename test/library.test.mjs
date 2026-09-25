import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LIMITS,
  MAX_VERTICES,
  exportGLB,
  importNativeAssembly,
  inspectImport,
  normalizeMappings,
  sceneFor,
} from "../src/step2glb.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function triangleMesh(name, x = 0) {
  return {
    name,
    attributes: {
      position: { array: [x, 0, 0, x + 1, 0, 0, x, 1, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2] },
  };
}

function glb(json) {
  const text = JSON.stringify(json);
  const body = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + body.length);
  bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(body.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); body.copy(bytes, 20);
  return bytes;
}

test("inspection emits deterministic hierarchy-path ids and synthetic mesh occurrences", () => {
  const imported = {
    success: true,
    root: {
      name: "",
      meshes: [],
      children: [{ name: "Housing", meshes: [0, 1], children: [] }],
    },
    meshes: [triangleMesh("", 10), triangleMesh("", 20)],
  };
  const sourceHash = createHash("sha256").update("fixture").digest("hex");

  const first = inspectImport(imported, sourceHash);
  const second = inspectImport(imported, sourceHash);

  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(first.operation, "inspect");
  assert.equal(first.units, "m");
  assert.equal(first.triangle_count, 2);
  assert.equal(first.occurrences.length, 4);
  assert.equal(first.occurrences[0].parent_id, null);
  assert.equal(first.occurrences[0].transform.length, identity.length);
  assert.deepEqual(first.occurrences[0].transform, identity);
  assert.deepEqual(
    first.occurrences.slice(2).map((occurrence) => occurrence.node_kind),
    ["part", "part"],
  );
  assert.deepEqual(
    first.occurrences.slice(2).map((occurrence) => occurrence.mesh_index),
    [0, 1],
  );
  assert.notEqual(first.occurrences[2].id, first.occurrences[3].id);
});

test("occurrence ids depend only on hierarchy indexes, not source names or source hash", () => {
  const original = {
    success: true,
    root: {
      name: "Assembly",
      meshes: [],
      children: [{ name: "Housing", meshes: [0, 1], children: [] }],
    },
    meshes: [triangleMesh("Left"), triangleMesh("Right")],
  };
  const renamed = structuredClone(original);
  renamed.root.name = "Renamed assembly";
  renamed.root.children[0].name = "Renamed housing";
  renamed.meshes[0].name = "First renamed mesh";
  renamed.meshes[1].name = "Second renamed mesh";

  const before = inspectImport(original, "0".repeat(64));
  const after = inspectImport(renamed, "1".repeat(64));

  assert.deepEqual(before.occurrences.map(({ id }) => id), after.occurrences.map(({ id }) => id));
  assert.notDeepEqual(
    before.occurrences.map(({ source_name: name }) => name),
    after.occurrences.map(({ source_name: name }) => name),
  );
});

test("inspection enforces depth, occurrence, and triangle limits", () => {
  let root = { name: "leaf", meshes: [0], children: [] };
  for (let depth = 0; depth <= LIMITS.maxDepth; depth += 1) {
    root = { name: `level-${depth}`, meshes: [], children: [root] };
  }
  assert.throws(
    () => inspectImport({ success: true, root, meshes: [triangleMesh("part")] }, "0".repeat(64)),
    /depth/i,
  );

  const manyChildren = Array.from(
    { length: LIMITS.maxOccurrences + 1 },
    (_, index) => ({ name: `part-${index}`, meshes: [0], children: [] }),
  );
  assert.throws(
    () => inspectImport({
      success: true,
      root: { name: "root", meshes: [], children: manyChildren },
      meshes: [triangleMesh("part")],
    }, "0".repeat(64)),
    /occurrence/i,
  );

  const oversized = triangleMesh("large");
  oversized.index.array = { length: (LIMITS.maxTriangles + 1) * 3 };
  assert.throws(
    () => inspectImport({
      success: true,
      root: { name: "root", meshes: [0], children: [] },
      meshes: [oversized],
    }, "0".repeat(64)),
    /triangle/i,
  );
});

test("synthetic mesh occurrences count as another hierarchy level", () => {
  let root = { name: "multipart", meshes: [0, 1], children: [] };
  for (let depth = 0; depth < LIMITS.maxDepth; depth += 1) {
    root = { name: `level-${depth}`, meshes: [], children: [root] };
  }
  assert.throws(
    () => inspectImport({
      success: true,
      root,
      meshes: [triangleMesh("first"), triangleMesh("second")],
    }, "0".repeat(64)),
    /depth/i,
  );
});

test("mapping validation accepts only the bounded semantic-role contract", () => {
  const occurrenceIDs = new Set(["occ-a"]);
  assert.deepEqual(normalizeMappings([
    {
      occurrence_id: "occ-a",
      display_name: "Main body",
      semantic_role: "body",
      material_field_key: "body_color",
      surface_finish: "fuzzy",
    },
  ], occurrenceIDs).get("occ-a"), {
    occurrence_id: "occ-a",
    display_name: "Main body",
    semantic_role: "body",
    material_field_key: "body_color",
    surface_finish: "fuzzy",
  });
  assert.throws(
    () => normalizeMappings([{ occurrence_id: "occ-a", semantic_role: "wheel" }], occurrenceIDs),
    /semantic role/i,
  );
  assert.throws(
    () => normalizeMappings([
      { occurrence_id: "occ-a", semantic_role: "body" },
      { occurrence_id: "occ-a", semantic_role: "lid" },
    ], occurrenceIDs),
    /duplicate/i,
  );
  assert.throws(
    () => normalizeMappings([{ occurrence_id: "missing", semantic_role: "ignore" }], occurrenceIDs),
    /unknown occurrence/i,
  );
  assert.throws(
    () => normalizeMappings([{ occurrence_id: "occ-a", semantic_role: "body", surface_finish: "velvet" }], occurrenceIDs),
    /surface finish/i,
  );
});

test("ignored occurrences are excluded while semantic roles remain presentation metadata", () => {
  const imported = {
    success: true,
    root: {
      name: "Assembly",
      meshes: [],
      children: [
        { name: "Housing", meshes: [0], children: [] },
        { name: "Hidden insert", meshes: [1], children: [] },
      ],
    },
    meshes: [triangleMesh("Housing"), triangleMesh("Hidden insert")],
  };
  const inspection = inspectImport(imported, "0".repeat(64));
  const parts = inspection.occurrences.filter(({ node_kind: kind }) => kind === "part");
  const mappings = normalizeMappings([
    { occurrence_id: parts[0].id, display_name: "Custom shell", semantic_role: "lid", surface_finish: "smooth" },
    { occurrence_id: parts[1].id, display_name: "Discarded helper", semantic_role: "ignore" },
  ], new Set(inspection.occurrences.map(({ id }) => id)));

  const scene = sceneFor(imported, inspection, mappings);
  const lid = scene.getObjectByName("Custom shell");
  const ignored = scene.getObjectByName("Discarded helper");

  assert.equal(lid?.userData.step2glb_semantic_role, "lid");
  assert.equal(lid?.visible, true);
  assert.equal(lid?.userData.step2glb_surface_finish, "smooth");
  assert.equal(ignored?.userData.step2glb_semantic_role, "ignore");
  assert.equal(ignored?.visible, false);
});

test("GLB export is deterministic, Draco-compressed, and carries the step2glb metadata", async () => {
  const imported = {
    success: true,
    root: { name: "Assembly", meshes: [0], children: [] },
    meshes: [triangleMesh("Housing")],
  };
  const inspection = inspectImport(imported, "0".repeat(64));
  const part = inspection.occurrences.find(({ node_kind: kind }) => kind === "part");
  const mappings = normalizeMappings([{
    occurrence_id: part.id,
    display_name: "Main body",
    semantic_role: "body",
    material_field_key: "body_color",
    surface_finish: "fuzzy",
  }], new Set(inspection.occurrences.map(({ id }) => id)));

  const first = await exportGLB(sceneFor(imported, inspection, mappings));
  const second = await exportGLB(sceneFor(imported, inspection, mappings));
  assert.deepEqual(first, second);
  const jsonLength = first.readUInt32LE(12);
  const document = JSON.parse(first.toString("utf8", 20, 20 + jsonLength));
  assert.ok(document.extensionsRequired.includes("KHR_draco_mesh_compression"));
  const mapped = document.nodes.find((node) => node.extras?.step2glb_occurrence_id === part.id);
  assert.equal(mapped.name, "Main body");
  assert.equal(mapped.extras.step2glb_semantic_role, "body");
  assert.equal(mapped.extras.step2glb_material_field_key, "body_color");
  assert.equal(mapped.extras.step2glb_surface_finish, "fuzzy");
});

test("inspection rejects unsafe mesh buffers before scene construction", () => {
  const inspectMesh = (mesh) => inspectImport({
    success: true,
    root: { name: "part", meshes: [0], children: [] },
    meshes: [mesh],
  }, "0".repeat(64));

  const nonFinite = triangleMesh("non-finite");
  nonFinite.attributes.position.array[0] = Number.NaN;
  assert.throws(() => inspectMesh(nonFinite), /finite position/i);

  const outOfRange = triangleMesh("out-of-range");
  outOfRange.index.array[2] = 3;
  assert.throws(() => inspectMesh(outOfRange), /index.*range/i);

  const badNormals = triangleMesh("bad-normals");
  badNormals.attributes.normal.array.pop();
  assert.throws(() => inspectMesh(badNormals), /normal.*length/i);

  const tooManyVertices = triangleMesh("too-many-vertices");
  tooManyVertices.attributes.position.array = { length: (MAX_VERTICES + 1) * 3 };
  assert.throws(() => inspectMesh(tooManyVertices), /vertex limit/i);
});

test("inspection enforces the vertex limit across all distinct meshes", () => {
  const verticesPerMesh = Math.floor(MAX_VERTICES / 2) + 1;
  const mesh = (name) => ({
    name,
    attributes: { position: { array: new Float64Array(verticesPerMesh * 3) } },
    index: { array: [] },
  });
  assert.throws(
    () => inspectImport({
      success: true,
      root: { name: "assembly", meshes: [0, 1], children: [] },
      meshes: [mesh("first"), mesh("second")],
    }, "0".repeat(64)),
    /aggregate vertex limit/i,
  );
});

test("inspection rejects coordinates that overflow 32-bit floats", () => {
  const inspectMesh = (mesh) => inspectImport({
    success: true,
    root: { name: "part", meshes: [0], children: [] },
    meshes: [mesh],
  }, "0".repeat(64));

  const positions = triangleMesh("position-overflow");
  positions.attributes.position.array[0] = Number.MAX_VALUE;
  assert.throws(() => inspectMesh(positions), /position.*finite in 32-bit/i);

  const normals = triangleMesh("normal-overflow");
  normals.attributes.normal.array[0] = Number.MAX_VALUE;
  assert.throws(() => inspectMesh(normals), /normal.*finite in 32-bit/i);
});

test("repeated mesh occurrences share one cached BufferGeometry", () => {
  const imported = {
    success: true,
    root: {
      name: "assembly",
      meshes: [],
      children: [
        { name: "first", meshes: [0], children: [] },
        { name: "second", meshes: [0], children: [] },
      ],
    },
    meshes: [triangleMesh("shared")],
  };
  const inspection = inspectImport(imported, "0".repeat(64));
  const scene = sceneFor(imported, inspection, new Map());
  const meshes = [];
  scene.traverse((object) => { if (object.isMesh) meshes.push(object); });

  assert.equal(meshes.length, 2);
  assert.equal(meshes[0].geometry, meshes[1].geometry);
});

test("native assemblies reject external resources before opening them", async () => {
  await assert.rejects(
    importNativeAssembly(glb({ asset: { version: "2.0" }, buffers: [{ uri: "file:///etc/passwd", byteLength: 1 }] }), "a".repeat(64)),
    /external/i,
  );
});

test("native assemblies reject cyclic and oversized hierarchies", async () => {
  for (const nodes of [[{ children: [0] }], Array.from({ length: 513 }, () => ({}))]) {
    await assert.rejects(
      importNativeAssembly(glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes }), "a".repeat(64)),
      /hierarchy|limit|cycle/i,
    );
  }
});

test("native assemblies bound every decoded accessor including unused attributes", async () => {
  await assert.rejects(
    importNativeAssembly(glb({
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{}],
      accessors: [{ componentType: 5126, type: "SCALAR", count: 33_554_433 }],
    }), "a".repeat(64)),
    /accessor allocation limit/i,
  );
});

test("native assemblies reject multi-material meshes that cannot retain per-part mappings", async () => {
  await assert.rejects(
    importNativeAssembly(glb({
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
      accessors: [{ componentType: 5126, type: "VEC3", count: 3 }],
    }), "a".repeat(64)),
    /one primitive per mesh/i,
  );
});
