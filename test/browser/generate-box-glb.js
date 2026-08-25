/**
 * A checked-in generator for the Box.glb test fixture. Produces a minimal
 * valid GLB (binary glTF) for the renderer Component's pinned supported
 * subset: one mesh, one primitive, POSITION + NORMAL float32 non-interleaved
 * accessors, uint16 indices, no materials/textures.
 *
 * A checked-in generator (not a bare binary fixture) keeps the asset
 * reproducible — the same discipline as the Component toolchain script.
 *
 * Usage: node test/browser/generate-box-glb.js  -> writes test/browser/box.glb
 */

import {writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// A unit cube centered at the origin: 24 vertices (4 per face, so each face
// has flat normals), 36 indices (12 triangles).
function boxData() {
  const positions = [];
  const normals = [];
  const indices = [];
  // Each face: normal, 4 corner positions (CCW), then 2 triangles.
  const faces = [
    {n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]},
    {n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]},
    {n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]},
    {n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]},
    {n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]},
    {n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]},
  ];
  for (const face of faces) {
    const base = positions.length;
    for (const corner of face.c) {
      positions.push(corner);
      normals.push(face.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {positions, normals, indices};
}

function buildGlb() {
  const {positions, normals, indices} = boxData();

  // Lay out the BIN chunk: positions | normals | indices (each aligned to 4).
  const posBytes = new Float32Array(positions.flat());
  const nrmBytes = new Float32Array(normals.flat());
  const idxBytes = new Uint16Array(indices);
  const pad4 = (n) => (4 - (n % 4)) % 4;

  const posOffset = 0;
  const nrmOffset = posOffset + posBytes.byteLength;
  const idxOffset = nrmOffset + nrmBytes.byteLength;
  const binLength = idxOffset + idxBytes.byteLength + pad4(idxBytes.byteLength);

  const bin = new ArrayBuffer(binLength);
  new Float32Array(bin, posOffset, posBytes.length).set(posBytes);
  new Float32Array(bin, nrmOffset, nrmBytes.length).set(nrmBytes);
  new Uint16Array(bin, idxOffset, idxBytes.length).set(idxBytes);

  const gltf = {
    asset: {version: '2.0', generator: 'lagrange generate-box-glb.js'},
    scene: 0,
    scenes: [{nodes: [0]}],
    nodes: [{mesh: 0}],
    meshes: [{
      primitives: [{
        attributes: {POSITION: 0, NORMAL: 1},
        indices: 2,
      }],
    }],
    buffers: [{byteLength: binLength}],
    bufferViews: [
      {buffer: 0, byteOffset: posOffset, byteLength: posBytes.byteLength},
      {buffer: 0, byteOffset: nrmOffset, byteLength: nrmBytes.byteLength},
      {buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength},
    ],
    accessors: [
      {bufferView: 0, componentType: 5126, count: posBytes.length / 3, type: 'VEC3'},
      {bufferView: 1, componentType: 5126, count: nrmBytes.length / 3, type: 'VEC3'},
      {bufferView: 2, componentType: 5123, count: idxBytes.length, type: 'SCALAR'},
    ],
  };

  let jsonStr = JSON.stringify(gltf);
  while (jsonStr.length % 4 !== 0) jsonStr += ' ';
  const jsonBytes = Buffer.from(jsonStr, 'utf8');

  const totalLength = 12 + 8 + jsonBytes.length + 8 + binLength;
  const out = Buffer.alloc(totalLength);
  let o = 0;
  // Header
  out.writeUInt32LE(0x46546C67, o); o += 4; // "glTF"
  out.writeUInt32LE(2, o); o += 4; // version
  out.writeUInt32LE(totalLength, o); o += 4;
  // JSON chunk
  out.writeUInt32LE(jsonBytes.length, o); o += 4;
  out.writeUInt32LE(0x4E4F534A, o); o += 4; // "JSON"
  jsonBytes.copy(out, o); o += jsonBytes.length;
  // BIN chunk
  out.writeUInt32LE(binLength, o); o += 4;
  out.writeUInt32LE(0x004E4942, o); o += 4; // "BIN\0"
  Buffer.from(bin).copy(out, o);
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'box.glb');
writeFileSync(target, buildGlb());
console.log(`wrote ${target}`);
