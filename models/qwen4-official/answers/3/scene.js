/* 火箭发射 · 程序化实时渲染
 * 物理模型（与页面自检一致）：
 *   推力 F 恒定（可调倍率）；质量 m = 干重 + 剩余燃料，随燃烧线性减小；
 *   加速度 a = F/m - g，燃料将尽时 m 最小 → a 最大；
 *   级间分离抛掉空壳，m 骤降 → a 跳升。
 *   尾焰膨胀与环境气压 exp(-h/H) 相关：越高越膨胀，马赫环间距越大。
 */
(function () {
  'use strict';

  // ---------- 参数（面板实时可调） ----------
  var params = { thrust: 1.0, particles: 2500, timescale: 1.0 };

  // ---------- 火箭物理常数（两级，SI 单位，数值按演示比例缩放） ----------
  var G = 9.81;
  var STAGE1 = { dry: 22000, fuel: 180000, burnRate: 30000, thrust: 4.2e6 };
  var STAGE2 = { dry: 4500, fuel: 42000, burnRate: 700, thrust: 9.0e5 };
  var SCALE_H = 0.008; // 1 m 真实高度 → 0.008 场景单位（纯视觉映射，物理仍按米算）
  var ROCKET_SC = 0.35; // 火箭整体视觉缩放

  // ---------- 渲染器 / 场景 ----------
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x050810, 0.0016);
  var camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);

  scene.add(new THREE.AmbientLight(0x334455, 0.7));
  var moon = new THREE.DirectionalLight(0xaabbdd, 0.8);
  moon.position.set(-60, 80, -40);
  scene.add(moon);
  var flameLight = new THREE.PointLight(0xff8830, 0, 120, 2);
  scene.add(flameLight);

  // ---------- 星空 ----------
  (function stars() {
    var n = 1600, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var r = 1500 + Math.random() * 800;
      var th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 0.95);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.6 + 100;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var m = new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false });
    scene.add(new THREE.Points(g, m));
  })();

  // ---------- 地面 / 发射台 ----------
  var ground = new THREE.Mesh(
    new THREE.CircleGeometry(900, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  var pad = new THREE.Mesh(
    new THREE.CylinderGeometry(6, 7.5, 1.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 0.8 })
  );
  pad.position.y = 0.6;
  scene.add(pad);

  var tower = new THREE.Group();
  var towerMat = new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.7 });
  for (var ti = 0; ti < 4; ti++) {
    var beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 26, 0.5), towerMat);
    beam.position.set(-8 + (ti % 2) * 2.4, 13, -2 + Math.floor(ti / 2) * 2.4);
    tower.add(beam);
  }
  for (var tj = 0; tj < 6; tj++) {
    var cross = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.35, 0.35), towerMat);
    cross.position.set(-6.8, 3 + tj * 4.2, -0.8);
    tower.add(cross);
  }
  scene.add(tower);

  // ---------- 火箭（程序化几何） ----------
  function makeStage(radius, len, color, noseLen) {
    var g = new THREE.Group();
    var body = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, len, 20),
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.35, metalness: 0.3 })
    );
    body.position.y = len / 2;
    g.add(body);
    if (noseLen > 0) {
      var nose = new THREE.Mesh(
        new THREE.ConeGeometry(radius, noseLen, 20),
        new THREE.MeshStandardMaterial({ color: 0xd8dde5, roughness: 0.3, metalness: 0.2 })
      );
      nose.position.y = len + noseLen / 2;
      g.add(nose);
    }
    var bell = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.45, radius * 0.8, 1.2, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x555c66, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide })
    );
    bell.position.y = -0.6;
    g.add(bell);
    return g;
  }

  var rocketRoot = new THREE.Group();      // 位置 = 飞行高度
  var stage1Mesh = makeStage(1.5, 14, 0xe8eaee, 0);
  var stage2Mesh = makeStage(1.2, 6, 0xcfd6e0, 3.2);
  stage2Mesh.position.y = 14;
  // 尾翼
  var finMat = new THREE.MeshStandardMaterial({ color: 0xb03030, roughness: 0.5 });
  for (var fi = 0; fi < 4; fi++) {
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.2, 1.8), finMat);
    var ang = fi * Math.PI / 2;
    fin.position.set(Math.cos(ang) * 1.7, 1.6, Math.sin(ang) * 1.7);
    fin.rotation.y = -ang;
    stage1Mesh.add(fin);
  }
  // 级间段
  var interstage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.5, 1.2, 20),
    new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.6 })
  );
  interstage.position.y = 13.6;
  rocketRoot.add(stage1Mesh); rocketRoot.add(interstage); rocketRoot.add(stage2Mesh);
  rocketRoot.scale.setScalar(ROCKET_SC);
  scene.add(rocketRoot);

  // 分离后的空壳（独立实体，带自己的速度）
  var debris = null;

  // ---------- 尾焰 / 马赫环 / 烟雾：粒子系统 ----------
  var MAX_P = 6000;
  function makeParticleSystem(blending) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_P * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_P * 3), 3));
    var mat = new THREE.PointsMaterial({
      size: 1.4, vertexColors: true, transparent: true, opacity: 0.95,
      blending: blending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return {
      geo: geo, pts: pts,
      vel: new Float32Array(MAX_P * 3),
      life: new Float32Array(MAX_P),
      maxLife: new Float32Array(MAX_P),
      kind: new Uint8Array(MAX_P), // 0 尾焰 1 马赫环 2 烟雾 3 分离火花
      cursor: 0
    };
  }
  var fireSys = makeParticleSystem(THREE.AdditiveBlending);
  var smokeSys = makeParticleSystem(THREE.NormalBlending);
  smokeSys.pts.material.opacity = 0.32;
  smokeSys.pts.material.size = 3.2;

  function emit(sys, x, y, z, vx, vy, vz, life, kind) {
    var i = sys.cursor; sys.cursor = (sys.cursor + 1) % MAX_P;
    var p = sys.geo.attributes.position.array;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    sys.vel[i * 3] = vx; sys.vel[i * 3 + 1] = vy; sys.vel[i * 3 + 2] = vz;
    sys.life[i] = life; sys.maxLife[i] = life; sys.kind[i] = kind;
  }

  // ---------- 飞行状态 ----------
  var flight;
  function resetFlight() {
    flight = {
      t: 0, h: 0, v: 0,
      stage: 1,
      fuel1: STAGE1.fuel, fuel2: STAGE2.fuel,
      separated: false, sepT: -1,
      accel: 0, maxAccel: 0,
      ignitionT: 0.5 // 点火延迟，制造倒计时感
    };
    if (debris) { scene.remove(debris); debris = null; }
    rocketRoot.visible = true;
    stage1Mesh.visible = true; interstage.visible = true;
    rocketRoot.position.set(0, 1.2, 0);
    rocketRoot.rotation.set(0, 0, 0);
    fireSys.life.fill(0); smokeSys.life.fill(0);
    banner('点火倒计时', 1200);
  }

  var bannerEl = document.getElementById('event-banner');
  var bannerTimer = null;
  function banner(text, ms) {
    bannerEl.textContent = text;
    bannerEl.style.opacity = '1';
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { bannerEl.style.opacity = '0'; }, ms || 1800);
  }

  function currentMass() {
    if (flight.stage === 1) return STAGE1.dry + flight.fuel1 + STAGE2.dry + STAGE2.fuel;
    return STAGE2.dry + flight.fuel2;
  }
  function currentThrust() {
    var base = flight.stage === 1 ? STAGE1.thrust : STAGE2.thrust;
    return base * params.thrust;
  }

  function stepPhysics(dt) {
    var f = flight;
    f.t += dt;
    if (f.t < f.ignitionT) { f.accel = 0; return; }

    var burning = false, F = 0;
    if (f.stage === 1 && f.fuel1 > 0) {
      var dm1 = Math.min(f.fuel1, STAGE1.burnRate * dt);
      f.fuel1 -= dm1; F = currentThrust(); burning = true;
    } else if (f.stage === 1 && !f.separated) {
      // 一级燃尽 → 分离
      f.separated = true; f.sepT = f.t; f.stage = 2;
      stage1Mesh.visible = false; interstage.visible = false;
      debris = stage1Mesh;
      scene.add(debris);
      debris.position.copy(rocketRoot.position);
      debris.scale.setScalar(ROCKET_SC);
      debris.userData = { v: f.v * 0.92, vr: 0.35 };
      banner('级间分离', 2000);
      // 分离火花
      for (var s = 0; s < 120; s++) {
        var a = Math.random() * Math.PI * 2;
        emit(fireSys, rocketRoot.position.x, rocketRoot.position.y + 14 * ROCKET_SC, rocketRoot.position.z,
          Math.cos(a) * (4 + Math.random() * 10), (Math.random() - 0.3) * 12, Math.sin(a) * (4 + Math.random() * 10),
          0.5 + Math.random() * 0.5, 3);
      }
    }
    if (f.stage === 2 && f.fuel2 > 0) {
      var dm2 = Math.min(f.fuel2, STAGE2.burnRate * dt);
      f.fuel2 -= dm2; F = currentThrust(); burning = true;
    }

    var m = currentMass();
    f.accel = F / m - G;             // a = F/m - g
    if (f.accel > f.maxAccel) f.maxAccel = f.accel;
    f.v += f.accel * dt;
    f.h += f.v * dt;
    if (f.h < 0) { f.h = 0; f.v = Math.max(0, f.v); }
    f.burning = burning;

    // 视觉高度映射（物理量仍是米）
    rocketRoot.position.y = 1.2 + f.h * SCALE_H;
    // 程序转弯：升空后缓慢倾斜，镜头更有张力
    var tilt = Math.min(0.32, Math.max(0, (f.h - 400) * 0.00006));
    rocketRoot.rotation.z = -tilt;

    if (debris) {
      debris.userData.v -= G * dt;
      debris.position.y += debris.userData.v * dt * SCALE_H;
      debris.rotation.z += debris.userData.vr * dt;
      if (debris.position.y < -60) { scene.remove(debris); debris = null; }
    }
  }

  // ---------- 粒子更新 ----------
  function stepParticles(dt) {
    var f = flight;
    var nozzleY = rocketRoot.position.y + (f.stage === 1 ? -0.4 : 13.4) * ROCKET_SC;
    var nozzleX = rocketRoot.position.x + Math.sin(rocketRoot.rotation.z) * (f.stage === 1 ? 0 : 14 * ROCKET_SC);
    // 环境气压随高度指数衰减 → 尾焰膨胀系数
    var expand = 1 + 2.6 * (1 - Math.exp(-f.h / 9000));

    if (f.burning && f.t >= f.ignitionT) {
      var n = Math.round(params.particles * dt * 30);
      for (var i = 0; i < n; i++) {
        var spread = (0.6 + Math.random() * 1.4) * expand;
        var a = Math.random() * Math.PI * 2;
        var speed = 26 + Math.random() * 22;
        emit(fireSys,
          nozzleX + (Math.random() - 0.5) * 0.7, nozzleY, rocketRoot.position.z + (Math.random() - 0.5) * 0.7,
          Math.cos(a) * spread, -speed, Math.sin(a) * spread,
          0.35 + Math.random() * 0.45, 0);
      }
      // 马赫环：沿喷流轴等间距的亮环（间距随膨胀增大）
      var ringGap = 1.5 * expand;
      var rings = 5;
      for (var r = 1; r <= rings; r++) {
        var ry = nozzleY - r * ringGap;
        var rr = (0.5 + r * 0.16) * expand * (0.85 + 0.15 * Math.sin(f.t * 40 + r));
        var cnt = 10;
        for (var k = 0; k < cnt; k++) {
          var ak = (k / cnt) * Math.PI * 2;
          emit(fireSys, nozzleX + Math.cos(ak) * rr, ry, rocketRoot.position.z + Math.sin(ak) * rr,
            Math.cos(ak) * 1.5, -30 - r * 2, Math.sin(ak) * 1.5, 0.16, 1);
        }
      }
      // 地面附近卷起烟雾
      if (f.h < 260) {
        var sn = Math.round(params.particles * dt * 6);
        for (var j = 0; j < sn; j++) {
          var sa = Math.random() * Math.PI * 2, sr = 2 + Math.random() * 6;
          emit(smokeSys, Math.cos(sa) * sr, 0.8 + Math.random() * 2, Math.sin(sa) * sr,
            Math.cos(sa) * (5 + Math.random() * 9), 2 + Math.random() * 5, Math.sin(sa) * (5 + Math.random() * 9),
            2.2 + Math.random() * 2.4, 2);
        }
      }
      flameLight.position.set(nozzleX, nozzleY - 2, rocketRoot.position.z);
      flameLight.intensity = 3.2 * params.thrust * (0.85 + Math.random() * 0.3);
    } else {
      flameLight.intensity *= Math.pow(0.02, dt);
    }

    updateSys(fireSys, dt, true);
    updateSys(smokeSys, dt, false);
  }

  function updateSys(sys, dt, additive) {
    var p = sys.geo.attributes.position.array;
    var c = sys.geo.attributes.color.array;
    for (var i = 0; i < MAX_P; i++) {
      if (sys.life[i] <= 0) { c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0; continue; }
      sys.life[i] -= dt;
      var t = Math.max(0, sys.life[i] / sys.maxLife[i]); // 1 新生 → 0 将死
      p[i * 3] += sys.vel[i * 3] * dt;
      p[i * 3 + 1] += sys.vel[i * 3 + 1] * dt;
      p[i * 3 + 2] += sys.vel[i * 3 + 2] * dt;
      var kind = sys.kind[i];
      if (kind === 0) { // 尾焰：白黄 → 橙红 → 暗
        c[i * 3] = 1.0 * t + 0.2;
        c[i * 3 + 1] = (0.85 * t * t + 0.1) * t;
        c[i * 3 + 2] = 0.25 * t * t * t;
      } else if (kind === 1) { // 马赫环：青白亮环
        c[i * 3] = 0.55 * t; c[i * 3 + 1] = 0.85 * t; c[i * 3 + 2] = 1.0 * t;
      } else if (kind === 2) { // 烟雾：灰白，随寿命变淡
        var g = 0.35 + 0.3 * t;
        c[i * 3] = g; c[i * 3 + 1] = g; c[i * 3 + 2] = g * 1.05;
        sys.vel[i * 3 + 1] += 1.5 * dt; // 热烟上升
        sys.vel[i * 3] *= (1 - 0.6 * dt); sys.vel[i * 3 + 2] *= (1 - 0.6 * dt);
      } else { // 分离火花
        c[i * 3] = 1.0 * t; c[i * 3 + 1] = 0.8 * t; c[i * 3 + 2] = 0.3 * t;
        sys.vel[i * 3 + 1] -= G * 0.4 * dt;
      }
    }
    sys.geo.attributes.position.needsUpdate = true;
    sys.geo.attributes.color.needsUpdate = true;
  }

  // ---------- 相机跟随 ----------
  var camPos = new THREE.Vector3(14, 5, 20);
  function stepCamera(dt) {
    var target = rocketRoot.position;
    var dist = 16 + Math.min(50, flight.h * 0.003);
    var desired = new THREE.Vector3(
      target.x + dist * 0.72, Math.max(3, target.y + 4 - Math.min(16, flight.h * 0.002)), target.z + dist
    );
    camPos.lerp(desired, 1 - Math.pow(0.001, dt));
    camera.position.copy(camPos);
    camera.lookAt(target.x, target.y + 3.5, target.z);
  }

  // ---------- HUD ----------
  var fpsEl = document.getElementById('fps');
  var teleEl = document.getElementById('telemetry');
  var frames = 0, fpsAccum = 0, fpsShown = 0;
  function stepHUD(dt) {
    frames++; fpsAccum += dt;
    if (fpsAccum >= 0.5) { fpsShown = Math.round(frames / fpsAccum); frames = 0; fpsAccum = 0; }
    fpsEl.textContent = 'FPS ' + fpsShown;
    var f = flight;
    var fuelPct = f.stage === 1 ? (f.fuel1 / STAGE1.fuel * 100) : (f.fuel2 / STAGE2.fuel * 100);
    teleEl.textContent =
      'T+' + f.t.toFixed(1) + ' s   第 ' + f.stage + ' 级' + (f.separated ? '（已分离）' : '') + '\n' +
      '高度 ' + (f.h / 1000).toFixed(2) + ' km   速度 ' + f.v.toFixed(0) + ' m/s\n' +
      '加速度 ' + f.accel.toFixed(1) + ' m/s²（峰值 ' + f.maxAccel.toFixed(1) + '）\n' +
      '剩余燃料 ' + fuelPct.toFixed(0) + '%   质量 ' + (currentMass() / 1000).toFixed(1) + ' t';
  }

  // ---------- 面板 ----------
  function bindSlider(id, key, fmt) {
    var el = document.getElementById(id), lab = document.getElementById('v-' + id);
    el.addEventListener('input', function () {
      params[key] = parseFloat(el.value);
      lab.textContent = fmt(params[key]);
    });
  }
  bindSlider('thrust', 'thrust', function (v) { return v.toFixed(2) + '×'; });
  bindSlider('particles', 'particles', function (v) { return String(Math.round(v)); });
  bindSlider('timescale', 'timescale', function (v) { return v.toFixed(2) + '×'; });
  document.getElementById('reset').addEventListener('click', resetFlight);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- 主循环 ----------
  resetFlight();
  var last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    var rawDt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var dt = rawDt * params.timescale;
    // 子步积分，保证高时间流速下物理稳定
    var steps = Math.max(1, Math.ceil(dt / 0.016));
    for (var i = 0; i < steps; i++) stepPhysics(dt / steps);
    stepParticles(dt);
    stepCamera(rawDt);
    stepHUD(rawDt);
    renderer.render(scene, camera);
  })(last);

  // 测试接口
  window.__rocket = {
    params: params,
    reset: resetFlight,
    state: function () {
      return { t: flight.t, h: flight.h, v: flight.v, accel: flight.accel, maxAccel: flight.maxAccel, stage: flight.stage, separated: flight.separated, fps: fpsShown };
    }
  };
})();