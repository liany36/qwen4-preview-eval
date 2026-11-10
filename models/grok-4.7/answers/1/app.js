import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  MATERIALS,
  parseFloorplan,
  formatSize,
  buildRoomParts,
  furnitureBlueprint,
  encodeGLB,
  encodeOBJ
} from "./floorplan.js";

const viewport = document.getElementById("viewport");
const sizeNodes = document.querySelectorAll("[data-size]");
const roomList = document.getElementById("rooms");
const warn = document.getElementById("warn");
const manifest = document.getElementById("manifest");
const selectionLabel = document.getElementById("selection");
const sourceNote = document.getElementById("source");
const fileInput = document.getElementById("file");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xe6e0d4, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xe6e0d4, 18, 36);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.target.set(0, 0.7, 0);

scene.add(new THREE.HemisphereLight(0xf7f1e6, 0x8d7c68, 0.95));
const sun = new THREE.DirectionalLight(0xfff6ea, 1.35);
sun.position.set(6, 12, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 40;
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -8;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xd5e4f2, 0.35);
fill.position.set(-5, 6, -3);
scene.add(fill);

const roomGroup = new THREE.Group();
roomGroup.name = "room";
const furnitureGroup = new THREE.Group();
furnitureGroup.name = "furniture";
scene.add(roomGroup, furnitureGroup);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();

let plan = null;
let grid = null;
let selected = null;
let dragging = null;
let catalogDrag = null;
let press = null;
const counts = { table: 0, chair: 0, cabinet: 0 };
const labelLayer = document.getElementById("labels");

function makeMaterial(name) {
  const src = MATERIALS[name];
  const color = new THREE.Color();
  color.setRGB(src.color[0], src.color[1], src.color[2], THREE.SRGBColorSpace);
  return new THREE.MeshStandardMaterial({
    name,
    color,
    roughness: src.roughness,
    metalness: src.metalness,
    transparent: !!src.alpha,
    opacity: src.color[3],
    side: THREE.DoubleSide,
    depthWrite: !src.alpha,
    polygonOffset: !!src.alpha,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
}

function makeMesh(part, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
  geometry.setIndex(part.indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = part.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function disposeTree(root) {
  const removed = [...root.children];
  for (const child of removed) {
    root.remove(child);
    child.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        list.forEach((item) => item.dispose());
      }
    });
  }
}

function frameCamera() {
  const span = Math.max(plan.widthM, plan.depthM);
  camera.position.set(span * 0.95, span * 1.15, span * 1.05);
  controls.target.set(0, 0.6, 0);
  controls.update();
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.updateProjectionMatrix();
}

function applySvg(text) {
  const next = parseFloorplan(text);
  const parts = buildRoomParts(next);
  disposeTree(roomGroup);
  disposeTree(furnitureGroup);
  selected = null;
  dragging = null;
  counts.table = 0;
  counts.chair = 0;
  counts.cabinet = 0;
  plan = next;
  const shared = new Map();
  for (const part of parts) {
    if (!shared.has(part.material)) shared.set(part.material, makeMaterial(part.material));
    roomGroup.add(makeMesh(part, shared.get(part.material)));
  }
  if (grid) scene.remove(grid);
  const extent = Math.max(plan.widthM, plan.depthM);
  grid = new THREE.GridHelper(extent, Math.max(2, Math.round(extent / 0.5)), 0xb7aa96, 0xd2c8b8);
  grid.position.y = 0.008;
  scene.add(grid);
  for (const node of sizeNodes) node.textContent = formatSize(plan);
  roomList.replaceChildren();
  for (const room of plan.rooms) {
    const item = document.createElement("li");
    item.textContent = room.name;
    roomList.appendChild(item);
  }
  layoutLabelNodes();
  frameCamera();
  refreshSelection();
  refreshWarnings();
  refreshManifest();
}

function layoutLabelNodes() {
  labelLayer.replaceChildren();
  if (!plan) return;
  for (const room of plan.rooms) {
    const el = document.createElement("div");
    el.className = "room-label";
    el.textContent = room.name;
    el.dataset.x = String(room.x);
    el.dataset.z = String(room.z);
    labelLayer.appendChild(el);
  }
}

function projectLabels() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  for (const el of labelLayer.children) {
    const point = new THREE.Vector3(Number(el.dataset.x), 0.05, Number(el.dataset.z));
    point.project(camera);
    if (point.z > 1) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "block";
    el.style.left = `${(point.x * 0.5 + 0.5) * width}px`;
    el.style.top = `${(-point.y * 0.5 + 0.5) * height}px`;
  }
}

function snap(value) {
  return Math.round(value * 10) / 10;
}

function spawn(kind, x, z) {
  const blueprint = furnitureBlueprint(kind);
  counts[kind] += 1;
  const group = new THREE.Group();
  group.name = `${kind}_${counts[kind]}`;
  group.userData.kind = kind;
  group.userData.label = blueprint.label;
  group.userData.halfX = blueprint.halfX;
  group.userData.halfZ = blueprint.halfZ;
  blueprint.pieces.forEach((piece, index) => {
    const mesh = makeMesh(piece, makeMaterial(piece.material));
    mesh.name = `${group.name}_${index}`;
    group.add(mesh);
  });
  group.position.set(snap(x), 0, snap(z));
  furnitureGroup.add(group);
  select(group);
  refreshWarnings();
  refreshManifest();
}

