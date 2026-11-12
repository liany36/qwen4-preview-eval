/* 图纸 → 3D 房间：解析 SVG、生成墙体/窗、摆放家具、导出 glb/obj。
 * 所有尺寸都从 SVG 解析计算，不写死。单位：100 SVG 单位 = 1 m。
 * 依赖全局 THREE（vendor/three.min.js r160 UMD）及同目录导出器脚本。
 */
(function () {
  'use strict';

  var UNIT = 0.01;          // 1 SVG unit = 1 cm
  var WALL_H = 2.8;         // 墙高 m
  var WALL_T = 0.06;        // 视觉墙厚（按中心线定位）
  var SNAP = 0.1;           // 吸附网格 m
  var COL_EPS = 2.0;        // 共线判定容差（SVG 单位）

  // ---------- DOM ----------
  var viewport = document.getElementById('viewport');
  var dimsEl = document.getElementById('dims');
  var statusEl = document.getElementById('status');
  var listEl = document.getElementById('export-list');
  var hudEl = document.getElementById('hud');
  var snapEl = document.getElementById('snap');

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || '';
    statusEl.style.color = isErr ? '#ff8080' : '#ffd479';
  }

  // ---------- SVG 解析 ----------
  function parseTransform(str) {
    // 返回 2D 仿射矩阵 [a,b,c,d,e,f]（x' = a x + c y + e, y' = b x + d y + f）
    var m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, t;
    function mul(A, B) {
      return [
        A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
        A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
        A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]
      ];
    }
    while ((t = re.exec(str)) !== null) {
      var v = t[2].trim().split(/[\s,]+/).map(Number), k = [1, 0, 0, 1, 0, 0];
      if (t[1] === 'matrix' && v.length === 6) k = v;
      else if (t[1] === 'translate') k = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      else if (t[1] === 'scale') k = [v[0] != null ? v[0] : 1, 0, 0, v[1] != null ? v[1] : (v[0] != null ? v[0] : 1), 0, 0];
      else if (t[1] === 'rotate') {
        var a = (v[0] || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        k = [c, s, -s, c, 0, 0];
        if (v.length === 3) {
          var cx = v[1], cy = v[2];
          k = mul([1, 0, 0, 1, cx, cy], mul(k, [1, 0, 0, 1, -cx, -cy]));
        }
      } else if (t[1] === 'skewX') { var tx = Math.tan((v[0] || 0) * Math.PI / 180); k = [1, 0, tx, 1, 0, 0]; }
      else if (t[1] === 'skewY') { var ty = Math.tan((v[0] || 0) * Math.PI / 180); k = [1, ty, 0, 1, 0, 0]; }
      m = mul(m, k);
    }
    return m;
  }
  function applyM(m, p) { return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }; }
  function mulM(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]
    ];
  }
  function worldMatrixOf(el) {
    var chain = [], n = el;
    while (n && n.nodeType === 1 && n.tagName.toLowerCase() !== 'svg') {
      chain.unshift(n.getAttribute('transform'));
      n = n.parentElement;
    }
    var m = [1, 0, 0, 1, 0, 0];
    for (var i = 0; i < chain.length; i++) m = mulM(m, parseTransform(chain[i]));
    return m;
  }
  function num(el, name, dflt) {
    var v = parseFloat(el.getAttribute(name));
    return isNaN(v) ? dflt : v;
  }
  function pathToPolylines(d) {
    // 支持 M/L/H/V/Z（含相对）。曲线命令取端点近似（本图纸只有直线段）。
    var toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    var lines = [], cur = null, start = null, x = 0, y = 0, i = 0, cmd = null;
    function take() { return parseFloat(toks[i++]); }
    function push(nx, ny) {
      if (!cur) { cur = [{ x: x, y: y }]; }
      cur.push({ x: nx, y: ny }); x = nx; y = ny;
    }
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) { cmd = toks[i++]; }
      if (cmd == null) break;
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'M') {
        var mx = take(), my = take();
        x = rel ? x + mx : mx; y = rel ? y + my : my;
        if (cur && cur.length > 1) lines.push(cur);
        cur = [{ x: x, y: y }]; start = { x: x, y: y };
        cmd = rel ? 'l' : 'L';
      } else if (C === 'L') { var lx = take(), ly = take(); push(rel ? x + lx : lx, rel ? y + ly : ly); }
      else if (C === 'H') { var hx = take(); push(rel ? x + hx : hx, y); }
      else if (C === 'V') { var vy = take(); push(x, rel ? y + vy : vy); }
      else if (C === 'Z') {
        if (start) { push(start.x, start.y); }
        if (cur && cur.length > 1) lines.push(cur);
        cur = null; cmd = null;
      } else if (C === 'C') { take(); take(); take(); take(); var cx = take(), cy = take(); push(rel ? x + cx : cx, rel ? y + cy : cy); }
      else if (C === 'S' || C === 'Q') { take(); take(); var qx = take(), qy = take(); push(rel ? x + qx : qx, rel ? y + qy : qy); }
      else if (C === 'T') { var tx2 = take(), ty2 = take(); push(rel ? x + tx2 : tx2, rel ? y + ty2 : ty2); }
      else if (C === 'A') { take(); take(); take(); take(); take(); var ax = take(), ay = take(); push(rel ? x + ax : ax, rel ? y + ay : ay); }
      else { break; }
    }
    if (cur && cur.length > 1) lines.push(cur);
    return lines;
  }
  function elementSegments(el) {
    // 返回 SVG 坐标下的线段数组（未变换）
    var tag = el.tagName.toLowerCase(), segs = [];
    if (tag === 'line') {
      segs.push([{ x: num(el, 'x1', 0), y: num(el, 'y1', 0) }, { x: num(el, 'x2', 0), y: num(el, 'y2', 0) }]);
    } else if (tag === 'rect') {
      var rx = num(el, 'x', 0), ry = num(el, 'y', 0), rw = num(el, 'width', 0), rh = num(el, 'height', 0);
      var p = [{ x: rx, y: ry }, { x: rx + rw, y: ry }, { x: rx + rw, y: ry + rh }, { x: rx, y: ry + rh }];
      for (var i = 0; i < 4; i++) segs.push([p[i], p[(i + 1) % 4]]);
    } else if (tag === 'polyline' || tag === 'polygon') {
      var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      var pp = [];
      for (var j = 0; j + 1 < pts.length; j += 2) pp.push({ x: pts[j], y: pts[j + 1] });
      for (var k = 0; k + 1 < pp.length; k++) segs.push([pp[k], pp[k + 1]]);
      if (tag === 'polygon' && pp.length > 2) segs.push([pp[pp.length - 1], pp[0]]);
    } else if (tag === 'path') {
      var pls = pathToPolylines(el.getAttribute('d') || '');
      pls.forEach(function (pl) {
        for (var q = 0; q + 1 < pl.length; q++) segs.push([pl[q], pl[q + 1]]);
      });
    }
    return segs;
  }
  function parseSVG(text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('SVG 解析失败');
    var walls = [], doors = [], windows = [], labels = [];
    var all = doc.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cls = el.getAttribute('class') || '';
      var kinds = cls.split(/\s+/);
      var isWall = kinds.indexOf('wall') >= 0, isDoor = kinds.indexOf('door') >= 0, isWin = kinds.indexOf('window') >= 0;
      if (isWall || isDoor || isWin) {
        var m = worldMatrixOf(el);
        elementSegments(el).forEach(function (s) {
          var a = applyM(m, s[0]), b = applyM(m, s[1]);
          if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) return;
          (isWall ? walls : isDoor ? doors : windows).push([a, b]);
        });
      } else if (el.tagName.toLowerCase() === 'text' && el.textContent.trim()) {
        var lm = worldMatrixOf(el);
        var lp = applyM(lm, { x: num(el, 'x', 0), y: num(el, 'y', 0) });
        labels.push({ x: lp.x, y: lp.y, text: el.textContent.trim() });
      }
    }
    if (!walls.length) throw new Error('图纸里没有找到 class="wall" 的墙');
    // 门洞处必须没有墙：把与墙共线的 door 区间从墙上减掉
    var cut = [];
    walls.forEach(function (w) {
      var a = w[0], b = w[1];
      var L = Math.hypot(b.x - a.x, b.y - a.y);
      var dx = (b.x - a.x) / L, dy = (b.y - a.y) / L;
      var intervals = [];
      doors.forEach(function (d) {
        var c = d[0], e = d[1];
        var dLen = Math.hypot(e.x - c.x, e.y - c.y);
        if (dLen < 0.5) return;
        var ux = (e.x - c.x) / dLen, uy = (e.y - c.y) / dLen;
        if (Math.abs(dx * uy - dy * ux) > 0.02) return; // 不平行
        function distToLine(p) { return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx); }
        if (distToLine(c) > COL_EPS || distToLine(e) > COL_EPS) return; // 不共线
        var t1 = (c.x - a.x) * dx + (c.y - a.y) * dy;
        var t2 = (e.x - a.x) * dx + (e.y - a.y) * dy;
        var lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
        if (hi - lo > 0.5) intervals.push([lo, hi]);
      });
      intervals.sort(function (p, q) { return p[0] - q[0]; });
      var pos = 0;
      intervals.forEach(function (iv) {
        if (iv[0] - pos > 0.5) cut.push([{ x: a.x + dx * pos, y: a.y + dy * pos }, { x: a.x + dx * iv[0], y: a.y + dy * iv[0] }]);
        pos = Math.max(pos, iv[1]);
      });
      if (L - pos > 0.5) cut.push([{ x: a.x + dx * pos, y: a.y + dy * pos }, { x: b.x, y: b.y }]);
    });
    // 包围盒（墙 + 门洞 + 窗，门洞补全外墙轮廓）
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cut.concat(doors, windows).forEach(function (s) {
      s.forEach(function (p) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      });
    });
    return {
      walls: cut, doors: doors, windows: windows, labels: labels,
      minX: minX, minY: minY,
      widthM: (maxX - minX) * UNIT, depthM: (maxY - minY) * UNIT
    };
  }

  // ---------- 场景 ----------
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8ecf2);
  var camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  scene.add(sun);

  var exportRoot = new THREE.Group(); exportRoot.name = 'Room';
  var wallsGroup = new THREE.Group(); wallsGroup.name = 'Walls';
  var doorsGroup = new THREE.Group(); doorsGroup.name = 'Doors';
  var windowsGroup = new THREE.Group(); windowsGroup.name = 'Windows';
  var furnitureGroup = new THREE.Group(); furnitureGroup.name = 'Furniture';
  var labelsGroup = new THREE.Group(); labelsGroup.name = 'Labels'; // 不导出
  exportRoot.add(wallsGroup); exportRoot.add(doorsGroup); exportRoot.add(windowsGroup); exportRoot.add(furnitureGroup);
  scene.add(exportRoot); scene.add(labelsGroup);

  var floorMesh = null, gridHelper = null;
  var plan = null;                 // 当前解析结果
  var wallSegs2D = [];             // 碰撞用世界坐标墙线段
  var selected = null, boxHelper = null;
  var furnCounter = { desk: 0, chair: 0, cabinet: 0 };

  var MAT = {
    wall: new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.95, name: 'wall_paint' }),
    floor: new THREE.MeshStandardMaterial({ color: 0xd9cfc0, roughness: 0.9, name: 'floor_wood' }),
    glass: new THREE.MeshStandardMaterial({ color: 0x3d8ec9, roughness: 0.2, transparent: true, opacity: 0.45, name: 'window_glass', side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.7, name: 'wood' }),
    woodDark: new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.7, name: 'wood_dark' }),
    fabric: new THREE.MeshStandardMaterial({ color: 0x3f5f8a, roughness: 0.9, name: 'fabric' }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.4, metalness: 0.6, name: 'metal' })
  };

  function toWorld(p) { return { x: (p.x - plan.minX) * UNIT, z: (p.y - plan.minY) * UNIT }; }

  function disposeGroup(g) {
    while (g.children.length) {
      var c = g.children[0];
      g.remove(c);
      c.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    }
  }

  function makeLabel(text, x, z) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 80;
    var ctx = cv.getContext('2d');
    ctx.font = 'bold 40px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(90,100,115,0.95)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 40);
    var tex = new THREE.CanvasTexture(cv);
    // 平铺在地面上方，俯视像图纸标注（不导出）
    var plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.34),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x, 0.015, z);
    labelsGroup.add(plane);
  }

  function buildRoom(p) {
    plan = p;
    disposeGroup(wallsGroup); disposeGroup(doorsGroup); disposeGroup(windowsGroup); disposeGroup(labelsGroup);
    clearFurniture(true);
    if (floorMesh) { exportRoot.remove(floorMesh); floorMesh.geometry.dispose(); floorMesh = null; }
    if (gridHelper) { scene.remove(gridHelper); gridHelper = null; }
    wallSegs2D = [];
    furnCounter = { desk: 0, chair: 0, cabinet: 0 };

    var W = p.widthM, D = p.depthM;
    // 地面
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), MAT.floor);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(W / 2, 0, D / 2);
    floorMesh.receiveShadow = true;
    floorMesh.name = 'Floor';
    exportRoot.add(floorMesh);
    // 网格（0.5 m）
    var gsize = Math.max(W, D);
    gridHelper = new THREE.GridHelper(gsize, Math.round(gsize / 0.5), 0xbbbbbb, 0xd5d5d5);
    gridHelper.position.set(W / 2, 0.002, D / 2);
    gridHelper.material.transparent = true; gridHelper.material.opacity = 0.35;
    scene.add(gridHelper);

    // 墙
    p.walls.forEach(function (s, i) {
      var a = toWorld(s[0]), b = toWorld(s[1]);
      var L = Math.hypot(b.x - a.x, b.z - a.z);
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(L, WALL_H, WALL_T), MAT.wall);
      mesh.position.set((a.x + b.x) / 2, WALL_H / 2, (a.z + b.z) / 2);
      mesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'wall_' + String(i + 1).padStart(2, '0');
      wallsGroup.add(mesh);
      wallSegs2D.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    });
    // 窗：半透明蓝色面片贴墙
    p.windows.forEach(function (s, i) {
      var a = toWorld(s[0]), b = toWorld(s[1]);
      var L = Math.hypot(b.x - a.x, b.z - a.z);
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(L, 1.2, 0.02), MAT.glass);
      mesh.position.set((a.x + b.x) / 2, 1.5, (a.z + b.z) / 2);
      mesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
      mesh.name = 'window_' + String(i + 1).padStart(2, '0');
      windowsGroup.add(mesh);
    });
    // 门洞门槛标记（红色细条，提示这里没有墙）
    p.doors.forEach(function (s, i) {
      var a = toWorld(s[0]), b = toWorld(s[1]);
      var L = Math.hypot(b.x - a.x, b.z - a.z);
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(L, 0.012, 0.1),
        new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9, name: 'door_threshold_' + (i + 1) }));
      mesh.position.set((a.x + b.x) / 2, 0.006, (a.z + b.z) / 2);
      mesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
      mesh.name = 'door_' + String(i + 1).padStart(2, '0');
      doorsGroup.add(mesh);
    });
    // 房间名
    p.labels.forEach(function (lb) {
      var w = toWorld(lb);
      makeLabel(lb.text, w.x, w.z);
    });

    dimsEl.textContent = '总宽 ' + W.toFixed(2) + ' m × 总深 ' + D.toFixed(2) + ' m';
    hudEl.textContent = '墙段 ' + p.walls.length + ' · 门洞 ' + p.doors.length + ' · 窗 ' + p.windows.length +
      ' · 墙高 ' + WALL_H.toFixed(1) + ' m';
    camera.position.set(W / 2 + W * 0.55, Math.max(W, D) * 1.05, D / 2 + D * 1.35);
    controls.target.set(W / 2, 0.6, D / 2);
    controls.update();
    updateExportList();
  }

  // ---------- 家具（全部程序化几何） ----------
  var FURN_DEF = {
    desk: { label: '桌子', w: 1.2, d: 0.6, h: 0.75 },
    chair: { label: '椅子', w: 0.45, d: 0.45, h: 0.9 },
    cabinet: { label: '柜子', w: 0.9, d: 0.45, h: 1.8 }
  };
  function box(w, h, d, mat, x, y, z, name) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    if (name) m.name = name;
    return m;
  }
  function buildFurniture(type) {
    var g = new THREE.Group();
    var def = FURN_DEF[type];
    if (type === 'desk') {
      g.add(box(1.2, 0.05, 0.6, MAT.wood, 0, 0.725, 0, 'top'));
      [[-0.55, -0.25], [0.55, -0.25], [-0.55, 0.25], [0.55, 0.25]].forEach(function (p, i) {
        g.add(box(0.05, 0.7, 0.05, MAT.woodDark, p[0], 0.35, p[1], 'leg_' + (i + 1)));
      });
    } else if (type === 'chair') {
      g.add(box(0.45, 0.05, 0.45, MAT.fabric, 0, 0.45, 0, 'seat'));
      g.add(box(0.45, 0.45, 0.05, MAT.fabric, 0, 0.7, -0.2, 'back'));
      [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]].forEach(function (p, i) {
        g.add(box(0.04, 0.43, 0.04, MAT.metal, p[0], 0.215, p[1], 'leg_' + (i + 1)));
      });
    } else if (type === 'cabinet') {
      g.add(box(0.9, 1.8, 0.45, MAT.wood, 0, 0.9, 0, 'body'));
      g.add(box(0.42, 1.6, 0.02, MAT.woodDark, -0.22, 0.9, 0.235, 'door_left'));
      g.add(box(0.42, 1.6, 0.02, MAT.woodDark, 0.22, 0.9, 0.235, 'door_right'));
    }
    furnCounter[type]++;
    g.name = type + '_' + furnCounter[type];
    g.userData = { type: type, w: def.w, d: def.d, h: def.h, label: def.label };
    return g;
  }

  // ---------- 碰撞（2D OBB） ----------
  function furnCorners(g) {
    var hw = g.userData.w / 2, hd = g.userData.d / 2;
    var c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y);
    // three 的 rotation.y：本地 +X → (cos, -sin)（世界 x,z）
    var pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    return pts.map(function (p) {
      return { x: g.position.x + p[0] * c + p[1] * s, z: g.position.z - p[0] * s + p[1] * c };
    });
  }
  function segIntersect(p1, p2, p3, p4) {
    function cross(o, a, b) { return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x); }
    var d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return false;
  }
  function pointInPoly(p, poly) {
    var sign = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var cr = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
      if (Math.abs(cr) < 1e-9) continue;
      var s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }
  function polysOverlap(A, B) {
    for (var e = 0; e < 4; e++) {
      for (var f = 0; f < 4; f++) {
        if (segIntersect(A[e], A[(e + 1) % 4], B[f], B[(f + 1) % 4])) return true;
      }
    }
    return pointInPoly(A[0], B) || pointInPoly(B[0], A);
  }
  function collides(g) {
    var poly = furnCorners(g);
    // 与墙
    for (var i = 0; i < wallSegs2D.length; i++) {
      var w = wallSegs2D[i];
      var a = { x: w.ax, z: w.az }, b = { x: w.bx, z: w.bz };
      for (var e = 0; e < 4; e++) {
        if (segIntersect(poly[e], poly[(e + 1) % 4], a, b)) return '穿墙';
      }
      if (pointInPoly(a, poly) || pointInPoly(b, poly)) return '穿墙';
    }
    // 与其他家具
    var kids = furnitureGroup.children;
    for (var k = 0; k < kids.length; k++) {
      if (kids[k] === g) continue;
      if (polysOverlap(poly, furnCorners(kids[k]))) return '与其他家具重叠';
    }
    return null;
  }
  function setInvalidTint(g, bad) {
    g.traverse(function (o) {
      if (o.isMesh) {
        if (bad) {
          if (!o.userData._origMat) o.userData._origMat = o.material;
          o.material = o.userData._origMat.clone();
          o.material.emissive = new THREE.Color(0x881111);
        } else if (o.userData._origMat) {
          o.material.dispose();
          o.material = o.userData._origMat;
          delete o.userData._origMat;
        }
      }
    });
  }

  // ---------- 选中 / 放置 ----------
  function select(g) {
    selected = g;
    if (boxHelper) { scene.remove(boxHelper); boxHelper = null; }
    if (g) {
      boxHelper = new THREE.BoxHelper(g, 0xffb020);
      scene.add(boxHelper);
      setStatus('已选中 ' + g.userData.label + '（' + g.name + '）。方向键 ±10 cm，R 旋转 15°，Delete 删除。');
    }
  }
  function clearFurniture(silent) {
    select(null);
    disposeGroup(furnitureGroup);
    if (!silent) { setStatus('已撤销：回到刚导入图纸的状态（家具已清空）。'); updateExportList(); }
  }
  function placeFurniture(type, x, z) {
    var g = buildFurniture(type);
    g.position.set(x, 0, z);
    furnitureGroup.add(g);
    var why = collides(g);
    if (why) {
      // 就近找一个不碰撞的位置（螺旋搜索）
      var found = false;
      outer:
      for (var r = 0.15; r <= 3.0; r += 0.15) {
        for (var a = 0; a < 360; a += 30) {
          g.position.set(x + r * Math.cos(a * Math.PI / 180), 0, z + r * Math.sin(a * Math.PI / 180));
          if (!collides(g)) { found = true; break outer; }
        }
      }
      if (!found) {
        furnitureGroup.remove(g);
        setStatus('放不下：附近没有不与墙/家具冲突的位置。', true);
        return null;
      }
      setStatus('目标位置' + why + '，已自动挪到附近空位。');
    } else {
      setStatus('已放置 ' + g.userData.label + '。按住可拖动。');
    }
    select(g);
    updateExportList();
    return g;
  }

  // ---------- 导出清单 ----------
  function updateExportList() {
    if (!plan) { listEl.textContent = '—'; return; }
    var n = { desk: 0, chair: 0, cabinet: 0 };
    furnitureGroup.children.forEach(function (g) { n[g.userData.type]++; });
    var furn = furnitureGroup.children.length;
    var total = 1 + plan.walls.length + plan.windows.length + plan.doors.length + furn;
    listEl.innerHTML =
      '将导出 <b>' + total + '</b> 个物体：<br>' +
      '地面 1 · 墙段 ' + plan.walls.length + ' · 窗 ' + plan.windows.length + ' · 门槛 ' + plan.doors.length + '<br>' +
      '家具 ' + furn + '（桌子 ' + n.desk + ' / 椅子 ' + n.chair + ' / 柜子 ' + n.cabinet + '）';
  }

  // ---------- 导出 ----------
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }
  function exportGLB() {
    return new Promise(function (resolve, reject) {
      var exporter = new THREE.GLTFExporter();
      exporter.parse(exportRoot, function (buf) { resolve(buf); },
        function (err) { reject(err); }, { binary: true });
    });
  }
  function buildMTL() {
    var seen = {}, lines = ['# out.mtl — generated from floor plan scene'];
    exportRoot.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.material.name || seen[o.material.name]) return;
      seen[o.material.name] = true;
      var m = o.material, c = m.color || new THREE.Color(0xffffff);
      lines.push('newmtl ' + m.name);
      lines.push('Ka 0.000 0.000 0.000');
      lines.push('Kd ' + c.r.toFixed(3) + ' ' + c.g.toFixed(3) + ' ' + c.b.toFixed(3));
      lines.push('Ks 0.000 0.000 0.000');
      lines.push('d ' + (m.opacity != null ? m.opacity.toFixed(3) : '1.000'));
      lines.push('illum 1');
      lines.push('');
    });
    return lines.join('\n');
  }
  function exportOBJ() {
    exportRoot.updateMatrixWorld(true);
    var obj = new THREE.OBJExporter().parse(exportRoot);
    return { obj: 'mtllib out.mtl\n' + obj, mtl: buildMTL() };
  }

  document.getElementById('btn-glb').addEventListener('click', function () {
    setStatus('正在生成 glb…');
    exportGLB().then(function (buf) {
      download(new Blob([buf], { type: 'model/gltf-binary' }), 'out.glb');
      setStatus('out.glb 已下载（' + (buf.byteLength / 1024).toFixed(1) + ' KB）。');
    }).catch(function (e) { setStatus('glb 导出失败：' + e.message, true); });
  });
  document.getElementById('btn-obj').addEventListener('click', function () {
    try {
      var r = exportOBJ();
      download(new Blob([r.obj], { type: 'text/plain' }), 'out.obj');
      setTimeout(function () { download(new Blob([r.mtl], { type: 'text/plain' }), 'out.mtl'); }, 400);
      setStatus('out.obj + out.mtl 已下载。');
    } catch (e) { setStatus('obj 导出失败：' + e.message, true); }
  });
  document.getElementById('btn-undo').addEventListener('click', function () { clearFurniture(false); });

  // ---------- 载入图纸 ----------
  function loadSVGText(text, sourceName) {
    try {
      var p = parseSVG(text);
      buildRoom(p);
      setStatus('已载入 ' + sourceName + '：墙段 ' + p.walls.length + '，门洞 ' + p.doors.length + '，窗 ' + p.windows.length + '。');
      return true;
    } catch (e) {
      setStatus('载入失败：' + e.message, true);
      return false;
    }
  }
  function fetchOrEmbedded(url, embeddedId, name) {
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      if (t.indexOf('<svg') < 0) throw new Error('不是 SVG');
      loadSVGText(t, name);
    }).catch(function () {
      var emb = document.getElementById(embeddedId);
      if (emb) loadSVGText(emb.textContent, name + '（内嵌兜底副本）');
      else setStatus('无法载入 ' + name, true);
    });
  }
  document.getElementById('btn-load').addEventListener('click', function () {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { loadSVGText(reader.result, f.name); };
    reader.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('btn-v2').addEventListener('click', function () {
    fetchOrEmbedded('floorplan-v2.svg', 'embedded-svg-v2', 'floorplan-v2.svg');
  });

  // ---------- 交互：拖放 / 拖动 / 键盘 ----------
  var raycaster = new THREE.Raycaster();
  var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var ndc = new THREE.Vector2();
  function setNDC(e) {
    var rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }
  function groundPoint(e) {
    setNDC(e);
    raycaster.setFromCamera(ndc, camera);
    var p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(groundPlane, p) ? p : null;
  }
  function pickFurniture(e) {
    setNDC(e);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(furnitureGroup.children, true);
    if (!hits.length) return null;
    var o = hits[0].object;
    while (o && o.parent !== furnitureGroup) o = o.parent;
    return o;
  }
  function snapV(v) { return snapEl.checked ? Math.round(v / SNAP) * SNAP : v; }

  // 面板 → 场景（HTML5 拖放）
  document.querySelectorAll('.furn-card').forEach(function (card) {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', card.getAttribute('data-type'));
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('click', function () {
      if (!plan) return;
      placeFurniture(card.getAttribute('data-type'), plan.widthM / 2, plan.depthM / 2);
    });
  });
  viewport.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  viewport.addEventListener('drop', function (e) {
    e.preventDefault();
    var type = e.dataTransfer.getData('text/plain');
    if (!FURN_DEF[type] || !plan) return;
    var p = groundPoint(e);
    if (p) placeFurniture(type, snapV(p.x), snapV(p.z));
  });

  // 场景内拖动已有家具
  var dragging = null, dragOffset = new THREE.Vector3(), lastValid = new THREE.Vector3(), dragBad = false;
  renderer.domElement.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var g = pickFurniture(e);
    if (!g) { select(null); return; }
    e.stopPropagation();
    select(g);
    var p = groundPoint(e);
    if (!p) return;
    dragging = g;
    dragBad = false;
    dragOffset.set(g.position.x - p.x, 0, g.position.z - p.z);
    lastValid.copy(g.position);
    controls.enabled = false;
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  }, true);
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var p = groundPoint(e);
    if (!p) return;
    var nx = snapV(p.x + dragOffset.x), nz = snapV(p.z + dragOffset.z);
    dragging.position.set(nx, 0, nz);
    var why = collides(dragging);
    if (why) { dragBad = true; setInvalidTint(dragging, true); setStatus('⚠ ' + why + '：松手将回到上一个合法位置。', true); }
    else {
      dragBad = false; setInvalidTint(dragging, false);
      lastValid.set(nx, 0, nz);
      setStatus('拖动中：' + dragging.userData.label + ' → (' + nx.toFixed(2) + ', ' + nz.toFixed(2) + ') m');
    }
    if (boxHelper) boxHelper.update();
  });
  function endDrag(e) {
    if (!dragging) return;
    if (dragBad) {
      dragging.position.copy(lastValid);
      setInvalidTint(dragging, false);
      setStatus('该位置冲突，已回到上一个合法位置。', true);
    } else {
      setStatus('已放置 ' + dragging.userData.label + ' 于 (' + dragging.position.x.toFixed(2) + ', ' + dragging.position.z.toFixed(2) + ') m。');
    }
    if (boxHelper) boxHelper.update();
    dragging = null;
    controls.enabled = true;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    updateExportList();
  }
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointercancel', endDrag);

  // 键盘微调
  window.addEventListener('keydown', function (e) {
    if (!selected) return;
    var step = 0.1, moved = false;
    var nx = selected.position.x, nz = selected.position.z;
    if (e.key === 'ArrowUp') { nz -= step; moved = true; }
    else if (e.key === 'ArrowDown') { nz += step; moved = true; }
    else if (e.key === 'ArrowLeft') { nx -= step; moved = true; }
    else if (e.key === 'ArrowRight') { nx += step; moved = true; }
    else if (e.key === 'r' || e.key === 'R') {
      var oldRot = selected.rotation.y;
      selected.rotation.y += 15 * Math.PI / 180;
      var whyR = collides(selected);
      if (whyR) { selected.rotation.y = oldRot; setStatus('旋转后' + whyR + '，已还原。', true); }
      else setStatus('已旋转 15°。');
      if (boxHelper) boxHelper.update();
      e.preventDefault();
      return;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      var g = selected;
      select(null);
      furnitureGroup.remove(g);
      g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
      setStatus('已删除 ' + g.userData.label + '。');
      updateExportList();
      e.preventDefault();
      return;
    } else if (e.key === 'Escape') { select(null); return; }
    if (!moved) return;
    e.preventDefault();
    var oldX = selected.position.x, oldZ = selected.position.z;
    selected.position.set(nx, 0, nz);
    var why = collides(selected);
    if (why) {
      selected.position.set(oldX, 0, oldZ);
      setStatus('移动后' + why + '，已还原。', true);
    } else {
      setStatus('微调 → (' + nx.toFixed(2) + ', ' + nz.toFixed(2) + ') m');
    }
    if (boxHelper) boxHelper.update();
  });

  // ---------- 渲染循环 ----------
  function resize() {
    var w = viewport.clientWidth, h = viewport.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    if (boxHelper && selected) boxHelper.update();
    renderer.render(scene, camera);
  })();

  // ---------- 启动：优先 fetch 外部图纸（改坐标重跑即时生效），file:// 下用内嵌副本 ----------
  fetchOrEmbedded('floorplan.svg', 'embedded-svg', 'floorplan.svg');

  // ---------- 测试 / 自动化接口 ----------
  window.__room = {
    parseSVG: parseSVG,
    loadSVGText: loadSVGText,
    place: function (type, x, z) { return placeFurniture(type, x, z); },
    clear: function () { clearFurniture(true); updateExportList(); },
    exportGLB: exportGLB,
    exportOBJ: exportOBJ,
    stats: function () {
      return {
        widthM: plan ? plan.widthM : null,
        depthM: plan ? plan.depthM : null,
        walls: plan ? plan.walls.length : 0,
        doors: plan ? plan.doors.length : 0,
        windows: plan ? plan.windows.length : 0,
        furniture: furnitureGroup.children.length
      };
    },
    furnitureInfo: function () {
      var rect = renderer.domElement.getBoundingClientRect();
      return furnitureGroup.children.map(function (g) {
        var v = new THREE.Vector3(g.position.x, 0.4, g.position.z).project(camera);
        return {
          name: g.name, x: g.position.x, z: g.position.z, rot: g.rotation.y,
          sx: rect.left + (v.x + 1) / 2 * rect.width,
          sy: rect.top + (1 - v.y) / 2 * rect.height
        };
      });
    }
  };
})();