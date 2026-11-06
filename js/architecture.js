/* global AFRAME, THREE */

/**
 * Rotunda architecture: all textures are drawn in code on <canvas> at load
 * time (nothing to download), and lighting is "baked" into them so the
 * room itself needs no real-time lights, which keeps it fast on Quest.
 *
 *   arch-surface="type: wall|dome|floor|skylight|frieze|shaft; repeat: x y; side: front|back|double"
 *   arch-surface="...; lightmap: wall|floor|dome"   (adds the baked golden-hour light)
 *   pilasters="count: 12; radius: 10; height: 6"   (3 draw calls for all of them)
 *   sun-shaft="opacity: 0.3"                        (slanted sunbeam from the oculus)
 *
 * To change the time of day, edit MuseumLighting (sunAzimuth / sunElevation) below:
 * the sun patch, the beam, the bounce light and the pilaster shading all follow it.
 */
(() => {
  const textures = {}; // cached per type, shared by every surface using it

  // Small seeded random generator so the room looks the same on every load.
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')];
  }

  // Raised molding: light edge on top/left, shadow on bottom/right.
  function bevelRect(g, x, y, w, h, width = 3) {
    g.lineWidth = width;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.strokeRect(x - 1.5, y - 1.5, w, h);
    g.strokeStyle = 'rgba(70,55,40,0.3)';
    g.strokeRect(x + 1.5, y + 1.5, w, h);
  }

  function band(g, x, y, w, h, top, bottom) {
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, top);
    gr.addColorStop(1, bottom);
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  }

  function rosette(g, cx, cy, r, petals = 8) {
    g.save();
    g.translate(cx, cy);
    for (let pass = 0; pass < 2; pass++) {
      g.fillStyle = pass ? '#f3eee5' : 'rgba(70,55,40,0.35)';
      const off = pass ? 0 : r * 0.08;
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        g.beginPath();
        g.ellipse(Math.cos(a) * r * 0.55 + off, Math.sin(a) * r * 0.55 + off, r * 0.45, r * 0.2, a, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = '#d8cfbf';
    g.beginPath(); g.arc(0, 0, r * 0.25, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f6f2ea';
    g.beginPath(); g.arc(-r * 0.05, -r * 0.05, r * 0.14, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  // ---------------- wall: one bay between two pilasters (repeats around) ----------------
  // Soft natural-light gradient: bright under the dome, darker toward the floor.
  // With arch = true: the same bay with an arched opening cut through it (transparent pixels,
  // used with alphaTest) plus an archivolt molding and keystone, for the doorways to the galleries.
  const ARCH = { halfWidth: 1.8, springY: 2.8, molding: 0.3 }; // opening: 3.6 m wide, 4.6 m tall
  function drawWall(arch = false) {
    const W = 512, H = 1024, WALL_H = 6;
    const BAY_W = (2 * Math.PI * 10) / 12; // ~5.24 m of curved wall per bay
    const sx = W / BAY_W, sy = H / WALL_H;
    const [c, g] = canvas(W, H);
    const m = (y) => ((WALL_H - y) / WALL_H) * H; // metres above floor -> px

    const gr = g.createLinearGradient(0, 0, 0, H);
    // Even plaster colour; light and shadow come from the wall lightmap.
    gr.addColorStop(0, '#f4efe7');
    gr.addColorStop(1, '#ece5da');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);

    // Very faint plaster mottling.
    const r = rng(7);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '90,70,50'},0.025)`;
      g.beginPath();
      g.arc(r() * W, r() * H, 2 + r() * 10, 0, Math.PI * 2);
      g.fill();
    }

    // Upper panel with a medallion (above the hanging zone).
    if (!arch) {
    bevelRect(g, 44, m(5.55), W - 88, m(3.6) - m(5.55), 4);
    bevelRect(g, 64, m(5.55) + 20, W - 128, m(3.6) - m(5.55) - 40, 2);
    const mcx = W / 2, mcy = (m(5.55) + m(3.6)) / 2;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.beginPath(); g.ellipse(mcx - 1.5, mcy - 1.5, 70, 90, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(70,55,40,0.25)';
    g.beginPath(); g.ellipse(mcx + 1.5, mcy + 1.5, 70, 90, 0, 0, Math.PI * 2); g.stroke();
    rosette(g, mcx, mcy, 34, 10);
    }

    // String course separating the upper zone.
    band(g, 0, m(3.4), W, 12, '#fbf8f2', '#c9bfb0');

    // Dado rail, lower panel and skirting.
    band(g, 0, m(0.98), W, 12, '#f7f3ec', '#bfb4a4');
    if (!arch) bevelRect(g, 44, m(0.82), W - 88, m(0.24) - m(0.82), 3);
    band(g, 0, m(0.18), W, H - m(0.18), '#a89a86', '#857866');
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, m(0.18), W, 3);
    if (arch) {
      const cx = W / 2, cy = m(ARCH.springY);
      const rx = ARCH.halfWidth * sx, ry = ARCH.halfWidth * sy;
      const mx = ARCH.molding * sx, my = ARCH.molding * sy;
      // Archivolt: a raised band following the arch, then down the jambs.
      g.fillStyle = 'rgba(70,55,40,0.3)';
      g.beginPath(); g.ellipse(cx + 3, cy + 3, rx + mx, ry + my, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - rx - mx + 3, cy, mx, H - cy);
      g.fillRect(cx + rx + 3, cy, mx, H - cy);
      g.fillStyle = '#f7f3ec';
      g.beginPath(); g.ellipse(cx, cy, rx + mx, ry + my, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - rx - mx, cy, mx, H - cy);
      g.fillRect(cx + rx, cy, mx, H - cy);
      g.strokeStyle = 'rgba(70,55,40,0.3)';
      g.lineWidth = 2;
      g.beginPath(); g.ellipse(cx, cy, rx + mx * 0.55, ry + my * 0.55, 0, Math.PI, 0); g.stroke();
      // Impost blocks at the spring line.
      band(g, cx - rx - mx - 8, cy - 0.12 * sy, mx + 16, 0.2 * sy, '#fbf8f2', '#c9bfb0');
      band(g, cx + rx - 8, cy - 0.12 * sy, mx + 16, 0.2 * sy, '#fbf8f2', '#c9bfb0');
      // Keystone.
      const kTop = cy - ry - my * 1.5, kBot = cy - ry + 4;
      g.fillStyle = 'rgba(70,55,40,0.3)';
      g.beginPath(); g.moveTo(cx - 0.22 * sx + 3, kTop + 3); g.lineTo(cx + 0.22 * sx + 3, kTop + 3);
      g.lineTo(cx + 0.14 * sx + 3, kBot + 3); g.lineTo(cx - 0.14 * sx + 3, kBot + 3); g.closePath(); g.fill();
      g.fillStyle = '#fbf8f2';
      g.beginPath(); g.moveTo(cx - 0.22 * sx, kTop); g.lineTo(cx + 0.22 * sx, kTop);
      g.lineTo(cx + 0.14 * sx, kBot); g.lineTo(cx - 0.14 * sx, kBot); g.closePath(); g.fill();
      rosette(g, cx, (kTop + kBot) / 2, 12, 6);
      // Tablet above the arch.
      bevelRect(g, cx - 0.8 * sx, m(5.5), 1.6 * sx, 0.45 * sy, 3);
      rosette(g, cx, m(5.28), 16, 8);
      // Cut the opening (transparent: the material discards it with alphaTest).
      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      g.ellipse(cx, cy, rx, ry, 0, Math.PI, 0);
      g.lineTo(cx + rx, H + 2);
      g.lineTo(cx - rx, H + 2);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    return c;
  }

  // ---------------- dome: one column of coffers (repeats around) ----------------
  // Canvas top = the oculus edge, canvas bottom = the base of the dome.
  function drawDome() {
    const W = 256, H = 1024;
    const [c, g] = canvas(W, H);

    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#f5f1ea');
    gr.addColorStop(1, '#ebe5db');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);

    // Ornate ring around the oculus: hanging scallops + a row of beads.
    for (let i = 0; i < 2; i++) {
      const cx = 64 + i * 128;
      g.fillStyle = 'rgba(80,65,50,0.28)';
      g.beginPath(); g.arc(cx + 3, 18, 60, 0, Math.PI); g.fill();
      g.fillStyle = '#ebe5da';
      g.beginPath(); g.arc(cx, 14, 58, 0, Math.PI); g.fill();
      g.fillStyle = '#d4ccbe';
      g.beginPath(); g.arc(cx, 14, 40, 0, Math.PI); g.fill();
      rosette(g, cx, 34, 16, 6);
    }
    for (let x = 8; x < W; x += 16) {
      g.fillStyle = 'rgba(80,65,50,0.3)';
      g.beginPath(); g.arc(x + 1, 6, 4.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f8f5ef';
      g.beginPath(); g.arc(x, 5, 4, 0, Math.PI * 2); g.fill();
    }
    band(g, 0, 78, W, 10, '#fbf8f2', '#c7bdae');
    band(g, 0, 92, W, 6, '#fbf8f2', '#c7bdae');

    // Coffer rows (taller toward the base, like real domes).
    const RIB = 30, HRIB = 24;
    const rows = [0.15, 0.17, 0.19, 0.21].map((f) => f * H);
    let y = 104;
    rows.forEach((rh) => {
      const x0 = RIB / 2, w = W - RIB, h = rh - HRIB;
      // Stepped recess: each step darker and inset.
      const steps = ['#dcd4c7', '#cbc3b5', '#bab2a4', '#a8b1ba'];
      steps.forEach((col, s) => {
        const inset = s * (Math.min(w, h) * 0.09);
        g.fillStyle = col;
        g.fillRect(x0 + inset, y + inset, w - inset * 2, h - inset * 2);
        g.fillStyle = 'rgba(60,45,30,0.22)'; // shadow on the upper inner lip
        g.fillRect(x0 + inset, y + inset, w - inset * 2, 4);
        g.fillStyle = 'rgba(255,255,255,0.35)'; // light on the lower lip
        g.fillRect(x0 + inset, y + h - inset - 3, w - inset * 2, 3);
      });
      rosette(g, W / 2, y + h / 2, Math.min(w, h) * 0.2, 8);
      // Small rosettes where the ribs cross.
      rosette(g, 0, y + h + HRIB / 2, 9, 6);
      rosette(g, W, y + h + HRIB / 2, 9, 6);
      y += rh;
    });

    // Rib edges.
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(RIB / 2 - 3, 100, 3, y - 100);
    g.fillStyle = 'rgba(70,55,40,0.2)';
    g.fillRect(W - RIB / 2, 100, 3, y - 100);

    // Dentil frieze and base band.
    band(g, 0, y, W, 10, '#fbf8f2', '#c7bdae');
    y += 14;
    for (let x = 4; x < W; x += 16) {
      g.fillStyle = 'rgba(70,55,40,0.3)';
      g.fillRect(x + 2, y + 2, 9, 26);
      g.fillStyle = '#f1ece3';
      g.fillRect(x, y, 9, 26);
    }
    y += 34;
    band(g, 0, y, W, H - y, '#e4ddd1', '#cfc7b9');
    return c;
  }

  // ---------------- floor: light pine planks with inlaid rings and a star ----------------
  function drawFloor() {
    const S = 2048, ROOM = 20, ppm = S / ROOM; // pixels per metre
    const [c, g] = canvas(S, S);
    const r = rng(42);

    g.fillStyle = '#ddbb87';
    g.fillRect(0, 0, S, S);

    const pw = Math.round(0.16 * ppm);
    for (let y = 0; y < S; y += pw) {
      let x = -r() * 2 * ppm;
      while (x < S) {
        const len = (1.2 + r() * 1.4) * ppm;
        const l = 70 + r() * 8;
        g.fillStyle = `hsl(${33 + r() * 6}, ${52 + r() * 12}%, ${l}%)`;
        g.fillRect(x, y, len, pw);
        // Grain.
        for (let k = 0; k < 4; k++) {
          g.strokeStyle = `rgba(150,95,40,${0.08 + r() * 0.1})`;
          g.lineWidth = 0.8 + r();
          const gy = y + 2 + r() * (pw - 4);
          g.beginPath();
          g.moveTo(x, gy);
          g.bezierCurveTo(x + len * 0.3, gy + (r() - 0.5) * 6, x + len * 0.7, gy + (r() - 0.5) * 6, x + len, gy + (r() - 0.5) * 3);
          g.stroke();
        }
        if (r() < 0.06) { // the odd knot
          g.fillStyle = 'rgba(140,85,35,0.45)';
          g.beginPath();
          g.ellipse(x + r() * len, y + pw / 2, 4 + r() * 4, 2.5, 0, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = 'rgba(110,70,30,0.35)';
        g.fillRect(x + len - 1, y, 1.5, pw); // end joint
        x += len;
      }
      g.fillStyle = 'rgba(110,70,30,0.3)';
      g.fillRect(0, y, S, 1.2); // seam
    }

    const cx = S / 2, cy = S / 2;
    const ring = (r0, r1, col) => {
      g.fillStyle = col;
      g.beginPath();
      g.arc(cx, cy, r1 * ppm, 0, Math.PI * 2);
      g.arc(cx, cy, r0 * ppm, 0, Math.PI * 2, true);
      g.fill();
    };
    // Border inlay near the wall.
    ring(8.95, 9.02, '#f1dfba');
    ring(9.05, 9.35, '#9a673a');
    ring(9.38, 9.45, '#f1dfba');

    // Central compass star under the oculus.
    ring(2.3, 2.45, '#9a673a');
    ring(2.18, 2.24, '#f1dfba');
    const pts = 16, outer = 2.05 * ppm, inner = 0.75 * ppm;
    for (let i = 0; i < pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const len = i % 2 ? outer * 0.68 : outer;
      const da = Math.PI / pts;
      const tip = [cx + Math.cos(a) * len, cy + Math.sin(a) * len];
      const L = [cx + Math.cos(a - da) * inner * 0.6, cy + Math.sin(a - da) * inner * 0.6];
      const R = [cx + Math.cos(a + da) * inner * 0.6, cy + Math.sin(a + da) * inner * 0.6];
      [[L, '#f3e2bf'], [R, '#a8743f']].forEach(([side, col]) => {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(cx, cy); g.lineTo(side[0], side[1]); g.lineTo(tip[0], tip[1]);
        g.closePath(); g.fill();
      });
    }
    g.fillStyle = '#8c5d33';
    g.beginPath(); g.arc(cx, cy, 0.32 * ppm, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f3e2bf';
    g.beginPath(); g.arc(cx, cy, 0.18 * ppm, 0, Math.PI * 2); g.fill();

    return c;
  }

  // ---------------- skylight: glass with radial iron mullions ----------------
  function drawSkylight() {
    const S = 1024, c0 = S / 2, R = S / 2;
    const [c, g] = canvas(S, S);
    const sky = g.createRadialGradient(c0, c0, 0, c0, c0, R);
    sky.addColorStop(0, '#ffffff');
    sky.addColorStop(0.6, '#eef4f8');
    sky.addColorStop(1, '#cfdde8');
    g.fillStyle = sky;
    g.fillRect(0, 0, S, S);

    // Faint clouds.
    const r = rng(3);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.ellipse(r() * S, r() * S, 40 + r() * 90, 20 + r() * 40, r() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }

    g.strokeStyle = '#7b858e';
    g.lineCap = 'round';
    const spoke = (n, r0, r1, w) => {
      g.lineWidth = w;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        g.beginPath();
        g.moveTo(c0 + Math.cos(a) * r0 * R, c0 + Math.sin(a) * r0 * R);
        g.lineTo(c0 + Math.cos(a) * r1 * R, c0 + Math.sin(a) * r1 * R);
        g.stroke();
      }
    };
    const circle = (rad, w) => {
      g.lineWidth = w;
      g.beginPath(); g.arc(c0, c0, rad * R, 0, Math.PI * 2); g.stroke();
    };
    spoke(24, 0.07, 0.97, 6);
    spoke(24, 0.62, 0.97, 4); // offset by drawing again rotated below
    g.save(); g.translate(c0, c0); g.rotate(Math.PI / 24); g.translate(-c0, -c0);
    spoke(24, 0.62, 0.97, 4);
    g.restore();
    circle(0.33, 5);
    circle(0.62, 6);
    circle(0.97, 18);
    g.fillStyle = '#6c757d';
    g.beginPath(); g.arc(c0, c0, 0.07 * R, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#9aa3ab';
    g.beginPath(); g.arc(c0, c0, 0.035 * R, 0, Math.PI * 2); g.fill();
    return c;
  }

  // ---------------- cornice frieze: egg-and-dart ----------------
  function drawFrieze() {
    const W = 256, H = 64;
    const [c, g] = canvas(W, H);
    band(g, 0, 0, W, H, '#f3eee6', '#d9d1c4');
    band(g, 0, 0, W, 8, '#fbf8f2', '#cbc1b2');
    band(g, 0, H - 8, W, 8, '#fbf8f2', '#bfb4a4');
    for (let i = 0; i < 4; i++) {
      const x = 32 + i * 64;
      g.fillStyle = 'rgba(70,55,40,0.35)';
      g.beginPath(); g.ellipse(x + 2, 34, 18, 20, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f7f3ec';
      g.beginPath(); g.ellipse(x, 32, 16, 19, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d8cfc0';
      g.beginPath(); g.ellipse(x, 34, 10, 13, 0, 0, Math.PI * 2); g.fill();
      // dart
      g.fillStyle = 'rgba(70,55,40,0.4)';
      g.beginPath(); g.moveTo(x + 32, 12); g.lineTo(x + 36, 52); g.lineTo(x + 28, 52); g.closePath(); g.fill();
    }
    return c;
  }

  // ---------------- light shaft: fades from top to nothing (used with additive blending) ----------------
  function drawShaft() {
    const [c, g] = canvas(16, 256);
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#fff3d6');
    gr.addColorStop(0.5, '#6e6550');
    gr.addColorStop(1, '#000000');
    g.fillStyle = gr;
    g.fillRect(0, 0, 16, 256);
    return c;
  }

  // ---------------- pilaster flutes ----------------
  function drawFlutes() {
    const W = 128, H = 512;
    const [c, g] = canvas(W, H);
    const gr = g.createLinearGradient(0, 0, 0, H);
    // Pilasters have no lightmap, so their skylight gradient is painted in:
    // bright under the dome, deep warm shadow toward the floor.
    gr.addColorStop(0, '#fbf8f2');
    gr.addColorStop(0.5, '#e2d8c8');
    gr.addColorStop(1, '#9a8c78');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    band(g, 0, 0, W, 40, 'rgba(60,45,30,0.35)', 'rgba(60,45,30,0)'); // shadow under the capital
    for (let i = 0; i < 5; i++) {
      const x = 18 + i * 23;
      g.fillStyle = 'rgba(80,65,50,0.22)';
      g.fillRect(x, 14, 10, H - 28);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(x + 10, 14, 2, H - 28);
    }
    return c;
  }


  // =====================================================================
  // Baked lighting: late-afternoon "golden hour".
  //  - cool daylight from the skylight above (bright high, dark low)
  //  - a slanted sunbeam through the oculus landing on the north-east side
  //  - warm gallery lights washing down each wall bay
  //  - soft contact shadows (cornice, wall base, plinth, benches)
  // Each lightmap stores light in linear space at half scale, so values up to
  // 2x brightness fit (sunlit patches glow brighter than the plain texture).
  // =====================================================================
  const LIGHT = window.MuseumLighting = {
    sunAzimuth: 140,   // degrees around the room the sunlight travels toward (180 = north / straight ahead)
    sunElevation: 55,  // degrees above the horizon
    oculusY: 16.4,
    oculusR: 3.45,
    roomR: 10,
    wallH: 6,
    // Fixed things on the floor that get baked contact shadows. Exhibits and benches can move,
    // so they carry their own soft shadow instead (js/user-exhibits.js).
    blockers: []
  };

  const rad = THREE.MathUtils.degToRad;
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const mix = (a, b, t) => a + (b - a) * t;
  const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  const angDiff = (a, b) => { // smallest difference between two angles (radians)
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  const SKY_COOL = [0.93, 0.97, 1.06];
  const SKY_WARM = [1.0, 0.84, 0.66];  // warm bounce off the pine floor
  const SUN = [1.0, 0.8, 0.52];
  const LAMP = [1.0, 0.74, 0.46];

  function sunDir() { // direction the sunlight travels (pointing down into the room)
    const a = rad(LIGHT.sunAzimuth), e = rad(LIGHT.sunElevation);
    return new THREE.Vector3(Math.sin(a) * Math.cos(e), -Math.sin(e), Math.cos(a) * Math.cos(e));
  }

  // 0..1: how much direct sun reaches point P through the oculus.
  function sunlit(px, py, pz, d, softness = 1) {
    const t = (LIGHT.oculusY - py) / -d.y;
    const qx = px - d.x * t, qz = pz - d.z * t;
    const soft = (0.12 + t * 0.012) * softness; // penumbra widens with distance
    return smooth(LIGHT.oculusR + soft, LIGHT.oculusR - soft, Math.hypot(qx, qz));
  }

  // Where the centre of the sunbeam meets the wall (for bounce light).
  function sunPatch(d) {
    const h = Math.hypot(d.x, d.z);
    const t = LIGHT.roomR / h;
    return { x: d.x * t, y: LIGHT.oculusY + d.y * t, z: d.z * t, angle: Math.atan2(d.x, d.z) };
  }

  // Light arriving on the curved wall at angle theta (radians) and height y.
  function wallLight(theta, y, d, patch, opts = {}) {
    const R = LIGHT.roomR, H = LIGHT.wallH;
    const h = y / H;
    // Skylight: strong top-to-bottom falloff, cool above, warm below.
    let L = mix3(SKY_WARM, SKY_COOL, h).map((c) => c * mix(0.09, 0.95, Math.pow(h, 1.8)));

    // Bounce from the sunlit patch: the walls beside it and the wall facing it glow warm.
    const dp = angDiff(theta, patch.angle);
    const beside = Math.exp(-Math.pow(dp / 0.7, 2)) * 0.13;
    const facing = Math.max(0, -Math.cos(dp)) * 0.1;
    const bounce = (beside + facing) * mix(0.6, 1, 1 - h);
    L = L.map((c, i) => c + SUN[i] * bounce);

    // Warm gallery light washing down from the top of each bay (bay centres every 30 deg).
    if (!opts.skipLamps) {
      const bay = rad(30);
      const nearest = Math.round(theta / bay) * bay;
      const dx = R * angDiff(theta, nearest);
      const spread = 0.45 + Math.max(0, 5.7 - y) * 0.36;
      const lat = Math.exp(-Math.pow(dx / spread, 2));
      const vert = smooth(0.5, 2.0, y) * (1 - smooth(5.25, 5.75, y));
      const top = Math.exp(-Math.pow((y - 5.0) / 0.7, 2)) * 0.2; // soft glow just under the fixture
      const wash = lat * (vert * 0.42 + top);
      L = L.map((c, i) => c + LAMP[i] * wash);
    }

    // Direct sun.
    const px = Math.sin(theta) * (R - 0.02), pz = Math.cos(theta) * (R - 0.02);
    const nx = -Math.sin(theta), nz = -Math.cos(theta); // wall faces the centre
    const lambert = Math.max(0, -(nx * d.x + nz * d.z));
    // Diffused and gentler on the wall: wide soft edge, about half the floor's strength.
    const s = sunlit(px, y, pz, d, 9) * lambert;
    L = L.map((c, i) => c + SUN[i] * 0.85 * s);

    // Contact shadows: under the cornice, and along the floor.
    let occ = (1 - 0.5 * smooth(5.45, 6.0, y)) * mix(0.45, 1, smooth(0, 0.5, y));
    if (!opts.skipPilasterAO) {
      const pil = rad(15), step = rad(30);
      const toPil = Math.abs(R * angDiff(theta - pil, Math.round((theta - pil) / step) * step));
      occ *= mix(0.72, 1, smooth(0.25, 0.75, toPil));
    }
    // Soft shoulder: where lights overlap, highlights roll off instead of blowing out to white.
    const shoulder = (c) => (c <= 0.8 ? c : 0.8 + (c - 0.8) / (1 + (c - 0.8) * 1.5));
    return L.map((c) => shoulder(c * occ));
  }

  function floorLight(x, z, d, patch) {
    const R = LIGHT.roomR;
    const r = Math.hypot(x, z) / R;
    // Skylight pool under the oculus, falling off hard toward the walls.
    let L = mix3([1.0, 1.0, 1.02], SKY_WARM, smooth(0.15, 1, r))
      .map((c) => c * mix(0.95, 0.13, smooth(0.12, 1.0, r)));

    // Warm bounce in front of the sunlit wall.
    const db = Math.hypot(x - patch.x, z - patch.z);
    L = L.map((c, i) => c + SUN[i] * Math.exp(-Math.pow(db / 3.2, 2)) * 0.32);

    // Spill from the gallery lights at the foot of each bay.
    for (let k = 0; k < 12; k++) {
      const a = rad(k * 30);
      const ds = Math.hypot(x - Math.sin(a) * 9.7, z - Math.cos(a) * 9.7);
      const spill = Math.exp(-Math.pow(ds / 1.1, 2)) * 0.2;
      if (spill > 0.002) L = L.map((c, i) => c + LAMP[i] * spill);
    }

    // Direct sun.
    const s = sunlit(x, 0, z, d) * -d.y;
    L = L.map((c, i) => c + SUN[i] * 1.9 * s);

    // Contact shadows.
    let occ = mix(1, 0.5, smooth(9.0, 10, r * R));
    LIGHT.blockers.forEach((b) => {
      const qx = Math.max(Math.abs(x - b.x) - b.hx, 0);
      const qz = Math.max(Math.abs(z - b.z) - b.hz, 0);
      const dist = Math.hypot(qx, qz);
      occ *= 1 - b.strength * Math.exp(-dist / 0.28);
    });
    return L.map((c) => c * occ);
  }

  function domeLight(posAngle, vf, patch) {
    // vf: 0 at the oculus rim, 1 at the base of the dome.
    let L = mix3(SKY_COOL, [0.98, 0.88, 0.76], vf).map((c) => c * mix(1.15, 0.2, Math.pow(vf, 0.8)));
    const facing = Math.max(0, -Math.cos(angDiff(posAngle, patch.angle))); // side looking at the sun patch
    L = L.map((c, i) => c + SUN[i] * facing * 0.16 * vf);
    L = L.map((c) => c * mix(1, 0.7, smooth(0.88, 1, vf))); // shadow above the cornice
    return L;
  }

  // Write linear light (0..2) into an sRGB-encoded canvas for 8-bit precision in the shadows.
  function bake(W, H, fn) {
    const [c, g] = canvas(W, H);
    const img = g.createImageData(W, H);
    const r = rng(11);
    const enc = (v) => {
      v = Math.min(1, Math.max(0, v / 2));
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      return Math.min(255, Math.max(0, Math.round(s * 255 + (r() - 0.5)))); // tiny dither: no banding
    };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const L = fn(i, j);
        const o = (j * W + i) * 4;
        img.data[o] = enc(L[0]);
        img.data[o + 1] = enc(L[1]);
        img.data[o + 2] = enc(L[2]);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  const LIGHTMAPS = {
    // Cylinder UVs: u goes around starting at theta-start (15 deg), canvas top = top of the wall.
    wall() {
      const d = sunDir(), patch = sunPatch(d), W = 1024, H = 256;
      return bake(W, H, (i, j) => {
        const theta = rad(15) + ((i + 0.5) / W) * Math.PI * 2;
        const y = LIGHT.wallH * (1 - (j + 0.5) / H);
        return wallLight(theta, y, d, patch);
      });
    },
    // Circle UVs: canvas covers x and z from -10 to 10; canvas top = north (z = -10).
    floor() {
      const d = sunDir(), patch = sunPatch(d), S = 1024, R = LIGHT.roomR;
      return bake(S, S, (i, j) => {
        const x = ((i + 0.5) / S * 2 - 1) * R;
        const z = ((j + 0.5) / S * 2 - 1) * R;
        return floorLight(x, z, d, patch);
      });
    },
    // Sphere UVs: u = phi around, canvas top = oculus rim.
    dome() {
      const patch = sunPatch(sunDir()), W = 512, H = 128;
      return bake(W, H, (i, j) => {
        const phi = ((i + 0.5) / W) * Math.PI * 2;
        const posAngle = Math.atan2(-Math.cos(phi), Math.sin(phi));
        return domeLight(posAngle, (j + 0.5) / H, patch);
      });
    }
  };

  function lightmapTexture(c) {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.channel = 0; // use the surface's normal UVs (with its own, un-repeated transform)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  const lightmaps = {};
  function getLightmap(type) {
    if (!lightmaps[type]) lightmaps[type] = lightmapTexture(LIGHTMAPS[type]());
    return lightmaps[type];
  }

  const DRAW = {
    wall: () => drawWall(false), wallArch: () => drawWall(true), dome: drawDome, floor: drawFloor, skylight: drawSkylight,
    frieze: drawFrieze, shaft: drawShaft, flutes: drawFlutes
  };

  function getTexture(type, renderer) {
    if (!textures[type]) {
      const tex = new THREE.CanvasTexture(DRAW[type]());
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = Math.min(4, renderer ? renderer.capabilities.getMaxAnisotropy() : 1);
      textures[type] = tex;
    }
    return textures[type];
  }

  const SIDES = { front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide };

  AFRAME.registerComponent('arch-surface', {
    schema: {
      type: { default: 'wall' },
      repeat: { type: 'vec2', default: { x: 1, y: 1 } },
      side: { default: 'front' },
      opacity: { default: 1 },
      lightmap: { default: '' },     // wall | floor | dome: baked light layered over the texture
      tint: { type: 'color', default: '#ffffff' }
    },
    init() {
      const apply = () => {
        const mesh = this.el.getObject3D('mesh');
        if (!mesh) return;
        const d = this.data;
        // Clone so each surface can have its own repeat while sharing the image.
        const tex = getTexture(d.type, this.el.sceneEl.renderer).clone();
        tex.needsUpdate = true;
        tex.repeat.set(d.repeat.x, d.repeat.y);
        const opts = { map: tex, side: SIDES[d.side] || THREE.FrontSide, color: new THREE.Color(d.tint) };
        if (d.lightmap) {
          opts.lightMap = getLightmap(d.lightmap);
          opts.lightMapIntensity = 2 * Math.PI; // undo the half-scale storage (three.js divides by PI)
        }
        if (d.type === 'shaft') {
          Object.assign(opts, {
            transparent: true, opacity: d.opacity, blending: THREE.AdditiveBlending, depthWrite: false
          });
        }
        mesh.material = new THREE.MeshBasicMaterial(opts); // baked lighting: no light cost
      };
      if (this.el.hasLoaded) apply(); else this.el.addEventListener('loaded', apply, { once: true });
    }
  });

  // All pilasters as 3 instanced meshes (shaft, capital, base) = 3 draw calls.
  AFRAME.registerComponent('pilasters', {
    schema: {
      count: { default: 12 },
      radius: { default: 10 },
      height: { default: 6 },
      offset: { default: 15 },  // degrees; pilasters sit between the wall bays
      width: { default: 0.5 },
      depth: { default: 0.14 }
    },
    init() {
      const d = this.data;
      const flutes = getTexture('flutes', this.el.sceneEl.renderer);
      const parts = [
        { w: d.width, h: d.height - 0.7, dd: d.depth, y: 0.35 + (d.height - 0.7) / 2, map: flutes },
        { w: d.width + 0.2, h: 0.35, dd: d.depth + 0.1, y: d.height - 0.175, color: '#f4efe7' },
        { w: d.width + 0.14, h: 0.35, dd: d.depth + 0.08, y: 0.175, color: '#b9ad9b' }
      ];
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const one = new THREE.Vector3(1, 1, 1);
      const pos = new THREE.Vector3();
      parts.forEach((p) => {
        // Baked like the walls (unlit), so the pilasters match the wall's soft light.
        const mat = new THREE.MeshBasicMaterial(p.map ? { map: p.map } : { color: p.color });
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(p.w, p.h, p.dd), mat, d.count);
        for (let i = 0; i < d.count; i++) {
          const a = THREE.MathUtils.degToRad(d.offset + (i * 360) / d.count);
          const r = d.radius - p.dd / 2;
          pos.set(Math.sin(a) * r, p.y, Math.cos(a) * r);
          q.setFromEuler(e.set(0, a + Math.PI, 0));
          mesh.setMatrixAt(i, m.compose(pos, q, one));
        }
        // Tint each pilaster by the light reaching its spot on the wall (sun, bounce, skylight).
        const dSun = sunDir(), patch = sunPatch(dSun), col = new THREE.Color();
        for (let i = 0; i < d.count; i++) {
          const a = THREE.MathUtils.degToRad(d.offset + (i * 360) / d.count);
          const L = wallLight(a, 3.2, dSun, patch, { skipLamps: true, skipPilasterAO: true });
          const k = 1.25; // the flute texture already darkens toward the floor
          mesh.setColorAt(i, col.setRGB(Math.min(1.6, L[0] * k), Math.min(1.6, L[1] * k), Math.min(1.6, L[2] * k)));
        }
        mesh.frustumCulled = false; // instances span the whole room
        this.el.object3D.add(mesh);
      });
    }
  });
  // Slanted beam of sunlight from the oculus, matching the baked sun patch.
  // It's an oblique cylinder: its top ring is the oculus and every ring is shifted along the sun direction.
  AFRAME.registerComponent('sun-shaft', {
    schema: { opacity: { default: 0.3 }, color: { type: 'color', default: '#ffd9a0' } },
    init() {
      const d = sunDir();
      const length = LIGHT.oculusY / -d.y; // until it reaches floor level (the wall hides the rest)
      const geo = new THREE.CylinderGeometry(LIGHT.oculusR, LIGHT.oculusR, 1, 48, 8, true);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const along = 0.5 - pos.getY(i); // 0 at the top ring, 1 at the bottom ring
        pos.setXYZ(i,
          pos.getX(i) + d.x * length * along,
          LIGHT.oculusY + d.y * length * along,
          pos.getZ(i) + d.z * length * along);
      }
      geo.computeBoundingSphere();
      geo.computeVertexNormals();
      // Glow is strongest where you look straight through the beam and fades at its
      // silhouette edges and toward the floor, so it reads as soft hazy light.
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          color: { value: new THREE.Color(this.data.color) },
          opacity: { value: this.data.opacity }
        },
        vertexShader: `
          varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform vec3 color; uniform float opacity;
          varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main() {
            float facing = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
            float fade = smoothstep(0.0, 0.85, vUv.y);
            gl_FragColor = vec4(color * facing * fade * opacity, 1.0);
          }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      this.el.setObject3D('mesh', new THREE.Mesh(geo, mat));
    }
  });
  // Shared with js/rooms.js (gallery rooms and the rotunda's arched wall).
  window.MuseumArch = {
    canvas, band, bevelRect, rosette, rng, smooth, mix, mix3, angDiff, rad, sunDir, sunlit,
    getTexture, getLightmap, lightmapTexture, bake, wallLight,
    LIGHT, ARCH, SIDES, DRAW, SKY_COOL, SKY_WARM, SUN, LAMP
  };
})();
