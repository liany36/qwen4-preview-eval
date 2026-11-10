// SVG floor plan → metric meshes. 100 SVG units = 1 metre. Wall thickness is visual only.

export const WALL_HEIGHT = 2.8;
export const WALL_THICKNESS = 0.1;

export const MATERIALS = {
  wall: { color: [0.93, 0.91, 0.86, 1], roughness: 0.9, metalness: 0 },
  floor: { color: [0.62, 0.55, 0.46, 1], roughness: 0.95, metalness: 0 },
  window: { color: [0.29, 0.58, 0.78, 0.42], roughness: 0.08, metalness: 0, alpha: true },
  table: { color: [0.66, 0.45, 0.26, 1], roughness: 0.58, metalness: 0 },
  chair: { color: [0.24, 0.34, 0.4, 1], roughness: 0.62, metalness: 0.04 },
  cabinet: { color: [0.42, 0.29, 0.18, 1], roughness: 0.55, metalness: 0 },
  cabinetDoor: { color: [0.55, 0.4, 0.26, 1], roughness: 0.48, metalness: 0 }
};

function attr(source, name) {
  const match = source.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(['\"])(.*?)\\1", "i"));
  return match ? match[2] : null;
}

function classesOf(source) {
  const value = attr(source, "class");
  return value ? value.trim().split(/\s+/) : [];
}

function kindOf(source) {
  const classes = classesOf(source);
  if (classes.includes("wall")) return "wall";
  if (classes.includes("door")) return "door";
  if (classes.includes("window")) return "window";
  return null;
}

function num(source, name) {
  const value = attr(source, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFloorplan(svgText) {
  const segs = [];
  for (const match of svgText.matchAll(/<line\b([^>]*)\/?>/gi)) {
    const kind = kindOf(match[1]);
    if (!kind) continue;
    const x1 = num(match[1], "x1");
    const y1 = num(match[1], "y1");
    const x2 = num(match[1], "x2");
    const y2 = num(match[1], "y2");
    if ([x1, y1, x2, y2].some((v) => v === null)) continue;
    segs.push({ kind, x1, y1, x2, y2 });
  }
  if (!segs.some((seg) => seg.kind === "wall")) {
    throw new Error("SVG 里没有 class=wall 的 line");
  }

  const xs = [];
  const ys = [];
  for (const seg of segs) {
    xs.push(seg.x1, seg.x2);
    ys.push(seg.y1, seg.y2);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const widthM = (maxX - minX) / 100;
  const depthM = (maxY - minY) / 100;

  function toXZ(x, y) {
    return {
      x: (x - minX) / 100 - widthM / 2,
      z: (y - minY) / 100 - depthM / 2
    };
  }

  const wallSegments = [];
  for (const seg of segs) {
    if (seg.kind !== "wall") continue;
    const a = toXZ(seg.x1, seg.y1);
    const b = toXZ(seg.x2, seg.y2);
    wallSegments.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z });
  }

  const rooms = [];
  for (const match of svgText.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)) {
    const name = match[2].trim();
    const x = num(match[1], "x");
    const y = num(match[1], "y");
    if (!name || x === null || y === null) continue;
    const point = toXZ(x, y);
    const inside =
      point.x >= -widthM / 2 &&
      point.x <= widthM / 2 &&
      point.z >= -depthM / 2 &&
      point.z <= depthM / 2;
    if (!inside) continue;
    rooms.push({ name, x: point.x, z: point.z });
  }

  return { widthM, depthM, minX, maxX, minY, maxY, segs, wallSegments, rooms, toXZ };
}

export function formatSize(plan) {
  return `总宽 ${plan.widthM.toFixed(2)} m × 总深 ${plan.depthM.toFixed(2)} m`;
}

function neg(v) {
  return [-v[0], -v[1], -v[2]];
}

function axes(rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return {
    ax: [c, 0, s],
    ay: [0, 1, 0],
    az: [-s, 0, c]
  };
}

function emitBox(center, rot, sx, sy, sz) {
  const { ax, ay, az } = axes(rot);
  const positions = [];
  const normals = [];
  const indices = [];
  const faces = [
    [ax, ay, az, sx / 2, sy / 2, sz / 2],
    [neg(ax), ay, neg(az), sx / 2, sy / 2, sz / 2],
    [ay, az, ax, sy / 2, sz / 2, sx / 2],
    [neg(ay), ax, az, sy / 2, sx / 2, sz / 2],
    [az, ax, ay, sz / 2, sx / 2, sy / 2],
    [neg(az), ay, ax, sz / 2, sy / 2, sx / 2]
  ];
  for (const [n, u, v, hn, hu, hv] of faces) {
    const base = positions.length / 3;
    const corners = [
      [-hu, -hv],
      [hu, -hv],
      [hu, hv],
      [-hu, hv]
    ];
    for (const [cu, cv] of corners) {
      positions.push(
        center[0] + n[0] * hn + u[0] * cu + v[0] * cv,
        center[1] + n[1] * hn + u[1] * cu + v[1] * cv,
        center[2] + n[2] * hn + u[2] * cu + v[2] * cv
      );
      normals.push(n[0], n[1], n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices
  };
}

function segmentPart({ name, material, a, b, y0, height, thickness, shift }) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const rot = Math.atan2(dz, dx);
  const { az } = axes(rot);
  const along = shift || 0;
  const center = [
    (a.x + b.x) / 2 + az[0] * along,
    y0 + height / 2,
    (a.z + b.z) / 2 + az[2] * along
  ];
  return {
    name,
    material,
    obb: {
      cx: center[0],
      cy: center[1],
      cz: center[2],
      hx: len / 2,
      hy: height / 2,
      hz: thickness / 2,
      rot
    },
    ...emitBox(center, rot, len, height, thickness)
  };
}

export function buildRoomParts(plan) {
  const parts = [];
  let wallIndex = 0;
  let windowIndex = 0;
  for (const seg of plan.segs) {
    const a = plan.toXZ(seg.x1, seg.y1);
    const b = plan.toXZ(seg.x2, seg.y2);
    if (seg.kind === "wall") {
      const part = segmentPart({
        name: `wall_${wallIndex}`,
        material: "wall",
        a,
        b,
        y0: 0,
        height: WALL_HEIGHT,
        thickness: WALL_THICKNESS,
        shift: 0
      });
      wallIndex += 1;
      if (part) parts.push(part);
    } else if (seg.kind === "window") {
      const part = segmentPart({
        name: `window_${windowIndex}`,
        material: "window",
        a,
        b,
        y0: 0.9,
        height: 1.2,
        thickness: 0.02,
        shift: WALL_THICKNESS / 2 + 0.012
      });
      windowIndex += 1;
      if (part) parts.push(part);
    }
  }
  const floor = emitBox([0, -0.02, 0], 0, plan.widthM, 0.04, plan.depthM);
  parts.push({
    name: "floor",
    material: "floor",
    ...floor
  });
  return parts;
}

function localBox(material, center, sx, sy, sz) {
  return { material, ...emitBox(center, 0, sx, sy, sz) };
}

export function furnitureBlueprint(kind) {
  if (kind === "table") {
    const x = 0.6 - 0.08;
    const z = 0.35 - 0.08;
    return {
      label: "桌子",
      halfX: 0.6,
      halfZ: 0.35,
      pieces: [
        localBox("table", [0, 0.735, 0], 1.2, 0.05, 0.7),
        localBox("table", [-x, 0.355, -z], 0.06, 0.71, 0.06),
        localBox("table", [x, 0.355, -z], 0.06, 0.71, 0.06),
        localBox("table", [-x, 0.355, z], 0.06, 0.71, 0.06),
        localBox("table", [x, 0.355, z], 0.06, 0.71, 0.06)
      ]
    };
  }
  if (kind === "chair") {
    const x = 0.16;
    const z = 0.16;
    return {
      label: "椅子",
      halfX: 0.23,
      halfZ: 0.23,
      pieces: [
        localBox("chair", [0, 0.46, 0], 0.46, 0.045, 0.46),
        localBox("chair", [0, 0.7, -0.2], 0.46, 0.46, 0.04),
        localBox("chair", [-x, 0.22, -z], 0.04, 0.44, 0.04),
        localBox("chair", [x, 0.22, -z], 0.04, 0.44, 0.04),
        localBox("chair", [-x, 0.22, z], 0.04, 0.44, 0.04),
        localBox("chair", [x, 0.22, z], 0.04, 0.44, 0.04)
      ]
    };
  }
  if (kind === "cabinet") {
    return {
      label: "柜子",
      halfX: 0.4,
      halfZ: 0.21,
      pieces: [
        localBox("cabinet", [0, 0.55, -0.01], 0.8, 1.1, 0.38),
        localBox("cabinetDoor", [0, 0.58, 0.2], 0.68, 0.92, 0.02)
      ]
    };
  }
  throw new Error("未知家具: " + kind);
}

function align4(n) {
  return (n + 3) & ~3;
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function encodeGLB(parts) {
  const binChunks = [];
  let cursor = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const usedMaterials = [];
  const materialIndex = new Map();

  function padTo4() {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      binChunks.push(new Uint8Array(pad));
      cursor += pad;
    }
  }

  function pushBytes(bytes, target) {
    padTo4();
    const byteOffset = cursor;
    binChunks.push(bytes);
    cursor += bytes.byteLength;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      target
    });
    return bufferViews.length - 1;
  }

  function materialFor(name) {
    if (materialIndex.has(name)) return materialIndex.get(name);
    const src = MATERIALS[name] || { color: [0.7, 0.7, 0.7, 1], roughness: 0.8, metalness: 0 };
    const index = usedMaterials.length;
    materialIndex.set(name, index);
    const material = {
      name,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [
          srgbToLinear(src.color[0]),
          srgbToLinear(src.color[1]),
          srgbToLinear(src.color[2]),
          src.color[3]
        ],
        metallicFactor: src.metalness,
        roughnessFactor: src.roughness
      }
    };
    if (src.alpha) material.alphaMode = "BLEND";
    usedMaterials.push(material);
    return index;
  }

  const meshNodeIndices = [];
  for (const part of parts) {
    const positions = part.positions;
    const normals = part.normals;
    const indexArray = part.indices.length > 65535 ? Uint32Array.from(part.indices) : Uint16Array.from(part.indices);
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    const positionView = pushBytes(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 34962);
    const normalView = pushBytes(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength), 34962);
    const indexView = pushBytes(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength), 34963);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min,
      max
    });
    accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: normals.length / 3,
      type: "VEC3"
    });
    accessors.push({
      bufferView: indexView,
      componentType: indexArray instanceof Uint32Array ? 5125 : 5123,
      count: indexArray.length,
      type: "SCALAR"
    });
    const meshIndex = meshes.length;
    meshes.push({
      name: part.name,
      primitives: [
        {
          mode: 4,
          attributes: { POSITION: positionAccessor, NORMAL: positionAccessor + 1 },
          indices: positionAccessor + 2,
          material: materialFor(part.material)
        }
      ]
    });
    meshNodeIndices.push(nodes.length);
    nodes.push({ name: part.name, mesh: meshIndex });
  }

  nodes.unshift({ name: "Room", children: meshNodeIndices.map((index) => index + 1) });

  padTo4();
  const bin = new Uint8Array(cursor);
  let offset = 0;
  for (const chunk of binChunks) {
    bin.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const json = JSON.stringify({
    asset: { version: "2.0", generator: "floorplan" },
    scene: 0,
    scenes: [{ name: "Room", nodes: [0] }],
    nodes,
    meshes,
    materials: usedMaterials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }]
  });
  const encoded = new TextEncoder().encode(json);
  const jsonChunk = new Uint8Array(align4(encoded.length));
  jsonChunk.set(encoded);
  jsonChunk.fill(0x20, encoded.length);

  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  const binHeader = 20 + jsonChunk.length;
  view.setUint32(binHeader, bin.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(6) : "0.000000";
}

