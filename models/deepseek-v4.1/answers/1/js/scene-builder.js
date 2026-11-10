/**
 * scene-builder.js — 由平面图数据构建三维房间 + 程序化家具
 * 浏览器与 node 共用（node 侧用于生成 answers/1/out.obj|out.mtl|out.glb）
 */
(function (global) {
  'use strict';

  var WALL_HEIGHT = 2.8;
  var WALL_THICK = 0.1;

  /* 把若干个 BoxGeometry 并成一个几何体，保证一件家具 = 一个 mesh（导出节点数干净） */
  function mergeGeoms(THREE, geoms) {
    var list = geoms.map(function (g) { return g.index ? g.toNonIndexed() : g; });
    var total = 0;
    list.forEach(function (g) { total += g.attributes.position.count; });
    var pos = new Float32Array(total * 3);
    var nor = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2);
    var o = 0;
    list.forEach(function (g) {
      var p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array;
      pos.set(p, o * 3); nor.set(n, o * 3); uv.set(u, o * 2);
      o += g.attributes.position.count;
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }

  function box(THREE, w, h, d, x, y, z) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  }

  var CATALOG = [
    { id: 'desk', name: '办公桌', group: '桌子', w: 1.4, d: 0.7, h: 0.75, color: 0xb58150 },
    { id: 'table_m', name: '会议桌 1.2m', group: '桌子', w: 1.2, d: 0.8, h: 0.75, color: 0xa9713f },
    { id: 'table_l', name: '会议桌 1.8m', group: '桌子', w: 1.8, d: 0.9, h: 0.75, color: 0xa9713f },
    { id: 'chair', name: '椅子', group: '椅子', w: 0.5, d: 0.5, h: 0.9, color: 0x6f7681 },
    { id: 'stool', name: '圆凳', group: '椅子', w: 0.42, d: 0.42, h: 0.45, color: 0x818a96 },
    { id: 'cabinet', name: '文件柜', group: '柜子', w: 1.0, d: 0.45, h: 1.8, color: 0x7c8794 },
    { id: 'sideboard', name: '矮柜', group: '柜子', w: 1.2, d: 0.4, h: 0.8, color: 0x8d6f57 }
  ];

  function catalogById(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  /* 程序化生成家具几何：全部由 Box 拼成，无外部模型 */
  function furnitureGeometry(THREE, spec) {
    var w = spec.w, d = spec.d, h = spec.h, t = 0.04;
    var parts = [];
    if (spec.id === 'desk' || spec.id === 'table_m' || spec.id === 'table_l') {
      parts.push(box(THREE, w, t, d, 0, h - t / 2, 0));
      var legInset = 0.07;
      [[-w / 2 + legInset, -d / 2 + legInset], [w / 2 - legInset, -d / 2 + legInset],
       [-w / 2 + legInset, d / 2 - legInset], [w / 2 - legInset, d / 2 - legInset]]
        .forEach(function (p) { parts.push(box(THREE, 0.05, h - t, 0.05, p[0], (h - t) / 2, p[1])); });
    } else if (spec.id === 'chair' || spec.id === 'stool') {
      var sh = spec.id === 'stool' ? 0.45 : 0.45;
      parts.push(box(THREE, w, 0.05, d, 0, sh, 0));
      [[-w / 2 + 0.04, -d / 2 + 0.04], [w / 2 - 0.04, -d / 2 + 0.04],
       [-w / 2 + 0.04, d / 2 - 0.04], [w / 2 - 0.04, d / 2 - 0.04]]
        .forEach(function (p) { parts.push(box(THREE, 0.04, sh, 0.04, p[0], sh / 2, p[1])); });
      if (spec.id === 'chair') parts.push(box(THREE, w, h - sh, 0.05, 0, (h + sh) / 2, -d / 2 + 0.03));
    } else if (spec.id === 'cabinet' || spec.id === 'sideboard') {
      parts.push(box(THREE, w, h, d, 0, h / 2, 0));
      parts.push(box(THREE, w - 0.06, 0.02, 0.02, 0, h * 0.6, d / 2 + 0.005));
    }
    return mergeGeoms(THREE, parts);
  }

  var materialCache = {};

  function material(THREE, color, name, opts) {
    var key = name;
    if (!materialCache[key]) {
      var m = new THREE.MeshStandardMaterial(Object.assign({
        color: color, roughness: 0.75, metalness: 0.05
      }, opts || {}));
      m.name = name;
      materialCache[key] = m;
    }
    return materialCache[key];
  }

  function makeFurniture(THREE, id) {
    var spec = catalogById(id);
    if (!spec) throw new Error('unknown furniture: ' + id);
    var geo = furnitureGeometry(THREE, spec);
    var mat = material(THREE, spec.color, 'mat_' + spec.id);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'furniture_' + spec.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      kind: 'furniture',
      specId: spec.id,
      spec: spec,
      baseY: 0
    };
    // 记录本地包围盒（未旋转，用于碰撞）
    mesh.userData.footprint = { w: spec.w, d: spec.d };
    return mesh;
  }

  /** 构建房间：地面 + 墙（门洞处已断开）+ 窗面片 */
  function buildRoom(THREE, plan) {
    var room = new THREE.Group();
    room.name = 'Room';

    // 地面
    var floorGeo = new THREE.PlaneGeometry(plan.width, plan.depth);
    floorGeo.rotateX(-Math.PI / 2);
    var floor = new THREE.Mesh(floorGeo, material(THREE, 0xd9d2c7, 'mat_floor', { roughness: 0.95 }));
    floor.name = 'floor';
    floor.receiveShadow = true;
    floor.userData = { kind: 'floor' };
    room.add(floor);

    // 墙
    var wallMat = material(THREE, 0xe8e4dc, 'mat_wall', { roughness: 0.9 });
    var walls = new THREE.Group();
    walls.name = 'Walls';
    plan.walls.forEach(function (w, i) {
      if (w.length < 0.01) return;
      var g = new THREE.BoxGeometry(w.length, WALL_HEIGHT, WALL_THICK);
      var m = new THREE.Mesh(g, wallMat);
      m.position.set((w.x1 + w.x2) / 2, WALL_HEIGHT / 2, (w.z1 + w.z2) / 2);
      m.rotation.y = -w.angle;
      m.name = 'wall_' + i;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData = { kind: 'wall', seg: w };
      walls.add(m);
    });
    room.add(walls);

    // 窗（半透明蓝面片贴在墙上，不要求开洞）
    var winMat = material(THREE, 0x4aa3df, 'mat_glass', {
      transparent: true, opacity: 0.38, roughness: 0.1, metalness: 0.2, side: THREE.DoubleSide
    });
    var windows = new THREE.Group();
    windows.name = 'Windows';
    plan.windows.forEach(function (w, i) {
      var g = new THREE.PlaneGeometry(w.length, 1.2);
      var m = new THREE.Mesh(g, winMat);
      m.position.set(w.cx, 1.5, w.cz);
      m.rotation.y = -w.angle;
      m.name = 'window_' + i;
      m.userData = { kind: 'window' };
      windows.add(m);
    });
    room.add(windows);

    room.userData = { plan: plan };
    return room;
  }

  /* 示例布局：一组能直接看出「能摆家具」的默认摆放 */
  function demoLayout() {
    return [
      { id: 'desk', x: -2.0, z: -0.9, rot: 0 },
      { id: 'chair', x: -2.0, z: -0.3, rot: Math.PI },
      { id: 'desk', x: -1.6, z: 0.9, rot: Math.PI },
      { id: 'chair', x: -1.6, z: 1.5, rot: 0 },
      { id: 'table_l', x: 1.6, z: -0.9, rot: 0 },
      { id: 'chair', x: 1.1, z: -0.15, rot: Math.PI },
      { id: 'chair', x: 2.1, z: -0.15, rot: Math.PI },
      { id: 'cabinet', x: 2.45, z: 1.3, rot: -Math.PI / 2 },
      { id: 'sideboard', x: 0.7, z: 1.6, rot: 0 }
    ];
  }

  var API = {
    WALL_HEIGHT: WALL_HEIGHT,
    WALL_THICK: WALL_THICK,
    CATALOG: CATALOG,
    catalogById: catalogById,
    makeFurniture: makeFurniture,
    buildRoom: buildRoom,
    demoLayout: demoLayout,
    mergeGeoms: mergeGeoms
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  else global.SceneBuilder = API;
})(typeof self !== 'undefined' ? self : this);