function furnitureRoot(object) {
  let current = object;
  while (current && current.parent !== furnitureGroup) current = current.parent;
  return current;
}

function setPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function groundPoint(event) {
  setPointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.intersectPlane(ground, groundHit);
  return hit ? groundHit.clone() : null;
}

function pickFurniture(event) {
  setPointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(furnitureGroup.children, true);
  if (!hits.length) return null;
  return furnitureRoot(hits[0].object);
}

function paint(group, hex) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.isMesh && obj.material && obj.material.emissive) obj.material.emissive.setHex(hex);
  });
}

function select(group) {
  if (selected && selected !== group) paint(selected, 0x000000);
  selected = group;
  if (selected) paint(selected, 0x6b4a22);
  refreshSelection();
}

function refreshSelection() {
  if (!selected) {
    selectionLabel.textContent = "未选中家具";
    return;
  }
  const deg = Math.round(THREE.MathUtils.radToDeg(selected.rotation.y));
  selectionLabel.textContent = `${selected.userData.label} ${selected.name} · x ${selected.position.x.toFixed(1)} · z ${selected.position.z.toFixed(1)} · ${deg}°`;
}

function segmentHitsOBB(item, wall) {
  const rot = -item.rotation.y;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const local = (x, z) => {
    const dx = x - item.position.x;
    const dz = z - item.position.z;
    return { x: dx * c + dz * s, z: -dx * s + dz * c };
  };
  const a = local(wall.x1, wall.z1);
  const b = local(wall.x2, wall.z2);
  const minX = -item.userData.halfX - 0.05;
  const maxX = item.userData.halfX + 0.05;
  const minZ = -item.userData.halfZ - 0.05;
  const maxZ = item.userData.halfZ + 0.05;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const checks = [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dz, a.z - minZ],
    [dz, maxZ - a.z]
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

function obbOverlap(a, b) {
  const axes = [a.rotation.y, a.rotation.y + Math.PI / 2, b.rotation.y, b.rotation.y + Math.PI / 2];
  const radius = (item, ax, az) => {
    const c = Math.cos(item.rotation.y);
    const s = Math.sin(item.rotation.y);
    return item.userData.halfX * Math.abs(c * ax + s * az) + item.userData.halfZ * Math.abs(-s * ax + c * az);
  };
  for (const angle of axes) {
    const ax = Math.cos(angle);
    const az = Math.sin(angle);
    const dist = Math.abs((b.position.x - a.position.x) * ax + (b.position.z - a.position.z) * az);
    if (dist > radius(a, ax, az) + radius(b, ax, az) - 0.02) return false;
  }
  return true;
}

function refreshWarnings() {
  if (!plan) return;
  const messages = [];
  for (const item of furnitureGroup.children) {
    const c = Math.abs(Math.cos(item.rotation.y));
    const s = Math.abs(Math.sin(item.rotation.y));
    const ex = item.userData.halfX * c + item.userData.halfZ * s;
    const ez = item.userData.halfX * s + item.userData.halfZ * c;
    if (Math.abs(item.position.x) + ex > plan.widthM / 2 + 0.02 || Math.abs(item.position.z) + ez > plan.depthM / 2 + 0.02) {
      messages.push(`${item.userData.label} 超出房间外框`);
    }
    if (plan.wallSegments.some((wall) => segmentHitsOBB(item, wall))) {
      messages.push(`${item.userData.label} 与墙重叠`);
    }
    for (const other of furnitureGroup.children) {
      if (other === item) continue;
      if (item.name > other.name) continue;
      if (obbOverlap(item, other)) messages.push(`${item.userData.label} 与 ${other.userData.label} 叠放`);
    }
  }
  warn.hidden = messages.length === 0;
  warn.textContent = messages.join(" · ");
}

function meshesOf(root) {
  const list = [];
  root.traverse((obj) => {
    if (obj.isMesh) list.push(obj);
  });
  return list;
}

function refreshManifest() {
  const meshes = [...meshesOf(roomGroup), ...meshesOf(furnitureGroup)];
  manifest.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `将导出 ${meshes.length} 个物体`;
  manifest.appendChild(title);
  for (const mesh of meshes) {
    const row = document.createElement("div");
    row.textContent = mesh.name;
    manifest.appendChild(row);
  }
}

function bakeMesh(obj) {
  const geometry = obj.geometry;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  const positions = new Float32Array(position.count * 3);
  const normals = new Float32Array(position.count * 3);
  const vertex = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld);
    positions[i * 3] = vertex.x;
    positions[i * 3 + 1] = vertex.y;
    positions[i * 3 + 2] = vertex.z;
    nrm.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
    normals[i * 3] = nrm.x;
    normals[i * 3 + 1] = nrm.y;
    normals[i * 3 + 2] = nrm.z;
  }
  const indices = index ? Array.from(index.array) : [...Array(position.count).keys()];
  return { name: obj.name || "mesh", material: obj.material.name || "wall", positions, normals, indices };
}

