import { createHash } from "node:crypto";
import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import occtImportFactory from "occt-import-js";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

export const MAX_VERTICES = 2_000_000;

export const LIMITS = Object.freeze({
  maxDepth: 32,
  maxOccurrences: 512,
  maxTriangles: 2_000_000,
  maxVertices: MAX_VERTICES,
  maxOutputBytes: 16 << 20,
  maxManifestBytes: 2 << 20,
});

export const ROLES = Object.freeze([
  "unassigned", "body", "lid", "insert", "hardware", "decoration", "other", "ignore",
]);

export const SURFACE_FINISHES = Object.freeze(["inherit", "fuzzy", "smooth"]);

const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const dracoEncoderPromise = draco3d.createEncoderModule({});

let occtPromise;

function occt() {
  occtPromise ??= occtImportFactory();
  return occtPromise;
}

function stableID(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function cleanName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unnamed";
}

function triangleCount(mesh) {
  const length = mesh?.index?.array?.length;
  if (!Number.isSafeInteger(length) || length < 0 || length % 3 !== 0) {
    throw new Error("mesh has invalid triangle indices");
  }
  return length / 3;
}

function validateMesh(mesh) {
  const positions = mesh?.attributes?.position?.array;
  const positionLength = positions?.length;
  if (!Number.isSafeInteger(positionLength) || positionLength <= 0 || positionLength % 3 !== 0) {
    throw new Error("mesh position length must be a positive multiple of three");
  }
  const vertexCount = positionLength / 3;
  if (vertexCount > MAX_VERTICES) throw new Error("mesh vertex limit exceeded");
  for (let index = 0; index < positionLength; index += 1) {
    const value = positions[index];
    if (!Number.isFinite(value)) throw new Error("mesh must contain finite position coordinates");
    if (!Number.isFinite(Math.fround(value))) {
      throw new Error("position coordinates must remain finite in 32-bit floats");
    }
  }

  if (mesh?.attributes?.normal !== undefined) {
    const normals = mesh.attributes.normal?.array;
    if (!normals || normals.length !== positionLength) throw new Error("mesh normal length must match positions");
    for (let index = 0; index < normals.length; index += 1) {
      const value = normals[index];
      if (!Number.isFinite(value)) throw new Error("mesh must contain finite normal coordinates");
      if (!Number.isFinite(Math.fround(value))) {
        throw new Error("normal coordinates must remain finite in 32-bit floats");
      }
    }
  }

  const triangles = triangleCount(mesh);
  if (triangles > LIMITS.maxTriangles) throw new Error("triangle limit exceeded");
  const indices = mesh.index.array;
  for (let index = 0; index < indices.length; index += 1) {
    const value = indices[index];
    if (!Number.isSafeInteger(value) || value < 0 || value >= vertexCount) {
      throw new Error("mesh index is not a safe integer in vertex range");
    }
  }
  return { triangles, vertexCount };
}

export function isGLB(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "glTF";
}

