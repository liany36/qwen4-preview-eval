import { readFileSync, writeFileSync } from "node:fs";
import { parseFloorplan, buildRoomParts, encodeGLB, encodeOBJ } from "./floorplan.js";

const svg = readFileSync(new URL("./floorplan.svg", import.meta.url), "utf8");
const plan = parseFloorplan(svg);
const parts = buildRoomParts(plan);
const glb = encodeGLB(parts);
writeFileSync(new URL("./out.glb", import.meta.url), glb);
const { obj, mtl } = encodeOBJ(parts);
writeFileSync(new URL("./out.obj", import.meta.url), obj);
writeFileSync(new URL("./out.mtl", import.meta.url), mtl);

function pointInObb(o, x, y, z) {
  const dx = x - o.cx;
  const dy = y - o.cy;
  const dz = z - o.cz;
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  return Math.abs(lx) <= o.hx + 1e-3 && Math.abs(dy) <= o.hy + 1e-3 && Math.abs(lz) <= o.hz + 1e-3;
}

const blocked = [];
for (const seg of plan.segs) {
  if (seg.kind !== "door") continue;
  const a = plan.toXZ(seg.x1, seg.y1);
  const b = plan.toXZ(seg.x2, seg.y2);
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  for (const part of parts) {
    if (!part.obb || !part.name.startsWith("wall_")) continue;
    if (pointInObb(part.obb, mx, 1.2, mz)) blocked.push(part.name);
  }
}
if (blocked.length) {
  console.error("door occupied by", blocked.join(","));
  process.exit(1);
}

const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const magic = view.getUint32(0, true);
const version = view.getUint32(4, true);
const length = view.getUint32(8, true);
if (magic !== 0x46546c67 || version !== 2 || length !== glb.length) {
  console.error("bad glb header", magic.toString(16), version, length, glb.length);
  process.exit(1);
}
const jsonLen = view.getUint32(12, true);
const jsonType = view.getUint32(16, true);
if (jsonType !== 0x4e4f534a) {
  console.error("missing JSON chunk");
  process.exit(1);
}
const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)).trim();
const doc = JSON.parse(jsonText);
if (doc.asset.version !== "2.0") process.exit(1);
if (doc.buffers[0].byteLength + 20 + jsonLen + 8 !== glb.length) {
  console.error("bin length mismatch");
  process.exit(1);
}

let maxY = -Infinity;
for (const part of parts) {
  for (let i = 1; i < part.positions.length; i += 3) maxY = Math.max(maxY, part.positions[i]);
}
if (Math.abs(maxY - 2.8) > 0.02) {
  console.error("wall height", maxY);
  process.exit(1);
}

console.log(JSON.stringify({
  size: `总宽 ${plan.widthM.toFixed(2)} m × 总深 ${plan.depthM.toFixed(2)} m`,
  rooms: plan.rooms.map((r) => r.name),
  parts: parts.map((p) => p.name),
  glbBytes: glb.length,
  objBytes: Buffer.byteLength(obj),
  mtlBytes: Buffer.byteLength(mtl)
}));
