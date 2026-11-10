/* 任务 3：火山喷发。程序化几何 + CPU 粒子积分（弹道：v' = v - g·dt）。
 * 三个以上实时参数：喷发强度(初速)、粒子数、重力、风速。打开即喷发。
 */
(function () {
  'use strict';
  var canvas = document.getElementById('c');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);
  scene.fog = new THREE.FogExp2(0x0a0a14, 0.012);
  var camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(26, 14, 30);
  camera.lookAt(0, 8, 0);

  // ---------- 参数 ----------
  var P = { power: 1.2, maxCount: 1800, gravity: 9.8, wind: 0.6 };
  function bind(id, key, fmt) {
    var el = document.getElementById(id), lab = document.getElementById(id + 'V');
    el.addEventListener('input', function () {
      P[key] = parseFloat(el.value);
      lab.textContent = fmt ? fmt(P[key]) : P[key];
    });
  }
  bind('power', 'power', function (v) { return v.toFixed(2); });
  bind('count', 'maxCount');
  bind('grav', 'gravity');
  bind('wind', 'wind');

  // ---------- 地形 / 火山体（程序化） ----------
  var ground = new THREE.Mesh(
    new THREE.CircleGeometry(120, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // 火山锥：lathe 轮廓
  var pts = [];
  var profile = [[14, 0], [11, 2.5], [8, 5.5], [5.5, 8.5], [3.6, 11], [2.6, 12.4], [2.2, 12.6], [1.6, 12.2], [1.4, 11.6]];
  profile.forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
  var coneGeo = new THREE.LatheGeometry(pts, 40);
  // 顶点扰动，做出岩石感
  var pos = coneGeo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    var n = Math.sin(x * 2.1 + y * 3.7) * Math.cos(z * 1.9 + y * 2.3) * 0.22;
    var r = Math.sqrt(x * x + z * z);
    if (r > 0.01) { var s = (r + n) / r; pos.setX(i, x * s); pos.setZ(i, z * s); }
  }
  coneGeo.computeVertexNormals();
  var cone = new THREE.Mesh(coneGeo, new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.95, flatShading: true }));
  scene.add(cone);

  // 火山口熔岩面
  var crater = new THREE.Mesh(
    new THREE.CircleGeometry(1.55, 24),
    new THREE.MeshBasicMaterial({ color: 0xff5a00 })
  );
  crater.rotation.x = -Math.PI / 2;
  crater.position.y = 11.7;
  scene.add(crater);

  // 熔岩流：从火山口沿坡而下的发光带（几条折线管）
  var lavaMat = new THREE.MeshBasicMaterial({ color: 0xff4400 });
  var lavaFlows = [];
  for (var f = 0; f < 4; f++) {
    var ang = f * Math.PI / 2 + 0.4;
    var curvePts = [];
    for (var s = 0; s <= 10; s++) {
      var t = s / 10;
      var rr = 1.5 + t * 12.5;
      var yy = 11.7 * (1 - t) * (1 - t) + 0.08;
      var aa = ang + Math.sin(t * 5 + f) * 0.12;
      curvePts.push(new THREE.Vector3(Math.cos(aa) * rr, yy, Math.sin(aa) * rr));
    }
    var tube = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curvePts), 24, 0.28, 6, false),
      lavaMat.clone()
    );
    scene.add(tube);
    lavaFlows.push(tube);
  }

  // ---------- 灯光 ----------
  scene.add(new THREE.AmbientLight(0x223, 0.6));
  var moon = new THREE.DirectionalLight(0x8899ff, 0.35);
  moon.position.set(-30, 40, -20);
  scene.add(moon);
  var glow = new THREE.PointLight(0xff6600, 2.2, 60, 1.6);
  glow.position.set(0, 14, 0);
  scene.add(glow);

  // 星空
  (function () {
    var g = new THREE.BufferGeometry(), n = 600, arr = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.45;
      var r = 200;
      arr[i * 3] = r * Math.sin(ph) * Math.cos(th);
      arr[i * 3 + 1] = r * Math.cos(ph) * 0.6 + 20;
      arr[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaabbdd, size: 0.5, sizeAttenuation: true })));
  })();

  // ---------- 粒子系统 ----------
  // 三类：熔岩弹（弹道）、火星（短命弹道）、烟（浮力+风）
  var MAX = 6000;
  function makeSystem(n, size, blending) {
    var geo = new THREE.BufferGeometry();
    var p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    var mat = new THREE.PointsMaterial({
      size: size, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: blending, sizeAttenuation: true
    });
    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    return {
      geo: geo, p: p, c: c, n: n,
      vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
      life: new Float32Array(n), maxLife: new Float32Array(n),
      cursor: 0
    };
  }
  var bombs = makeSystem(2500, 0.55, THREE.AdditiveBlending);
  var sparks = makeSystem(2000, 0.25, THREE.AdditiveBlending);
  var smoke = makeSystem(1500, 2.6, THREE.NormalBlending);
  smoke.geo.attributes.position.array.forEach(function () {});
  // 初始全部藏到地下
  [bombs, sparks, smoke].forEach(function (sys) {
    for (var i = 0; i < sys.n; i++) { sys.p[i * 3 + 1] = -100; sys.life[i] = 0; }
  });

  var VENT = new THREE.Vector3(0, 12.2, 0);
  function emit(sys, v0, spread, up, life) {
    var i = sys.cursor; sys.cursor = (sys.cursor + 1) % sys.n;
    var a = Math.random() * Math.PI * 2;
    var rr = Math.random() * 1.1;
    sys.p[i * 3] = VENT.x + Math.cos(a) * rr;
    sys.p[i * 3 + 1] = VENT.y;
    sys.p[i * 3 + 2] = VENT.z + Math.sin(a) * rr;
    var speed = v0 * (0.7 + Math.random() * 0.6);
    var tilt = Math.random() * spread;
    sys.vx[i] = Math.cos(a) * Math.sin(tilt) * speed;
    sys.vz[i] = Math.sin(a) * Math.sin(tilt) * speed;
    sys.vy[i] = Math.cos(tilt) * speed * up;
    sys.life[i] = sys.maxLife[i] = life * (0.6 + Math.random() * 0.8);
  }

  var eruptT = 0;             // 喷发周期相位
  var emitAcc = 0;
  function reset() {
    [bombs, sparks, smoke].forEach(function (sys) {
      for (var i = 0; i < sys.n; i++) { sys.life[i] = 0; sys.p[i * 3 + 1] = -100; }
      sys.cursor = 0;
    });
    eruptT = 0; emitAcc = 0;
  }
  document.getElementById('reset').addEventListener('click', reset);

  // ---------- 主循环 ----------
  var last = performance.now(), fpsAcc = 0, fpsN = 0, fpsLast = last;
  var fpsEl = document.getElementById('fps');
  var camT = 0;

  function step(now) {
    requestAnimationFrame(step);
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // FPS
    fpsAcc += dt; fpsN++;
    if (now - fpsLast > 500) {
      fpsEl.textContent = Math.round(fpsN / fpsAcc) + ' FPS';
      fpsAcc = 0; fpsN = 0; fpsLast = now;
    }

    // 喷发节奏：持续喷 + 每 6 秒一次大爆发（打开 10 秒内必见高潮）
    eruptT += dt;
    var cycle = eruptT % 6;
    var burst = cycle < 1.2 ? 3.0 : 1.0;
    if (cycle > 5.4) burst = 1.0 + (cycle - 5.4) * 3.3; // 蓄力渐强
    var v0 = 14 * P.power * Math.sqrt(burst);           // 初速 ∝ 强度·√爆发
    var rate = P.maxCount * 0.45 * burst;               // 每秒发射数
    emitAcc += rate * dt;
    var quota = Math.min(Math.floor(emitAcc), 400);
    emitAcc -= quota;
    for (var e = 0; e < quota; e++) {
      var r = Math.random();
      if (r < 0.4) emit(bombs, v0, 0.35, 1.0, 4.5);
      else if (r < 0.75) emit(sparks, v0 * 1.15, 0.55, 1.0, 1.6);
      else emit(smoke, v0 * 0.28, 0.5, 1.0, 6.0);
    }

    var g = P.gravity, wind = P.wind;
    // 熔岩弹 & 火星：v -= g·dt，位置 += v·dt；落地熄灭
    [bombs, sparks].forEach(function (sys, si) {
      var hot = si === 0;
      for (var i = 0; i < sys.n; i++) {
        if (sys.life[i] <= 0) continue;
        sys.life[i] -= dt;
        var ix = i * 3;
        sys.vy[i] -= g * dt;
        sys.vx[i] += wind * 0.15 * dt;
        sys.p[ix] += sys.vx[i] * dt;
        sys.p[ix + 1] += sys.vy[i] * dt;
        sys.p[ix + 2] += sys.vz[i] * dt;
        // 落在锥面上近似：y < 锥高(r) 即灭
        var rr = Math.hypot(sys.p[ix], sys.p[ix + 2]);
        var coneY = Math.max(0, 12.4 - rr * 0.95);
        if (sys.p[ix + 1] < coneY || sys.life[i] <= 0) {
          sys.life[i] = 0; sys.p[ix + 1] = -100;
          sys.c[ix] = sys.c[ix + 1] = sys.c[ix + 2] = 0;
          continue;
        }
        var t = sys.life[i] / sys.maxLife[i]; // 1 新 → 0 冷
        if (hot) {
          sys.c[ix] = 1.0;
          sys.c[ix + 1] = 0.25 + 0.55 * t;
          sys.c[ix + 2] = 0.05 + 0.25 * t * t;
        } else {
          sys.c[ix] = 1.0 * t;
          sys.c[ix + 1] = 0.6 * t * t;
          sys.c[ix + 2] = 0.15 * t * t;
        }
      }
      sys.geo.attributes.position.needsUpdate = true;
      sys.geo.attributes.color.needsUpdate = true;
    });
    // 烟：浮力上升 + 风漂 + 扩散，颜色随寿命变灰
    for (var i = 0; i < smoke.n; i++) {
      if (smoke.life[i] <= 0) continue;
      smoke.life[i] -= dt;
      var ix = i * 3;
      smoke.vy[i] += (2.2 - smoke.vy[i]) * 0.4 * dt;   // 趋向浮力终速
      smoke.vx[i] += (wind - smoke.vx[i]) * 0.3 * dt;
      smoke.p[ix] += smoke.vx[i] * dt + (Math.random() - 0.5) * 0.12;
      smoke.p[ix + 1] += smoke.vy[i] * dt;
      smoke.p[ix + 2] += smoke.vz[i] * dt + (Math.random() - 0.5) * 0.12;
      var t = smoke.life[i] / smoke.maxLife[i];
      if (smoke.life[i] <= 0) { smoke.p[ix + 1] = -100; smoke.c[ix] = smoke.c[ix+1] = smoke.c[ix+2] = 0; continue; }
      var heat = Math.max(0, t - 0.7) / 0.3;           // 刚喷出带火色
      var grey = 0.16 + 0.1 * (1 - t);
      smoke.c[ix] = grey + heat * 0.7;
      smoke.c[ix + 1] = grey + heat * 0.25;
      smoke.c[ix + 2] = grey;
    }
    smoke.geo.attributes.position.needsUpdate = true;
    smoke.geo.attributes.color.needsUpdate = true;

    // 火山口辉光随爆发脉动
    var pulse = 1.6 + burst * 0.8 + Math.sin(now * 0.02) * 0.25;
    glow.intensity = pulse * P.power;
    crater.material.color.setHSL(0.05 + 0.02 * Math.sin(now * 0.01), 1, 0.45 + 0.1 * burst / 3);
    lavaFlows.forEach(function (tube, k) {
      tube.material.color.setHSL(0.03, 1, 0.35 + 0.12 * Math.sin(now * 0.003 + k * 2) * P.power);
    });

    // 相机缓慢环绕
    camT += dt * 0.06;
    camera.position.set(Math.cos(camT) * 34, 13 + Math.sin(camT * 0.7) * 2, Math.sin(camT) * 34);
    camera.lookAt(0, 9, 0);

    renderer.render(scene, camera);
  }

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // 开场即一次大爆发：把相位直接放到爆发段
  eruptT = 0.1;
  requestAnimationFrame(step);
})();