export function encodeOBJ(parts) {
  let obj = "mtllib out.mtl\n";
  let mtl = "# floorplan materials, metres, Y-up\n";
  const seen = new Set();
  let base = 1;
  for (const part of parts) {
    if (!seen.has(part.material)) {
      seen.add(part.material);
      const src = MATERIALS[part.material] || { color: [0.7, 0.7, 0.7, 1] };
      const c = src.color;
      mtl += `newmtl ${part.material}\nKd ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}\nKa 0.020000 0.020000 0.020000\nd ${fmt(c[3])}\nillum 2\n\n`;
    }
    obj += `o ${part.name}\nusemtl ${part.material}\n`;
    const { positions, normals, indices } = part;
    for (let i = 0; i < positions.length; i += 3) {
      obj += `v ${fmt(positions[i])} ${fmt(positions[i + 1])} ${fmt(positions[i + 2])}\n`;
    }
    for (let i = 0; i < normals.length; i += 3) {
      obj += `vn ${fmt(normals[i])} ${fmt(normals[i + 1])} ${fmt(normals[i + 2])}\n`;
    }
    for (let i = 0; i < indices.length; i += 3) {
      const a = base + indices[i];
      const b = base + indices[i + 1];
      const c = base + indices[i + 2];
      obj += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
    }
    base += positions.length / 3;
  }
  return { obj, mtl };
}
