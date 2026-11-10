/* 任务 1：SVG 图纸 → 3D 房间 → 家具摆放 → glb/obj 导出
 * 单位：SVG 100 units = 1 m。所有尺寸从 SVG 解析，不写死。
 */
(function () {
  'use strict';

  var UNIT = 100;            // SVG units per metre
  var WALL_H = 2.8;          // m
  var WALL_T = 0.12;         // 视觉/碰撞厚度（图纸按中心线）
  var SNAP = 0.1;            // m
  var viewport = document.getElementById('viewport');
  var statusEl = document.getElementById('status');
  var dimsEl = document.getElementById('dims');
  var countsEl = document.getElementById('counts');
  var exportListEl = document.getElementById('exportList');

  // ---------- three 基础 ----------
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe6ec);
  var camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  viewport.appendChild(renderer.domElement);
  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899a6, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(8, 12, 6);
  scene.add(sun);

  var roomGroup = new THREE.Group(); roomGroup.name = 'Room';
  var furnGroup = new THREE.Group(); furnGroup.name = 'Furniture';
  scene.add(roomGroup); scene.add(furnGroup);
  var gridHelper = null;

  var plan = null;           // 解析结果
  var wallRects = [];        // 碰撞用 OBB {cx,cz,hx,hz,ang}
  var selected = null;
  var boxHelper = null;
  var dragging = false;
  var raycaster = new THREE.Raycaster();
  var floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var idCounter = 0;

  function setStatus(msg, bad) {
    statusEl.textContent = msg || '';
    statusEl.className = bad ? 'bad' : '';
    statusEl.style.display = msg ? 'block' : 'none';
  }

  // ---------- SVG 解析 ----------
  function parseSVG(text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('SVG 解析失败');
    function lines(cls) {
      var out = [];
      var els = doc.querySelectorAll('.' + cls);
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (e.tagName.toLowerCase() !== 'line') continue;
        out.push({
          x1: parseFloat(e.getAttribute('x1')), y1: parseFloat(e.getAttribute('y1')),
          x2: parseFloat(e.getAttribute('x2')), y2: parseFloat(e.getAttribute('y2'))
        });
      }
      return out;
    }
    var walls = lines('wall'), doors = lines('door'), windows = lines('window');
    if (!walls.length) throw new Error('图纸里没有 class="wall" 的线段');
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    walls.forEach(function (w) {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });
    // 房间名：取落在外包络内的 text
    var labels = [];
    var texts = doc.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var tx = parseFloat(t.getAttribute('x')), ty = parseFloat(t.getAttribute('y'));
      var s = (t.textContent || '').trim();
      if (isFinite(tx) && isFinite(ty) && tx >= minX && tx <= maxX && ty >= minY && ty <= maxY &&
          s && !/unit|envelope|metre/i.test(s)) {
        labels.push({ x: tx, y: ty, text: s });
      }
    }
    // 门洞 subtraction：墙线段若与门洞共线重叠，切掉门洞区间
    var segs = [];
    walls.forEach(function (w) {
      var dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      var ux = dx / len, uy = dy / len;
      var cuts = [];
      doors.forEach(function (d) {
        // 门两端到墙直线的距离都要 ~0
        function dist(px, py) { return Math.abs((px - w.x1) * uy - (py - w.y1) * ux); }
        if (dist(d.x1, d.y1) > 2 || dist(d.x2, d.y2) > 2) return;
        var t1 = (d.x1 - w.x1) * ux + (d.y1 - w.y1) * uy;
        var t2 = (d.x2 - w.x1) * ux + (d.y2 - w.y1) * uy;
        var a = Math.max(0, Math.min(t1, t2)), b = Math.min(len, Math.max(t1, t2));
        if (b > a) cuts.push([a, b]);
      });
      cuts.sort(function (a, b) { return a[0] - b[0]; });
      var cur = 0;
      cuts.forEach(function (c) {
        if (c[0] > cur + 1e-6) segs.push(mk(cur, c[0]));
        cur = Math.max(cur, c[1]);
      });
      if (cur < len - 1e-6) segs.push(mk(cur, len));
      function mk(a, b) {
        return { x1: w.x1 + ux * a, y1: w.y1 + uy * a, x2: w.x1 + ux * b, y2: w.y1 + uy * b };
      }
    });
    return {
      minX: minX, minY: minY,
      width: (maxX - minX) / UNIT,
      depth: (maxY - minY) / UNIT,
      walls: segs, doors: doors, windows: windows, labels: labels
    };
  }

  function toWorld(x, y) {
    return { x: (x - plan.minX) / UNIT, z: (y - plan.minY) / UNIT };
  }

  // ---------- 建模 ----------
  function mat(color, opts) {
    var m = new THREE.MeshStandardMaterial(Object.assign({ color: color, roughness: 0.85, metalness: 0.05 }, opts || {}));
    return m;
  }

  function segmentMesh(seg, h, t, yCenter, material, name) {
    var a = toWorld(seg.x1, seg.y1), b = toWorld(seg.x2, seg.y2);
    var len = Math.hypot(b.x - a.x, b.z - a.z);
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, t), material);
    mesh.position.set((a.x + b.x) / 2, yCenter, (a.z + b.z) / 2);
    mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    mesh.name = name;
    return { mesh: mesh, len: len };
  }

  function clearGroup(g) {
    while (g.children.length) {
      var c = g.children.pop();
      c.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }

  function makeLabelSprite(text) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    var ctx = cv.getContext('2d');
    ctx.font = 'bold 36px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(90,90,90,0.9)';
    ctx.fillText(text, 128, 32);
    var tex = new THREE.CanvasTexture(cv);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(1.4, 0.35, 1);
    sp.name = 'Label_' + text;
    return sp;
  }

  function buildRoom(p) {
    plan = p;
    clearGroup(roomGroup);
    clearGroup(furnGroup);
    wallRects = [];
    select(null);
    if (gridHelper) { scene.remove(gridHelper); gridHelper = null; }

    var W = p.width, D = p.depth;
    dimsEl.textContent = '总宽 ' + W.toFixed(2) + ' m × 总深 ' + D.toFixed(2) + ' m';

    var floorMat = mat(0xcfc8bd); floorMat.name = 'Floor';
    var floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, D), floorMat);
    floor.position.set(W / 2, -0.025, D / 2);
    floor.name = 'Floor';
    roomGroup.add(floor);

    var wallMat = mat(0xf2efe9); wallMat.name = 'Wall';
    p.walls.forEach(function (seg, i) {
      var r = segmentMesh(seg, WALL_H, WALL_T, WALL_H / 2, wallMat, 'Wall_' + (i + 1));
      roomGroup.add(r.mesh);
      var a = toWorld(seg.x1, seg.y1), b = toWorld(seg.x2, seg.y2);
      wallRects.push({
        cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2,
        hx: r.len / 2, hz: WALL_T / 2,
        ang: Math.atan2(b.z - a.z, b.x - a.x)
      });
    });

    var winMat = mat(0x3d8ec9, { transparent: true, opacity: 0.45, roughness: 0.2 }); winMat.name = 'Window';
    p.windows.forEach(function (seg, i) {
      var r = segmentMesh(seg, 1.2, 0.06, 1.5, winMat, 'Window_' + (i + 1));
      roomGroup.add(r.mesh);
    });

    var doorMat = mat(0xb9b2a6); doorMat.name = 'DoorSill';
    p.doors.forEach(function (seg, i) {
      var r = segmentMesh(seg, 0.02, 0.16, 0.011, doorMat, 'DoorSill_' + (i + 1));
      roomGroup.add(r.mesh);
    });

    p.labels.forEach(function (l) {
      var w = toWorld(l.x, l.y);
      var sp = makeLabelSprite(l.text);
      sp.position.set(w.x, 0.9, w.z);
      roomGroup.add(sp);
    });

    var size = Math.max(W, D);
    gridHelper = new THREE.GridHelper(Math.ceil(size) + 2, (Math.ceil(size) + 2) * 10, 0x99aabb, 0xc3ccd4);
    gridHelper.position.set(W / 2, 0.002, D / 2);
    scene.add(gridHelper);

    camera.position.set(W / 2 + W * 0.9, Math.max(W, D) * 1.1, D / 2 + D * 1.4);
    controls.target.set(W / 2, 0.8, D / 2);
    controls.update();

    countsEl.textContent = '墙段 ' + p.walls.length + ' · 门洞 ' + p.doors.length + ' · 窗 ' + p.windows.length;
    updateExportList();
    setStatus('图纸已导入：从面板拖家具进场景');
  }

  // ---------- 家具（程序化几何） ----------
  var FURN = {
    desk:    { label: '桌子', w: 1.4, d: 0.7, color: 0xb98a5a },
    chair:   { label: '椅子', w: 0.5, d: 0.5, color: 0x4a6fa5 },
    cabinet: { label: '柜子', w: 0.9, d: 0.45, color: 0x7d8471 }
  };

  function buildFurniture(type) {
    var def = FURN[type];
    var g = new THREE.Group();
    var m = mat(def.color); m.name = 'Furn_' + type;
    var dark = mat(0x555a60); dark.name = 'Furn_metal';
    function box(w, h, d, x, y, z, material) {
      var b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || m);
      b.position.set(x, y, z);
      g.add(b);
      return b;
    }
    if (type === 'desk') {
      box(1.4, 0.04, 0.7, 0, 0.73, 0);
      [[-0.65, -0.3], [0.65, -0.3], [-0.65, 0.3], [0.65, 0.3]].forEach(function (p) {
        box(0.05, 0.71, 0.05, p[0], 0.355, p[1], dark);
      });
    } else if (type === 'chair') {
      box(0.46, 0.05, 0.46, 0, 0.44, 0);
      box(0.46, 0.5, 0.05, 0, 0.72, -0.205);
      [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]].forEach(function (p) {
        box(0.04, 0.42, 0.04, p[0], 0.21, p[1], dark);
      });
    } else {
      box(0.9, 1.8, 0.45, 0, 0.9, 0);
      box(0.02, 1.6, 0.02, 0, 0.9, 0.235, dark);      // 门缝
      box(0.03, 0.2, 0.03, -0.08, 1.0, 0.24, dark);   // 把手
      box(0.03, 0.2, 0.03, 0.08, 1.0, 0.24, dark);
    }
    g.name = def.label + '_' + (++idCounter);
    g.userData = { type: type, w: def.w, d: def.d, label: def.label };
    return g;
  }

  // ---------- 碰撞（2D OBB SAT） ----------
  function obbOf(obj) {
    return {
      cx: obj.position.x, cz: obj.position.z,
      hx: obj.userData.w / 2, hz: obj.userData.d / 2,
      ang: -obj.rotation.y
    };
  }
  function obbOverlap(a, b) {
    var rects = [a, b];
    for (var r = 0; r < 2; r++) {
      var R = rects[r];
      var axes = [[Math.cos(R.ang), Math.sin(R.ang)], [-Math.sin(R.ang), Math.cos(R.ang)]];
      for (var k = 0; k < 2; k++) {
        var ax = axes[k][0], az = axes[k][1];
        function proj(o) {
          var c = o.cx * ax + o.cz * az;
          var e = o.hx * Math.abs(Math.cos(o.ang) * ax + Math.sin(o.ang) * az) +
                  o.hz * Math.abs(-Math.sin(o.ang) * ax + Math.cos(o.ang) * az);
          return [c - e, c + e];
        }
        var pa = proj(a), pb = proj(b);
        if (pa[1] <= pb[0] + 1e-9 || pb[1] <= pa[0] + 1e-9) return false;
      }
    }
    return true;
  }
  function collisionInfo(obj) {
    var o = obbOf(obj), reasons = [];
    // 出界
    var cs = corners(o);
    for (var i = 0; i < cs.length; i++) {
      if (cs[i][0] < 0 || cs[i][0] > plan.width || cs[i][1] < 0 || cs[i][1] > plan.depth) {
        reasons.push('超出房间范围'); break;
      }
    }
    for (var w = 0; w < wallRects.length; w++) {
      if (obbOverlap(o, wallRects[w])) { reasons.push('穿墙'); break; }
    }
    furnGroup.children.forEach(function (other) {
      if (other !== obj && obbOverlap(o, obbOf(other))) reasons.push('与「' + other.name + '」叠放');
    });
    return reasons;
  }
  function corners(o) {
    var c = Math.cos(o.ang), s = Math.sin(o.ang), out = [];
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) {
      var lx = q[0] * o.hx, lz = q[1] * o.hz;
      out.push([o.cx + lx * c - lz * s, o.cz + lx * s + lz * c]);
    });
    return out;
  }
  function tint(obj, bad) {
    obj.traverse(function (o) {
      if (o.isMesh && o.material && o.material.emissive) {
        o.material = o.material.clone();
        o.material.emissive.setHex(bad ? 0x881111 : 0x000000);
      }
    });
  }
  function refreshCollision(obj) {
    if (!obj) return;
    var reasons = collisionInfo(obj);
    tint(obj, reasons.length > 0);
    if (reasons.length) setStatus('⚠ ' + obj.name + '：' + reasons.join('、'), true);
    else setStatus(obj.name + ' 已放置（方向键微调，R 旋转）');
    updateExportList();
  }

  // ---------- 选择 / 拖拽 ----------
  function select(obj) {
    selected = obj;
    if (boxHelper) { scene.remove(boxHelper); boxHelper = null; }
    if (obj) {
      boxHelper = new THREE.BoxHelper(obj, 0x2266cc);
      scene.add(boxHelper);
    }
  }
  function pointerNDC(e) {
    var r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  function floorPoint(e) {
    raycaster.setFromCamera(pointerNDC(e), camera);
    var p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(floorPlane, p) ? p : null;
  }
  function pickFurniture(e) {
    raycaster.setFromCamera(pointerNDC(e), camera);
    var hits = raycaster.intersectObjects(furnGroup.children, true);
    if (!hits.length) return null;
    var o = hits[0].object;
    while (o.parent && o.parent !== furnGroup) o = o.parent;
    return o.parent === furnGroup ? o : null;
  }
  function snap(v) { return Math.round(v / SNAP) * SNAP; }
  function clampToRoom(obj) {
    obj.position.x = Math.max(0.05, Math.min(plan.width - 0.05, obj.position.x));
    obj.position.z = Math.max(0.05, Math.min(plan.depth - 0.05, obj.position.z));
  }

  renderer.domElement.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !plan) return;
    var hit = pickFurniture(e);
    if (hit) {
      select(hit);
      dragging = true;
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
      refreshCollision(hit);
    } else {
      select(null);
      setStatus('');
    }
  });
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (!dragging || !selected) return;
    var p = floorPoint(e);
    if (!p) return;
    selected.position.x = snap(p.x);
    selected.position.z = snap(p.z);
    clampToRoom(selected);
    if (boxHelper) boxHelper.update();
    refreshCollision(selected);
  });
  renderer.domElement.addEventListener('pointerup', function (e) {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    if (selected) refreshCollision(selected);
  });

  // 面板拖入
  document.querySelectorAll('.furn').forEach(function (el) {
    el.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/furn', el.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dblclick', function () { addFurnitureAt(el.dataset.type, null); });
  });
  viewport.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  viewport.addEventListener('drop', function (e) {
    e.preventDefault();
    var type = e.dataTransfer.getData('text/furn');
    if (!type || !plan) return;
    addFurnitureAt(type, floorPoint(e));
  });
  function addFurnitureAt(type, p) {
    var g = buildFurniture(type);
    if (p) { g.position.set(snap(p.x), 0, snap(p.z)); }
    else { g.position.set(snap(plan.width / 2), 0, snap(plan.depth / 2)); }
    clampToRoom(g);
    furnGroup.add(g);
    select(g);
    refreshCollision(g);
  }

  // 键盘微调
  window.addEventListener('keydown', function (e) {
    if (!selected) return;
    var step = 0.1, handled = true;
    switch (e.key) {
      case 'ArrowUp': selected.position.z -= step; break;
      case 'ArrowDown': selected.position.z += step; break;
      case 'ArrowLeft': selected.position.x -= step; break;
      case 'ArrowRight': selected.position.x += step; break;
      case 'r': case 'R': selected.rotation.y += Math.PI / 12; break;
      case 'Delete': case 'Backspace':
        furnGroup.remove(selected); select(null); updateExportList(); setStatus('已删除'); return;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      clampToRoom(selected);
      if (boxHelper) boxHelper.update();
      refreshCollision(selected);
    }
  });

  // ---------- 撤销 / 导出 ----------
  document.getElementById('btnReset').addEventListener('click', function () {
    clearGroup(furnGroup);
    select(null);
    updateExportList();
    setStatus('已撤销：回到刚导入图纸的状态');
  });

  function exportRoot() {
    var root = new THREE.Group();
    root.name = 'FloorplanScene';
    root.add(roomGroup.clone(true));
    root.add(furnGroup.clone(true));
    return root;
  }
  function updateExportList() {
    if (!plan) { exportListEl.textContent = '尚未导入图纸'; return; }
    var nFurn = furnGroup.children.length;
    var total = plan.walls.length + plan.windows.length + plan.doors.length + 1 + nFurn;
    var names = furnGroup.children.map(function (g) { return g.name; });
    exportListEl.innerHTML = '<b>将导出 ' + total + ' 个物体</b><br>' +
      '地板 ×1 · 墙 ×' + plan.walls.length + ' · 窗 ×' + plan.windows.length +
      ' · 门洞贴条 ×' + plan.doors.length + ' · 家具 ×' + nFurn +
      (names.length ? '<br>' + names.join('、') : '');
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  document.getElementById('btnGlb').addEventListener('click', function () {
    if (!plan) return;
    var exporter = new THREE.GLTFExporter();
    exporter.parse(exportRoot(), function (buf) {
      download(new Blob([buf], { type: 'model/gltf-binary' }), 'out.glb');
      setStatus('out.glb 已导出');
    }, function (err) { setStatus('GLB 导出失败：' + err, true); }, { binary: true });
  });

  document.getElementById('btnObj').addEventListener('click', function () {
    if (!plan) return;
    var root = exportRoot();
    // 收集材质写 mtl
    var mats = {};
    root.traverse(function (o) {
      if (o.isMesh && o.material && o.material.name) mats[o.material.name] = o.material;
    });
    var mtl = '# generated by floorplan app\n';
    Object.keys(mats).forEach(function (name) {
      var m = mats[name], c = m.color;
      mtl += 'newmtl ' + name + '\n' +
        'Ka 0.000 0.000 0.000\n' +
        'Kd ' + c.r.toFixed(4) + ' ' + c.g.toFixed(4) + ' ' + c.b.toFixed(4) + '\n' +
        'Ks 0.000 0.000 0.000\n' +
        'd ' + (m.opacity !== undefined ? m.opacity.toFixed(3) : '1.000') + '\n' +
        'illum 1\n\n';
    });
    var obj = new THREE.OBJExporter().parse(root);
    download(new Blob(['mtllib out.mtl\n' + obj], { type: 'text/plain' }), 'out.obj');
    download(new Blob([mtl], { type: 'text/plain' }), 'out.mtl');
    setStatus('out.obj + out.mtl 已导出');
  });

  // ---------- 载入图纸 ----------
  function loadText(text) {
    try {
      buildRoom(parseSVG(text));
      document.getElementById('loadOverlay').style.display = 'none';
    } catch (err) {
      setStatus('载入失败：' + err.message, true);
    }
  }
  document.getElementById('btnLoad').addEventListener('click', function () {
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { loadText(rd.result); };
    rd.readAsText(f);
    e.target.value = '';
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
    if (boxHelper) boxHelper.update();
    renderer.render(scene, camera);
  })();

  // 初始：优先 fetch 外部图纸（静态服务器）；file:// 下退回内嵌副本（同一份 SVG，仍走解析器）
  fetch('assets/floorplan.svg').then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }).then(loadText).catch(function () {
    loadText(EMBEDDED_SVG);
    setStatus('file:// 模式：使用内嵌图纸副本。改图纸请用「载入新图纸」按钮或静态服务器。');
  });
})();
