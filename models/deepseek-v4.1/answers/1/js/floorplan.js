/**
 * floorplan.js — SVG 平面图解析（浏览器 / node 通用）
 * 单位：SVG 100 units = 1 m。全部几何按墙体中心线计算。
 * 不依赖任何第三方库：自带极简 XML 读取，浏览器用 DOMParser，node 用正则兜底。
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function parseAttrs(str) {
    var out = {}, re = /([\w:-]+)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(str))) out[m[1]] = m[2];
    return out;
  }

  /* 从 SVG 文本中提取 class 为 wall / door / window 的 line，以及 <text> 内容 */
  function parseText(svgText) {
    var items = { wall: [], door: [], window: [], label: [] };

    var lineRe = /<line\b([^>]*?)\/?>/g, m;
    while ((m = lineRe.exec(svgText))) {
      var a = parseAttrs(m[1]);
      var cls = (a['class'] || '').trim();
      if (!cls) continue;
      var seg = {
        x1: parseFloat(a.x1), y1: parseFloat(a.y1),
        x2: parseFloat(a.x2), y2: parseFloat(a.y2)
      };
      if (!isFinite(seg.x1) || !isFinite(seg.y2)) continue;
      if (cls === 'wall') items.wall.push(seg);
      else if (cls === 'door') items.door.push(seg);
      else if (cls === 'window') items.window.push(seg);
    }

    var textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    while ((m = textRe.exec(svgText))) {
      var ta = parseAttrs(m[1]);
      var body = m[2].replace(/<[^>]*>/g, '').trim();
      if (!body || !ta.x) continue;
      items.label.push({ x: parseFloat(ta.x), y: parseFloat(ta.y), text: body });
    }
    return items;
  }

  /* 浏览器：优先用 DOMParser（严格按 class 取值），失败再退回正则 */
  function parseDom(svgText) {
    if (typeof DOMParser === 'undefined') return null;
    try {
      var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      if (doc.querySelector('parsererror')) return null;
      var items = { wall: [], door: [], window: [], label: [] };
      ['wall', 'door', 'window'].forEach(function (cls) {
        doc.querySelectorAll('line.' + cls).forEach(function (el) {
          items[cls].push({
            x1: +el.getAttribute('x1'), y1: +el.getAttribute('y1'),
            x2: +el.getAttribute('x2'), y2: +el.getAttribute('y2')
          });
        });
      });
      doc.querySelectorAll('text').forEach(function (el) {
        var t = (el.textContent || '').trim();
        if (!t) return;
        items.label.push({ x: +el.getAttribute('x'), y: +el.getAttribute('y'), text: t });
      });
      return items.wall.length ? items : null;
    } catch (e) { return null; }
  }

  /* 墙体沿轴向与门洞求差，返回去掉门洞后的若干段（门洞处必须没有墙） */
  function subtractDoors(wall, doors) {
    var dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    var len = Math.hypot(dx, dy);
    if (len < 1e-6) return [];
    var ux = dx / len, uy = dy / len;
    var horizontal = Math.abs(dy) < 1e-6;

    var cuts = [];
    for (var i = 0; i < doors.length; i++) {
      var d = doors[i];
      var dHorizontal = Math.abs(d.y2 - d.y1) < 1e-6;
      if (dHorizontal !== horizontal) continue;
      // 法向距离：门必须贴在这道墙的中心线上
      var perp = horizontal ? Math.abs(d.y1 - wall.y1) : Math.abs(d.x1 - wall.x1);
      if (perp > 2) continue;
      var t1 = (d.x1 - wall.x1) * ux + (d.y1 - wall.y1) * uy;
      var t2 = (d.x2 - wall.x1) * ux + (d.y2 - wall.y1) * uy;
      var a = Math.max(0, Math.min(t1, t2));
      var b = Math.min(len, Math.max(t1, t2));
      if (b > a) cuts.push([a, b]);
    }
    if (!cuts.length) return [wall];

    cuts.sort(function (p, q) { return p[0] - q[0]; });
    var segs = [], cursor = 0;
    for (var k = 0; k < cuts.length; k++) {
      if (cuts[k][0] > cursor + 0.5) {
        segs.push(makeSeg(wall, ux, uy, cursor, cuts[k][0]));
      }
      cursor = Math.max(cursor, cuts[k][1]);
    }
    if (cursor < len - 0.5) segs.push(makeSeg(wall, ux, uy, cursor, len));
    return segs;
  }

  function makeSeg(wall, ux, uy, a, b) {
    return {
      x1: wall.x1 + ux * a, y1: wall.y1 + uy * a,
      x2: wall.x1 + ux * b, y2: wall.y1 + uy * b
    };
  }

  /**
   * 解析平面图。返回的坐标已经换算成米，并以图纸包围盒中心为原点。
   * origin: 'svg'（x 向右、y 向下 → world x 向右、z 向前）
   */
  function parse(svgText, opts) {
    opts = opts || {};
    var unitsPerMeter = opts.unitsPerMeter || 100;
    var raw = (typeof DOMParser !== 'undefined' ? parseDom(svgText) : null) || parseText(svgText);
    if (!raw || !raw.wall.length) throw new Error('图纸里没有找到 class="wall" 的墙线');

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    raw.wall.forEach(function (w) {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });

    var scale = 1 / unitsPerMeter;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    function toWorld(x, y) { return { x: (x - cx) * scale, z: (y - cy) * scale }; }

    var walls = [];
    raw.wall.forEach(function (w) {
      subtractDoors(w, raw.door).forEach(function (s) {
        var p1 = toWorld(s.x1, s.y1), p2 = toWorld(s.x2, s.y2);
        walls.push({
          x1: p1.x, z1: p1.z, x2: p2.x, z2: p2.z,
          length: Math.hypot(p2.x - p1.x, p2.z - p1.z),
          angle: Math.atan2(p2.z - p1.z, p2.x - p1.x)
        });
      });
    });

    var windows = raw.window.map(function (w) {
      var p1 = toWorld(w.x1, w.y1), p2 = toWorld(w.x2, w.y2);
      return {
        x1: p1.x, z1: p1.z, x2: p2.x, z2: p2.z,
        cx: (p1.x + p2.x) / 2, cz: (p1.z + p2.z) / 2,
        length: Math.hypot(p2.x - p1.x, p2.z - p1.z),
        angle: Math.atan2(p2.z - p1.z, p2.x - p1.x)
      };
    });

    var doors = raw.door.map(function (d) {
      var p1 = toWorld(d.x1, d.y1), p2 = toWorld(d.x2, d.y2);
      return {
        cx: (p1.x + p2.x) / 2, cz: (p1.z + p2.z) / 2,
        length: Math.hypot(p2.x - p1.x, p2.z - p1.z),
        angle: Math.atan2(p2.z - p1.z, p2.x - p1.x)
      };
    });

    var labels = raw.label.map(function (l) {
      var p = toWorld(l.x, l.y);
      return { x: p.x, z: p.z, text: l.text, isNote: /unit|envelope|m\s*x\s*m/i.test(l.text) };
    });

    return {
      unitsPerMeter: unitsPerMeter,
      width: (maxX - minX) * scale,
      depth: (maxY - minY) * scale,
      bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY },
      walls: walls,
      windows: windows,
      doors: doors,
      labels: labels,
      svgText: svgText
    };
  }

  var API = { parse: parse, parseText: parseText, subtractDoors: subtractDoors };

  if (typeof module === 'object' && module.exports) module.exports = API;
  else global.FloorPlan = API;
})(typeof self !== 'undefined' ? self : this);