export function inspectImport(imported, sourceSHA256) {
  if (!imported?.success || !imported.root || !Array.isArray(imported.meshes)) {
    throw new Error("STEP import failed");
  }
  if (!/^[a-f0-9]{64}$/i.test(sourceSHA256)) throw new Error("invalid source SHA-256");

  let triangles = 0;
  let vertices = 0;
  for (const mesh of imported.meshes) {
    const counts = validateMesh(mesh);
    triangles += counts.triangles;
    vertices += counts.vertexCount;
    if (triangles > LIMITS.maxTriangles) throw new Error("triangle limit exceeded");
    if (vertices > LIMITS.maxVertices) throw new Error("aggregate vertex limit exceeded");
  }

  const occurrences = [];
  const referencedMeshes = new Set();
  const add = (node, parentID, path, depth) => {
    if (depth > LIMITS.maxDepth) throw new Error("assembly depth limit exceeded");
    const meshes = Array.isArray(node?.meshes) ? node.meshes : [];
    const children = Array.isArray(node?.children) ? node.children : [];
    const id = stableID("occ", path);
    const oneMesh = meshes.length === 1;
    const meshIndex = oneMesh ? meshes[0] : null;
    if (oneMesh && (!Number.isInteger(meshIndex) || !imported.meshes[meshIndex])) {
      throw new Error("assembly references an unknown mesh");
    }
    occurrences.push({
      id,
      parent_id: parentID,
      definition_id: oneMesh ? stableID("def", `${sourceSHA256}:mesh:${meshIndex}`) : stableID("def", `${sourceSHA256}:node:${path}`),
      source_name: cleanName(node?.name),
      node_kind: oneMesh ? "part" : "assembly",
      mesh_index: meshIndex,
      transform: [...identity],
    });
    if (occurrences.length > LIMITS.maxOccurrences) throw new Error("occurrence limit exceeded");
    if (oneMesh) referencedMeshes.add(meshIndex);

    if (meshes.length > 1 && depth + 1 > LIMITS.maxDepth) {
      throw new Error("assembly depth limit exceeded");
    }
    meshes.forEach((index, meshOffset) => {
      if (oneMesh) return;
      if (!Number.isInteger(index) || !imported.meshes[index]) throw new Error("assembly references an unknown mesh");
      referencedMeshes.add(index);
      const mesh = imported.meshes[index];
      const meshPath = `${path}/mesh[${meshOffset}]`;
      occurrences.push({
        id: stableID("occ", meshPath),
        parent_id: id,
        definition_id: stableID("def", `${sourceSHA256}:mesh:${index}`),
        source_name: cleanName(mesh.name),
        node_kind: "part",
        mesh_index: index,
        transform: [...identity],
      });
      if (occurrences.length > LIMITS.maxOccurrences) throw new Error("occurrence limit exceeded");
    });
    children.forEach((child, index) => add(child, id, `${path}/node[${index}]`, depth + 1));
    return id;
  };

  const rootPath = "node[0]";
  const rootID = add(imported.root, null, rootPath, 0);
  imported.meshes.forEach((mesh, index) => {
    if (referencedMeshes.has(index)) return;
    const path = `${rootPath}/unreferenced-mesh[${index}]`;
    occurrences.push({
      id: stableID("occ", path),
      parent_id: rootID,
      definition_id: stableID("def", `${sourceSHA256}:mesh:${index}`),
      source_name: cleanName(mesh.name),
      node_kind: "part",
      mesh_index: index,
      transform: [...identity],
    });
    if (occurrences.length > LIMITS.maxOccurrences) throw new Error("occurrence limit exceeded");
  });

  const response = {
    version: 1,
    operation: "inspect",
    source_sha256: sourceSHA256.toLowerCase(),
    units: "m",
    root_id: rootID,
    triangle_count: triangles,
    occurrences,
  };
  assertManifestSize(response);
  return response;
}

export function normalizeMappings(mappings, occurrenceIDs) {
  if (!Array.isArray(mappings) || mappings.length > LIMITS.maxOccurrences) {
    throw new Error("invalid mapping count");
  }
  const normalized = new Map();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("invalid mapping");
    const allowed = new Set(["occurrence_id", "display_name", "semantic_role", "material_field_key", "surface_finish"]);
    for (const key of Object.keys(mapping)) if (!allowed.has(key)) throw new Error(`unknown mapping field: ${key}`);
    if (typeof mapping.occurrence_id !== "string" || !occurrenceIDs.has(mapping.occurrence_id)) {
      throw new Error("unknown occurrence in mapping");
    }
    if (normalized.has(mapping.occurrence_id)) throw new Error("duplicate occurrence mapping");
    const role = mapping.semantic_role ?? "unassigned";
    if (!ROLES.includes(role)) throw new Error("invalid semantic role");
    const displayName = mapping.display_name ?? null;
    if (displayName !== null && (typeof displayName !== "string" || !displayName.trim() || displayName.length > 200)) {
      throw new Error("invalid display name");
    }
    const materialKey = mapping.material_field_key ?? null;
    if (materialKey !== null && (typeof materialKey !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(materialKey))) {
      throw new Error("invalid material field key");
    }
    const surfaceFinish = mapping.surface_finish ?? "inherit";
    if (!SURFACE_FINISHES.includes(surfaceFinish)) throw new Error("invalid surface finish");
    normalized.set(mapping.occurrence_id, {
      occurrence_id: mapping.occurrence_id,
      display_name: displayName,
      semantic_role: role,
      material_field_key: materialKey,
      surface_finish: surfaceFinish,
    });
  }
  return normalized;
}