function exportParts() {
  scene.updateMatrixWorld(true);
  return [...meshesOf(roomGroup), ...meshesOf(furnitureGroup)].map(bakeMesh);
}

function saveBlob(filename, blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

document.getElementById("export-glb").addEventListener("click", () => {
  const parts = exportParts();
  const glb = encodeGLB(parts);
  saveBlob("out.glb", new Blob([glb], { type: "model/gltf-binary" }));
});

document.getElementById("export-obj").addEventListener("click", () => {
  const parts = exportParts();
  const { obj, mtl } = encodeOBJ(parts);
  saveBlob("out.obj", new Blob([obj], { type: "text/plain" }));
  setTimeout(() => saveBlob("out.mtl", new Blob([mtl], { type: "text/plain" })), 250);
});

document.getElementById("reset").addEventListener("click", () => {
  disposeTree(furnitureGroup);
  selected = null;
  dragging = null;
  counts.table = 0;
  counts.chair = 0;
  counts.cabinet = 0;
  refreshSelection();
  refreshWarnings();
  refreshManifest();
});

for (const button of document.querySelectorAll("[data-kind]")) {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    catalogDrag = { kind: button.dataset.kind, x: event.clientX, y: event.clientY, moved: false };
  });
}

window.addEventListener("pointermove", (event) => {
  if (catalogDrag && Math.hypot(event.clientX - catalogDrag.x, event.clientY - catalogDrag.y) > 5) {
    catalogDrag.moved = true;
  }
  if (!dragging) return;
  const point = groundPoint(event);
  if (!point) return;
  dragging.position.x = snap(point.x + dragging.userData.dragX);
  dragging.position.z = snap(point.z + dragging.userData.dragZ);
  refreshWarnings();
  refreshSelection();
});

window.addEventListener("pointerup", (event) => {
  if (catalogDrag) {
    const pending = catalogDrag;
    catalogDrag = null;
    if (!pending.moved) {
      spawn(pending.kind, plan ? plan.widthM * 0.18 : 0, plan ? plan.depthM * 0.28 : 0);
    } else if (renderer.domElement.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      const point = groundPoint(event);
      if (point) spawn(pending.kind, point.x, point.z);
    }
  }
  if (dragging) dragging = null;
});

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || catalogDrag) return;
  const hit = pickFurniture(event);
  press = { x: event.clientX, y: event.clientY, hit: !!hit };
  if (!hit) return;
  event.stopPropagation();
  event.preventDefault();
  const point = groundPoint(event);
  if (!point) return;
  hit.userData.dragX = hit.position.x - point.x;
  hit.userData.dragZ = hit.position.z - point.z;
  dragging = hit;
  select(hit);
}, true);

renderer.domElement.addEventListener("pointerup", (event) => {
  if (event.button !== 0) return;
  const started = press;
  press = null;
  if (dragging) return;
  if (!started || started.hit) return;
  if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > 4) return;
  if (!pickFurniture(event)) select(null);
});

window.addEventListener("keydown", (event) => {
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (!selected) return;
  let used = true;
  if (event.key === "ArrowLeft") selected.position.x = snap(selected.position.x - 0.1);
  else if (event.key === "ArrowRight") selected.position.x = snap(selected.position.x + 0.1);
  else if (event.key === "ArrowUp") selected.position.z = snap(selected.position.z - 0.1);
  else if (event.key === "ArrowDown") selected.position.z = snap(selected.position.z + 0.1);
  else if (event.key === "r" || event.key === "R") selected.rotation.y += Math.PI / 12;
  else if (event.key === "Delete" || event.key === "Backspace") {
    furnitureGroup.remove(selected);
    disposeTree(selected);
    selected = null;
  } else used = false;
  if (!used) return;
  event.preventDefault();
  refreshSelection();
  refreshWarnings();
  refreshManifest();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    applySvg(await file.text());
    sourceNote.textContent = file.name;
  } catch (error) {
    warn.hidden = false;
    warn.textContent = error.message;
  }
});

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  projectLabels();
  renderer.render(scene, camera);
}

async function boot() {
  const sources = ["../../../_shared/assets/floorplan.svg", "./floorplan.svg"];
  for (const url of sources) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      const text = await response.text();
      if (!text.includes("<svg")) throw new Error("不是 SVG");
      applySvg(text);
      sourceNote.textContent = url;
      return;
    } catch (error) {
      sourceNote.textContent = url + " 失败";
    }
  }
  for (const node of sizeNodes) node.textContent = "图纸未载入";
  warn.hidden = false;
  warn.textContent = "没有读到 SVG。用左侧「载入新图纸」，或通过静态服务器打开本目录。";
}

window.addEventListener("resize", resize);
resize();
animate();
boot();
