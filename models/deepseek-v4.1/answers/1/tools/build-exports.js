/**
 * tools/build-exports.js — 在 node 里跑同一套 scene-builder，生成 out.obj / out.mtl / out.glb
 *
 * 为什么需要它：浏览器端按钮导出的是同一种几何（同一份 js/scene-builder.js），
 * 这里只是把那份结果预先落盘，保证 answers/1/ 里始终有可以直接给 Unity/UE5 的文件。
 *
 * 用法：node tools/build-exports.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---- 在 node 里加载 three r128（UMD）---- */
function loadThree() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor', 'three.min.js'), 'utf8');
  const sandbox = { self: {}, window: {}, console, Math, Date, Float32Array, Uint16Array, Uint32Array, Array, Object, JSON, Number, String, isNaN, isFinite, parseFloat, parseInt };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'three.min.js' });
  if (!sandbox.THREE) throw new Error('THREE 未加载');
  return sandbox.THREE;
}

const THREE = loadThree();

/* ---- 加载项目里的两个浏览器模块（IIFE 挂到 global）---- */
function loadModule(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const g = {};
  const fn = new Function('self', 'module', src);
  fn(g, undefined);
  return g;
}

const FP = loadModule('js/floorplan.js').FloorPlan;
const SB = loadModule('js/scene-builder.js').SceneBuilder;

/* ---- 解析图纸 → 建房间 → 摆示例家具 ---- */
const plan = FP.parse(fs.readFileSync(path.join(ROOT, 'floorplan.svg'), 'utf8'));
console.log(`plan: ${plan.width.toFixed(2)} m x ${plan.depth.toFixed(2)} m, walls=${plan.walls.length}, windows=${plan.windows.length}, doors=${plan.doors.length}`);

const room = SB.buildRoom(THREE, plan);
const furniture = new THREE.Group();
furniture.name = 'Furniture';
SB.demoLayout().forEach((d) => {
  const m = SB.makeFurniture(THREE, d.id);
  m.position.set(d.x, 0, d.z);
  m.rotation.y = d.rot || 0;
  furniture.add(m);
});

const root = new THREE.Group();
root.name = 'RoomModel';
root.add(room);
root.add(furniture);
root.updateMatrixWorld(true);

let meshCount = 0, triCount = 0;
root.traverse((o) => {
  if (o.isMesh) {
    meshCount++;
    const g = o.geometry;
    triCount += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
});
console.log(`meshes=${meshCount} triangles=${triCount}`);

/* ---- OBJ + MTL ---- */
// 从 three 源码里取 OBJExporter（examples/js 版是 IIFE，挂 THREE.OBJExporter）
(function attachObjExporter() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor', 'OBJExporter.js'), 'utf8');
  const fn = new Function('THREE', 'self', src + '\n;if (typeof OBJExporter !== "undefined") THREE.OBJExporter = OBJExporter;');
  fn(THREE, { THREE });
  if (!THREE.OBJExporter) throw new Error('OBJExporter 未挂载');
})();

let obj = new THREE.OBJExporter().parse(root);

// 生成 MTL，材质名与 OBJ 中的 usemtl 一致
const mats = new Map();
root.traverse((o) => {
  if (!o.isMesh || !o.material) return;
  const list = Array.isArray(o.material) ? o.material : [o.material];
  list.forEach((m) => {
    if (!m.name) m.name = 'mat_' + (o.name || 'default');
    if (!mats.has(m.name)) mats.set(m.name, m);
  });
});

const mtlLines = ['# out.mtl — generated from scene materials'];
const safeName = (m, i) => {
  const c = m.color || { r: 1, g: 1, b: 1 };
  mtlLines.push(`newmtl ${m.name}`);
  mtlLines.push('Ka 0.200 0.200 0.200');
  mtlLines.push(`Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`);
  mtlLines.push('Ks 0.100 0.100 0.100');
  mtlLines.push('Ns 32.0');
  mtlLines.push('illum 2');
  const alpha = m.transparent ? (m.opacity !== undefined ? m.opacity : 1) : 1;
  mtlLines.push(`d ${alpha.toFixed(3)}`);
  mtlLines.push('');
};
[...mats.values()].forEach(safeName);

// 清洗 OBJ：去掉绝对路径痕迹、确保首行 mtllib 用相对文件名
obj = obj.replace(/\r\n/g, '\n');
if (!/^mtllib/m.test(obj)) obj = 'mtllib out.mtl\n' + obj;
fs.writeFileSync(path.join(ROOT, 'out.obj'), obj, 'utf8');
fs.writeFileSync(path.join(ROOT, 'out.mtl'), mtlLines.join('\n'), 'utf8');

/* ---- GLB ---- */
// GLTFExporter 依赖 Blob / FileReader / TextEncoder，这里给最小 polyfill
global.window = global;
global.self = global;
if (typeof global.FileReader === 'undefined') {
  global.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (this.onloadend) this.onloadend();
        if (this.onload) this.onload();
      });
    }
    readAsDataURL(blob) { throw new Error('readAsDataURL not supported'); }
  };
}

(function attachGltfExporter() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor', 'GLTFExporter.js'), 'utf8');
  const fn = new Function('THREE', 'self', 'window', src + '\n;if (typeof GLTFExporter !== "undefined") THREE.GLTFExporter = GLTFExporter;');
  fn(THREE, global, global);
  if (!THREE.GLTFExporter) throw new Error('GLTFExporter 未挂载');
})();

const exporter = new THREE.GLTFExporter();
try {
  exporter.parse(
    root,
    (result) => {
      const buf = Buffer.from(result);
      fs.writeFileSync(path.join(ROOT, 'out.glb'), buf);
      console.log(`out.glb ${(buf.length / 1024).toFixed(1)} KB`);
      console.log('out.obj / out.mtl / out.glb written');
    },
    { binary: true, onlyVisible: true }
  );
} catch (e) {
  console.error('GLTF export failed:', e);
  process.exit(1);
}