export function installFileReaderPolyfill() {
  if (globalThis.FileReader) return;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      }).catch((error) => this.onerror?.(error));
    }

    readAsDataURL(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(result).toString("base64")}`;
        this.onloadend?.();
      }).catch((error) => this.onerror?.(error));
    }
  };
}

export function geometryFor(mesh) {
  const positionsSource = mesh?.attributes?.position?.array;
  if (!positionsSource?.length) throw new Error("mesh has no position data");
  const geometry = new THREE.BufferGeometry();
  const positions = Float32Array.from(positionsSource);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (mesh.attributes.normal?.array) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
  } else {
    geometry.computeVertexNormals();
  }
  const sourceIndices = mesh?.index?.array;
  triangleCount(mesh);
  const indices = [];
  for (let index = 0; index < sourceIndices.length; index += 3) {
    const a = sourceIndices[index] * 3;
    const b = sourceIndices[index + 1] * 3;
    const c = sourceIndices[index + 2] * 3;
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const acX = positions[c] - positions[a];
    const acY = positions[c + 1] - positions[a + 1];
    const acZ = positions[c + 2] - positions[a + 2];
    const crossX = abY * acZ - abZ * acY;
    const crossY = abZ * acX - abX * acZ;
    const crossZ = abX * acY - abY * acX;
    if (crossX ** 2 + crossY ** 2 + crossZ ** 2 > 1e-30) {
      indices.push(sourceIndices[index], sourceIndices[index + 1], sourceIndices[index + 2]);
    }
  }
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function sceneFor(imported, inspection, mappings) {
  const scene = new THREE.Group();
  scene.name = "STEP assembly";
  scene.userData = { source_units: "m", source_sha256: inspection.source_sha256 };
  const objects = new Map();
  const geometries = new Map();
  for (const occurrence of inspection.occurrences) {
    const mapping = mappings.get(occurrence.id);
    const displayName = mapping?.display_name ?? occurrence.source_name ?? occurrence.id;
    const extras = {
      step2glb_occurrence_id: occurrence.id,
      step2glb_definition_id: occurrence.definition_id,
      step2glb_display_name: displayName,
      step2glb_semantic_role: mapping?.semantic_role ?? "unassigned",
      step2glb_material_field_key: mapping?.material_field_key ?? null,
      step2glb_surface_finish: mapping?.surface_finish ?? "inherit",
      source_name: occurrence.source_name,
    };
    let geometry;
    if (occurrence.node_kind === "part") {
      geometry = geometries.get(occurrence.mesh_index);
      if (!geometry) {
        geometry = geometryFor(imported.meshes[occurrence.mesh_index]);
        geometries.set(occurrence.mesh_index, geometry);
      }
    }
    const object = occurrence.node_kind === "part"
      ? new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xd7c6a5, metalness: 0, roughness: 0.72,
      }))
      : new THREE.Group();
    object.name = displayName;
    object.userData = extras;
    object.visible = mapping?.semantic_role !== "ignore";
    objects.set(occurrence.id, object);
    if (occurrence.parent_id === null) scene.add(object);
    else {
      const parent = objects.get(occurrence.parent_id);
      if (!parent) throw new Error("invalid occurrence order");
      parent.add(object);
    }
  }
  return scene;
}

export function exportGLB(scene) {
  installFileReaderPolyfill();
  return new Promise((resolveExport, reject) => {
    new GLTFExporter().parse(scene, (result) => {
      if (!(result instanceof ArrayBuffer)) return reject(new Error("GLTFExporter returned JSON instead of binary GLB"));
      resolveExport(Buffer.from(result));
    }, reject, { binary: true, trs: false, onlyVisible: true });
  }).then(compressGLB);
}

export async function compressGLB(bytes) {
  const encoder = await dracoEncoderPromise;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.encoder": encoder });
  const document = await io.readBinary(new Uint8Array(bytes));
  document.setLogger(new Logger(Logger.Verbosity.SILENT));
  await document.transform(draco({
    quantizePosition: 24,
    quantizeNormal: 12,
  }));
  return Buffer.from(await io.writeBinary(document));
}

export function assertGLB(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.length > LIMITS.maxOutputBytes ||
      bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error("invalid or oversized GLB output");
  }
}

export function assertManifestSize(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > LIMITS.maxManifestBytes) throw new Error("manifest limit exceeded");
  return bytes;
}

function validateNativeDocument(json) {
  if ([...(json.buffers ?? []), ...(json.images ?? [])].some((item) => item.uri)) {
    throw new Error("external GLB resources are not allowed");
  }
  if (json.animations?.length || json.skins?.length) throw new Error("only static GLB assemblies are supported");
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const widths = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let decodedBytes = 0;
  for (const accessor of json.accessors ?? []) {
    if (!Object.hasOwn(sizes, accessor.type) || !Object.hasOwn(widths, accessor.componentType)
      || !Number.isSafeInteger(accessor.count) || accessor.count <= 0) throw new Error("invalid GLB accessor");
    decodedBytes += accessor.count * sizes[accessor.type] * widths[accessor.componentType];
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > LIMITS.maxOutputBytes * 8) {
      throw new Error("GLB accessor allocation limit exceeded");
    }
    if (accessor.sparse && (!Number.isSafeInteger(accessor.sparse.count)
      || accessor.sparse.count < 0 || accessor.sparse.count > accessor.count)) throw new Error("invalid sparse accessor");
  }
  const nodes = json.nodes ?? [];
  if (nodes.length + 1 > LIMITS.maxOccurrences) throw new Error("occurrence limit exceeded");
  if (json.scenes?.length !== 1) throw new Error("one GLB assembly scene is required");
  const seen = new Set();
  const walk = (index, depth) => {
    if (depth > LIMITS.maxDepth || seen.has(index) || !nodes[index]) throw new Error("invalid GLB hierarchy or cycle");
    seen.add(index);
    for (const child of nodes[index].children ?? []) walk(child, depth + 1);
  };
  for (const index of json.scenes[0].nodes ?? []) walk(index, 1);
  if (seen.size !== nodes.length) throw new Error("unreachable GLB hierarchy nodes");
  let vertices = 0;
  for (const mesh of json.meshes ?? []) {
    if (mesh.primitives?.length !== 1) throw new Error("native assemblies require one primitive per mesh; split material parts before exporting");
    for (const primitive of mesh.primitives ?? []) {
      const positions = json.accessors?.[primitive.attributes?.POSITION];
      if (!positions || positions.type !== "VEC3" || !Number.isSafeInteger(positions.count) || positions.count <= 0) {
        throw new Error("invalid GLB position accessor");
      }
      vertices += positions.count;
      if (vertices > LIMITS.maxVertices) throw new Error("aggregate vertex limit exceeded");
      if ((primitive.mode ?? 4) !== 4) throw new Error("GLB assembly requires triangle meshes");
      const count = primitive.indices === undefined ? positions.count : json.accessors?.[primitive.indices]?.count;
      if (!Number.isSafeInteger(count) || count % 3 || count > LIMITS.maxTriangles * 3) throw new Error("invalid triangle count");
    }
  }
  if ((json.buffers ?? []).some((buffer) => !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength > LIMITS.maxOutputBytes)) {
    throw new Error("GLB buffer limit exceeded");
  }
}

export async function importNativeAssembly(bytes, hash) {
  assertGLB(bytes);
  const json = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
  validateNativeDocument(json);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule({}),
    "draco3d.encoder": await draco3d.createEncoderModule({}),
  });
  const document = await io.readBinary(bytes);
  const rootID = stableID("occ", "native-root");
  const occurrences = [{
    id: rootID, parent_id: null, definition_id: rootID, source_name: "GLB assembly",
    node_kind: "assembly", mesh_index: null, transform: [...identity],
  }];
  const nodeByID = new Map();
  let triangles = 0;
  let meshIndex = 0;
  const walk = (node, parentID, path) => {
    const id = stableID("occ", path);
    const mesh = node.getMesh();
    for (const primitive of mesh?.listPrimitives() ?? []) {
      const position = primitive.getAttribute("POSITION");
      if (!Array.from(position.getArray()).every(Number.isFinite)) throw new Error("non-finite GLB geometry");
      const indices = primitive.getIndices();
      if (indices && !Array.from(indices.getArray()).every((value) => Number.isInteger(value) && value >= 0 && value < position.getCount())) {
        throw new Error("invalid GLB triangle indices");
      }
      triangles += (indices?.getCount() ?? position.getCount()) / 3;
    }
    if (triangles > LIMITS.maxTriangles) throw new Error("triangle limit exceeded");
    const transform = node.getMatrix();
    if (!transform.every(Number.isFinite)) throw new Error("non-finite GLB transform");
    occurrences.push({
      id, parent_id: parentID, definition_id: id, source_name: node.getName() || "unnamed",
      node_kind: mesh ? "part" : "assembly", mesh_index: mesh ? meshIndex++ : null, transform,
    });
    nodeByID.set(id, node);
    node.listChildren().forEach((child, index) => walk(child, id, `${path}/${index}`));
  };
  document.getRoot().listScenes()[0].listChildren().forEach((node, index) => walk(node, rootID, `native/${index}`));
  const inspection = {
    version: 1, operation: "inspect", source_sha256: hash, units: "m",
    root_id: rootID, triangle_count: triangles, occurrences,
  };
  assertManifestSize(inspection);
  return {
    inspection,
    async build(mappings) {
      for (const [id, node] of nodeByID) {
        const mapping = mappings.get(id);
        const extras = node.getExtras();
        node.setName(mapping?.display_name ?? node.getName());
        node.setExtras({
          ...extras,
          step2glb_occurrence_id: id,
          step2glb_display_name: node.getName(),
          step2glb_semantic_role: mapping?.semantic_role ?? extras.step2glb_semantic_role ?? "unassigned",
          step2glb_material_field_key: mapping ? mapping.material_field_key : extras.step2glb_material_field_key ?? null,
          step2glb_surface_finish: mapping?.surface_finish ?? extras.step2glb_surface_finish ?? "inherit",
        });
      }
      return Buffer.from(await io.writeBinary(document));
    },
  };
}

/**
 * Reads a STEP or GLB source and returns the assembly manifest. STEP geometry
 * comes back in meters. The manifest lists every occurrence with a stable ID.
 */
export async function inspectSource(bytes, sourceSHA256) {
  if (isGLB(bytes)) {
    const native = await importNativeAssembly(bytes, sourceSHA256);
    return { native, imported: null, inspection: native.inspection };
  }
  const imported = (await occt()).ReadStepFile(new Uint8Array(bytes), { linearUnit: "meter" });
  return { native: null, imported, inspection: inspectImport(imported, sourceSHA256) };
}

/**
 * Builds a Draco-compressed GLB from a source and a list of occurrence
 * mappings. The same input produces the same bytes.
 */
export async function buildSource(source, mappings = []) {
  const normalized = normalizeMappings(
    mappings,
    new Set(source.inspection.occurrences.map((occurrence) => occurrence.id)),
  );
  const bytes = source.native
    ? await source.native.build(normalized)
    : await exportGLB(sceneFor(source.imported, source.inspection, normalized));
  assertGLB(bytes);
  return bytes;
}
