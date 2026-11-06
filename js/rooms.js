/* global AFRAME, THREE */

/**
 * Gallery rooms off the rotunda.
 *
 *   rotunda-walls="arches: 90, 150, 210, 270"   the rotunda's curved wall, with arched
 *                                               openings in those bays (angles in degrees:
 *                                               180 = north / straight ahead from the start)
 *   gallery-room="angle: 90"                     a long barrel-vaulted gallery behind that arch
 *
 * Rooms follow the photo you shared: slate-blue walls for hanging, a white cornice, a white
 * attic with arched clerestory windows in every bay, and a white barrel vault with ribs.
 * A big half-moon (lunette) window fills the far end.
 *
 * Lighting is baked like the rotunda's (no real-time lights): cool daylight from the windows,
 * a bright plaster vault, deep shadow low on the walls, warm gallery lamps washing each bay,
 * and the same afternoon sun as the rotunda shining in through whichever windows face it,
 * with the window bars casting shadows.
 */
(() => {
  const A = window.MuseumArch;
  const { canvas, band, bevelRect, rosette, rng, smooth, mix, angDiff, rad } = A;

  const ROOM = {
    width: 11,
    length: 22,
    near: 11,          // distance from the rotunda centre to the room's entrance wall
    springY: 8.8,      // where the vault starts
    blueTop: 6.2,      // top of the blue hanging wall
    corniceTop: 6.8,
    bays: 5,
    win: { halfWidth: 0.85, sill: 6.95, springY: 7.9 }, // clerestory windows (one per bay, both sides)
    lunette: 3.2       // radius of the half-moon window in the far end
  };
  const W2 = ROOM.width / 2;
  const FAR = ROOM.near + ROOM.length;
  const BAY = ROOM.length / ROOM.bays;
  const VR = W2; // vault radius
  const ARCH = A.ARCH;
  const ROT_R = A.LIGHT.roomR;

  // Walkable areas, read by the bounds component (js/components.js).
  const layout = window.MuseumLayout = window.MuseumLayout || { rotundaR: 9.2, rooms: [] };

  // =====================================================================
  // Textures (detail; light comes from the lightmaps further down)
  // =====================================================================

  // Blue wall, picture rail, skirting, cornice and white attic: shared by side and end walls.
  // sx / sy: pixels per metre.
  function paintZones(g, W, H, sx, sy) {
    const m = (y) => (ROOM.springY - y) * sy;
    // White attic.
    band(g, 0, 0, W, m(ROOM.corniceTop), '#f6f2eb', '#ece6dc');
    // Cornice: cyma, dentils, architrave.
    band(g, 0, m(6.8), W, 0.18 * sy, '#fdfaf5', '#d8cfc1');
    band(g, 0, m(6.62), W, 0.24 * sy, '#efe9df', '#e3dccf');
    for (let x = 3; x < W; x += Math.max(8, 0.12 * sx)) {
      g.fillStyle = 'rgba(70,55,40,0.28)';
      g.fillRect(x + 2, m(6.6) + 2, 0.06 * sx, 0.17 * sy);
      g.fillStyle = '#faf6ef';
      g.fillRect(x, m(6.6), 0.06 * sx, 0.17 * sy);
    }
    band(g, 0, m(6.38), W, 0.18 * sy, '#f5f0e8', '#d4cbbd');
    // Slate-blue hanging wall with a faint woven texture.
    band(g, 0, m(ROOM.blueTop), W, H - m(ROOM.blueTop), '#5e6e8a', '#55647e');
    const r = rng(23);
    for (let i = 0; i < W * 3; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '10,20,40'},0.035)`;
      g.fillRect(r() * W, m(ROOM.blueTop) + r() * (H - m(ROOM.blueTop)), 1, 6 + r() * 30);
    }
    // Picture rail and skirting.
    band(g, 0, m(5.95), W, 0.05 * sy, '#f1ece3', '#bdb3a5');
    band(g, 0, m(0.24), W, 0.24 * sy, '#e4ddd1', '#c2b8a9');
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(0, m(0.24), W, 2);
  }

  // Window outline: rectangle up to the spring line + half circle. (dz, y) in metres.
  function windowPath(g, cx, m, sx, sy, grow = 0) {
    const w = ROOM.win;
    const hw = w.halfWidth + grow;
    g.beginPath();
    g.moveTo(cx - hw * sx, m(w.sill - grow));
    g.lineTo(cx - hw * sx, m(w.springY));
    g.ellipse(cx, m(w.springY), hw * sx, hw * sy, 0, Math.PI, 0);
    g.lineTo(cx + hw * sx, m(w.sill - grow));
    g.closePath();
  }

  function paintWindow(g, cx, m, sx, sy) {
    const w = ROOM.win;
    // Frame molding.
    g.fillStyle = 'rgba(70,55,40,0.3)';
    g.save(); g.translate(3, 3); windowPath(g, cx, m, sx, sy, 0.12); g.fill(); g.restore();
    g.fillStyle = '#fbf8f2';
    windowPath(g, cx, m, sx, sy, 0.12); g.fill();
    // Glass: pale sky.
    const gr = g.createLinearGradient(0, m(w.springY + w.halfWidth), 0, m(w.sill));
    gr.addColorStop(0, '#f4f8fb');
    gr.addColorStop(1, '#cfdeea');
    g.fillStyle = gr;
    windowPath(g, cx, m, sx, sy); g.fill();
    // Glazing bars.
    g.strokeStyle = '#8a929a';
    g.lineWidth = Math.max(2, 0.04 * sx);
    g.lineCap = 'round';
    const hw = w.halfWidth;
    [-hw / 3, hw / 3].forEach((dx) => {
      g.beginPath(); g.moveTo(cx + dx * sx, m(w.sill)); g.lineTo(cx + dx * sx, m(w.springY)); g.stroke();
    });
    const midY = (w.sill + w.springY) / 2;
    g.beginPath(); g.moveTo(cx - hw * sx, m(midY)); g.lineTo(cx + hw * sx, m(midY)); g.stroke();
    g.beginPath(); g.moveTo(cx - hw * sx, m(w.springY)); g.lineTo(cx + hw * sx, m(w.springY)); g.stroke();
    [45, 90, 135].forEach((deg) => {
      const a = rad(deg);
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * hw * 0.35 * sx, m(w.springY + Math.sin(a) * hw * 0.35));
      g.lineTo(cx - Math.cos(a) * hw * sx, m(w.springY + Math.sin(a) * hw));
      g.stroke();
    });
    g.beginPath(); g.ellipse(cx, m(w.springY), hw * 0.35 * sx, hw * 0.35 * sy, 0, Math.PI, 0); g.stroke();
    g.lineWidth = Math.max(3, 0.06 * sx);
    windowPath(g, cx, m, sx, sy); g.stroke();
  }

  // One bay of a long side wall: 4.4 m x 8.8 m, repeats along the room.
  function drawRoomWall() {
    const W = 512, H = 1024, sx = W / BAY, sy = H / ROOM.springY;
    const [c, g] = canvas(W, H);
    const m = (y) => (ROOM.springY - y) * sy;
    paintZones(g, W, H, sx, sy);
    // Attic panels either side of the window, and pilaster strips at the bay edges.
    const cx = W / 2;
    const hwPx = (ROOM.win.halfWidth + 0.35) * sx;
    bevelRect(g, 0.35 * sx, m(8.55), cx - hwPx - 0.35 * sx, m(7.05) - m(8.55), 3);
    bevelRect(g, cx + hwPx, m(8.55), cx - hwPx - 0.35 * sx, m(7.05) - m(8.55), 3);
    band(g, 0, m(ROOM.springY), 0.14 * sx, m(ROOM.corniceTop) - m(ROOM.springY), '#fdfaf5', '#e6dfd3');
    band(g, W - 0.14 * sx, m(ROOM.springY), 0.14 * sx, m(ROOM.corniceTop) - m(ROOM.springY), '#fdfaf5', '#e6dfd3');
    paintWindow(g, cx, m, sx, sy);
    return c;
  }

  // End walls: 11 m x 8.8 m. The entrance one has the arched opening cut out.
  function drawRoomEnd(entry) {
    const W = 1024, H = Math.round(1024 * ROOM.springY / ROOM.width);
    const sx = W / ROOM.width, sy = H / ROOM.springY;
    const [c, g] = canvas(W, H);
    const m = (y) => (ROOM.springY - y) * sy;
    paintZones(g, W, H, sx, sy);
    for (let i = 0; i < 3; i++) {
      const x0 = (0.5 + i * 3.4) * sx;
      bevelRect(g, x0, m(8.55), 3.0 * sx, m(7.05) - m(8.55), 3);
      rosette(g, x0 + 1.5 * sx, (m(8.55) + m(7.05)) / 2, 18, 8);
    }
    if (entry) {
      const cx = W / 2, cy = m(ARCH.springY);
      const rx = ARCH.halfWidth * sx, ry = ARCH.halfWidth * sy;
      const mx = ARCH.molding * sx, my = ARCH.molding * sy;
      g.fillStyle = 'rgba(20,25,40,0.35)';
      g.beginPath(); g.ellipse(cx + 3, cy + 3, rx + mx, ry + my, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - rx - mx + 3, cy, mx, H - cy);
      g.fillRect(cx + rx + 3, cy, mx, H - cy);
      g.fillStyle = '#f5f0e8';
      g.beginPath(); g.ellipse(cx, cy, rx + mx, ry + my, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - rx - mx, cy, mx, H - cy);
      g.fillRect(cx + rx, cy, mx, H - cy);
      g.strokeStyle = 'rgba(70,55,40,0.3)';
      g.lineWidth = 2;
      g.beginPath(); g.ellipse(cx, cy, rx + mx * 0.55, ry + my * 0.55, 0, Math.PI, 0); g.stroke();
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

  // Half-disc end of the vault. Canvas covers x -5.5..5.5, y 0..5.5 above the spring line.
  function drawTympanum(far) {
    const W = 1024, H = 512, s = W / ROOM.width;
    const [c, g] = canvas(W, H);
    const px = (x) => (x + W2) * s, py = (y) => (VR - y) * s;
    band(g, 0, 0, W, H, '#f7f3ec', '#ece6dc');
    const ring = (r0, r1, col) => {
      g.fillStyle = col;
      g.beginPath();
      g.arc(px(0), py(0), r1 * s, Math.PI, 0);
      g.arc(px(0), py(0), r0 * s, 0, Math.PI, true);
      g.closePath();
      g.fill();
    };
    ring(VR - 0.4, VR, '#fbf8f2');
    ring(VR - 0.42, VR - 0.38, 'rgba(70,55,40,0.3)');
    if (far) {
      const L = ROOM.lunette;
      ring(L, L + 0.28, '#fdfaf5');
      ring(L + 0.28, L + 0.32, 'rgba(70,55,40,0.3)');
      const gr = g.createLinearGradient(0, py(L), 0, py(0));
      gr.addColorStop(0, '#f4f8fb');
      gr.addColorStop(1, '#cfdeea');
      g.fillStyle = gr;
      g.beginPath(); g.arc(px(0), py(0), L * s, Math.PI, 0); g.closePath(); g.fill();
      g.strokeStyle = '#8a929a';
      g.lineWidth = 5;
      for (let deg = 30; deg <= 150; deg += 30) {
        const a = rad(deg);
        g.beginPath();
        g.moveTo(px(-Math.cos(a) * 0.5), py(Math.sin(a) * 0.5));
        g.lineTo(px(-Math.cos(a) * L), py(Math.sin(a) * L));
        g.stroke();
      }
      g.beginPath(); g.arc(px(0), py(0), 1.5 * s, Math.PI, 0); g.stroke();
      g.beginPath(); g.arc(px(0), py(0), 0.5 * s, Math.PI, 0); g.stroke();
      g.lineWidth = 8;
      g.beginPath(); g.moveTo(px(-L), py(0.02)); g.lineTo(px(L), py(0.02)); g.stroke();
    } else {
      ring(2.2, 2.4, '#fbf8f2');
      rosette(g, px(0), py(1.1), 60, 10);
    }
    return c;
  }

  // One bay of the barrel vault: u runs across the arch (spring to spring), v along one bay.
  function drawVault() {
    const W = 512, H = 256;
    const [c, g] = canvas(W, H);
    band(g, 0, 0, W, H, '#f7f4ee', '#f1ece4');
    // Transverse ribs at the bay boundaries (half at each edge so the tile repeats).
    const rib = 18;
    band(g, 0, 0, W, rib, '#e6dfd3', '#fdfaf5');
    band(g, 0, H - rib, W, rib, '#fdfaf5', '#e6dfd3');
    for (let x = 6; x < W; x += 16) {
      g.fillStyle = 'rgba(70,55,40,0.18)';
      g.beginPath(); g.arc(x, rib + 4, 3, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(x, H - rib - 4, 3, 0, Math.PI * 2); g.fill();
    }
    // Sunken panel with rosettes, framed by bands near the springs.
    bevelRect(g, W * 0.16, H * 0.2, W * 0.68, H * 0.6, 4);
    bevelRect(g, W * 0.19, H * 0.27, W * 0.62, H * 0.46, 2);
    rosette(g, W / 2, H / 2, 26, 10);
    [[0.16, 0.2], [0.84, 0.2], [0.16, 0.8], [0.84, 0.8]].forEach(([u, v]) => rosette(g, W * u, H * v, 9, 6));
    band(g, 0, 0, 22, H, '#fdfaf5', '#e3dccf');
    band(g, W - 22, 0, 22, H, '#e3dccf', '#fdfaf5');
    return c;
  }

  // Seamless 4 m x 4 m tile of light pine planks running along the room.
  function drawPlanks() {
    const S = 1024, ppm = S / 4;
    const [c, g] = canvas(S, S);
    const r = rng(77);
    g.fillStyle = '#ddbb87';
    g.fillRect(0, 0, S, S);
    g.save();
    g.translate(S, 0);
    g.rotate(Math.PI / 2); // draw rows along x; they land as columns along the room
    const pw = S / 25;
    for (let y = 0; y < S; y += pw) {
      let x = -r() * 2 * ppm;
      while (x < S) {
        const len = (1.2 + r() * 1.4) * ppm;
        const col = `hsl(${33 + r() * 6}, ${52 + r() * 12}%, ${70 + r() * 8}%)`;
        const grains = Array.from({ length: 4 }, () => [2 + r() * (pw - 4), (r() - 0.5) * 6, (r() - 0.5) * 6, 0.08 + r() * 0.1]);
        const knot = r() < 0.06 ? [r() * len, 4 + r() * 4] : null;
        for (const off of [0, -S]) { // draw again shifted so planks wrap seamlessly
          const px = x + off;
          if (px > S || px + len < 0) continue;
          g.fillStyle = col;
          g.fillRect(px, y, len, pw);
          grains.forEach(([gy, a, b, alpha]) => {
            g.strokeStyle = `rgba(150,95,40,${alpha})`;
            g.lineWidth = 1.2;
            g.beginPath();
            g.moveTo(px, y + gy);
            g.bezierCurveTo(px + len * 0.3, y + gy + a, px + len * 0.7, y + gy + b, px + len, y + gy);
            g.stroke();
          });
          if (knot) {
            g.fillStyle = 'rgba(140,85,35,0.45)';
            g.beginPath(); g.ellipse(px + knot[0], y + pw / 2, knot[1], 3, 0, 0, Math.PI * 2); g.fill();
          }
          g.fillStyle = 'rgba(110,70,30,0.35)';
          g.fillRect(px + len - 1, y, 1.5, pw);
        }
        x += len;
      }
      g.fillStyle = 'rgba(110,70,30,0.3)';
      g.fillRect(0, y, S, 1.2);
    }
    g.restore();
    return c;
  }

  Object.assign(A.DRAW, {
    roomWall: drawRoomWall,
    roomEnd: () => drawRoomEnd(false),
    roomEntry: () => drawRoomEnd(true),
    tympanumFar: () => drawTympanum(true),
    tympanumNear: () => drawTympanum(false),
    roomVault: drawVault,
    planks: drawPlanks
  });

  // =====================================================================
  // Baked lighting for one room (depends on which way the room faces the sun)
  // =====================================================================
  function roomLighting(angleDeg) {
    const a = rad(angleDeg);
    const dw = A.sunDir();
    // Sun direction in the room's own frame (room runs along +z, x across).
    const d = [dw.x * Math.cos(a) - dw.z * Math.sin(a), dw.y, dw.x * Math.sin(a) + dw.z * Math.cos(a)];
    const toSun = [-d[0], -d[1], -d[2]];
    const w = ROOM.win;

    // Light sources: every clerestory window, the far lunette, and the bright arch to the rotunda.
    const winArea = 2 * w.halfWidth * (w.springY - w.sill) + Math.PI * w.halfWidth * w.halfWidth / 2;
    const sources = [];
    [-1, 1].forEach((side) => {
      for (let k = 0; k < ROOM.bays; k++) {
        sources.push({ c: [side * W2, (w.sill + w.springY) / 2 + 0.25, ROOM.near + (k + 0.5) * BAY], n: [-side, 0, 0], A: winArea, k: 1 });
      }
    });
    sources.push({ c: [0, ROOM.springY + 4 * ROOM.lunette / (3 * Math.PI), FAR], n: [0, 0, -1], A: Math.PI * ROOM.lunette ** 2 / 2, k: 1 });
    sources.push({ c: [0, 2.4, ROOM.near], n: [0, 0, 1], A: 3.6 * 2.8 + Math.PI * 1.8 * 1.8 / 2, k: 0.25 });
    const SKY = 13; // brightness of the sky seen through the windows

    function daylight(P, n) {
      let e = 0;
      for (const s of sources) {
        const vx = s.c[0] - P[0], vy = s.c[1] - P[1], vz = s.c[2] - P[2];
        const d2 = Math.max(1.2, vx * vx + vy * vy + vz * vz);
        const dist = Math.sqrt(d2);
        const cosP = (n[0] * vx + n[1] * vy + n[2] * vz) / dist;
        const cosW = -(s.n[0] * vx + s.n[1] * vy + s.n[2] * vz) / dist;
        if (cosP <= 0 || cosW <= 0) continue;
        e += s.k * s.A * cosP * cosW / (Math.PI * d2);
      }
      return e * SKY;
    }

    // Signed distance to a window outline (negative inside). dz across, y up.
    function windowSD(dz, y) {
      if (y > w.springY) return Math.hypot(dz, y - w.springY) - w.halfWidth;
      return Math.max(Math.abs(dz) - w.halfWidth, w.sill - y);
    }
    // Shadow of the glazing bars (1 = no bar).
    function bars(dz, y) {
      const t = 0.035;
      let hit = Math.abs(Math.abs(dz) - w.halfWidth / 3) < t && y < w.springY;
      hit = hit || Math.abs(y - (w.sill + w.springY) / 2) < t || Math.abs(y - w.springY) < t;
      if (y > w.springY) {
        const ang = Math.atan2(y - w.springY, -dz);
        const rr = Math.hypot(dz, y - w.springY);
        hit = hit || [45, 90, 135].some((deg) => Math.abs(angDiff(ang, rad(deg))) * rr < t && rr > w.halfWidth * 0.35);
        hit = hit || Math.abs(rr - w.halfWidth * 0.35) < t;
      }
      return hit ? 0.3 : 1;
    }

    // 0..1 direct sun reaching P through a window.
    function sunAt(P) {
      if (toSun[1] <= 0) return 0;
      let best = 0;
      if (Math.abs(toSun[0]) > 1e-4) {
        const side = Math.sign(toSun[0]);
        const t = (side * W2 - P[0]) / toSun[0];
        if (t > 0.05) {
          const y = P[1] + toSun[1] * t, z = P[2] + toSun[2] * t;
          const k = Math.floor((z - ROOM.near) / BAY);
          if (k >= 0 && k < ROOM.bays) {
            const dz = z - (ROOM.near + (k + 0.5) * BAY);
            const pen = 0.03 + t * 0.012;
            const v = smooth(pen, -pen, windowSD(dz, y)) * bars(dz, y);
            best = Math.max(best, v);
          }
        }
      }
      if (toSun[2] > 1e-4) {
        const t = (FAR - P[2]) / toSun[2];
        if (t > 0.05) {
          const x = P[0] + toSun[0] * t, y = P[1] + toSun[1] * t;
          if (y > ROOM.springY) {
            const rr = Math.hypot(x, y - ROOM.springY);
            const pen = 0.03 + t * 0.012;
            let v = smooth(pen, -pen, rr - ROOM.lunette);
            const ang = Math.atan2(y - ROOM.springY, -x);
            const bar = [30, 60, 90, 120, 150].some((deg) => Math.abs(angDiff(ang, rad(deg))) * rr < 0.05) ||
              Math.abs(rr - 1.5) < 0.05;
            if (bar) v *= 0.3;
            best = Math.max(best, v);
          }
        }
      }
      return best;
    }

    const GLASS = [1.5, 1.58, 1.72];
    const shoulder = (c) => (c <= 0.8 ? c : 0.8 + (c - 0.8) / (1 + (c - 0.8) * 1.5));

    // Total light on a surface point. lamps: positions along the wall (for the warm washes),
    // s: this point's position along the wall, occ: ambient-occlusion factor.
    function light(P, n, { lamps = null, s = 0, occ = 1 } = {}) {
      const y = P[1];
      const sky = daylight(P, n);
      let L = A.SKY_COOL.map((c) => c * sky);
      // Inter-reflection: the white attic and vault glow; warm bounce off the floor low down.
      const up = 0.05 + 0.4 * smooth(6.5, ROOM.springY + VR, y);
      L = L.map((c, i) => c + mix(A.SKY_WARM[i], A.SKY_COOL[i], smooth(0, 12, y)) * up + A.SKY_WARM[i] * 0.05);
      // Warm gallery lamps along the cornice washing the blue walls.
      if (lamps) {
        let wash = 0;
        for (const l of lamps) {
          const spread = 0.45 + Math.max(0, 6.0 - y) * 0.34;
          const lat = Math.exp(-Math.pow((s - l) / spread, 2));
          const vert = smooth(0.4, 2.0, y) * (1 - smooth(5.7, 6.15, y));
          const top = Math.exp(-Math.pow((y - 5.4) / 0.6, 2)) * 0.18;
          wash += lat * (vert * 0.42 + top);
        }
        L = L.map((c, i) => c + A.LAMP[i] * wash);
      }
      // Direct sun through the windows.
      const sun = sunAt(P);
      if (sun > 0) {
        const lam = Math.max(0, n[0] * toSun[0] + n[1] * toSun[1] + n[2] * toSun[2]);
        L = L.map((c, i) => c + A.SUN[i] * 1.5 * sun * lam);
      }
      return L.map((c) => shoulder(c * occ));
    }

    const cornerAO = (dist) => mix(0.7, 1, smooth(0, 0.8, dist));
    const wallAO = (y, along, len) =>
      mix(0.5, 1, smooth(0, 0.5, y)) *                               // floor contact
      (1 - 0.22 * smooth(5.75, 6.2, y) * (1 - smooth(6.2, 6.25, y))) * // under the cornice
      cornerAO(Math.min(along, len - along));
    const sideLamps = Array.from({ length: ROOM.bays }, (_, k) => ROOM.near + (k + 0.5) * BAY);

    const L = {
      // Floor: u across the room (x), v along it (z, near -> far).
      floor: () => A.bake(256, 512, (i, j) => {
        const x = -W2 + ((i + 0.5) / 256) * ROOM.width;
        const z = ROOM.near + (1 - (j + 0.5) / 512) * ROOM.length;
        const edge = Math.min(W2 - Math.abs(x), z - ROOM.near, FAR - z);
        const occ = mix(0.5, 1, smooth(0, 0.9, edge));
        return light([x, 0, z], [0, 1, 0], { occ });
      }),
      // Side walls: u along the room (near -> far), v up.
      side: (side) => A.bake(512, 256, (i, j) => {
        const z = ROOM.near + ((i + 0.5) / 512) * ROOM.length;
        const y = ROOM.springY * (1 - (j + 0.5) / 256);
        const k = Math.min(ROOM.bays - 1, Math.floor((z - ROOM.near) / BAY));
        const dz = z - (ROOM.near + (k + 0.5) * BAY);
        if (windowSD(dz, y) < 0) return GLASS;
        return light([side * W2, y, z], [-side, 0, 0], { lamps: sideLamps, s: z, occ: wallAO(y, z - ROOM.near, ROOM.length) });
      }),
      // End walls: u across (x from -5.5 to 5.5), v up.
      end: (far) => A.bake(256, 205, (i, j) => {
        const x = -W2 + ((i + 0.5) / 256) * ROOM.width;
        const y = ROOM.springY * (1 - (j + 0.5) / 205);
        const P = [x, y, far ? FAR : ROOM.near];
        return light(P, [0, 0, far ? -1 : 1], {
          lamps: far ? [-3.6, 0, 3.6] : [-3.7, 3.7], s: x, occ: wallAO(y, x + W2, ROOM.width)
        });
      }),
      // Vault: u across the arch (spring to spring), v along the room.
      vault: () => A.bake(256, 256, (i, j) => {
        const phi = ((i + 0.5) / 256) * Math.PI;
        const z = ROOM.near + (1 - (j + 0.5) / 256) * ROOM.length;
        const P = [-VR * Math.cos(phi), ROOM.springY + VR * Math.sin(phi), z];
        const edge = Math.min(z - ROOM.near, FAR - z);
        return light(P, [Math.cos(phi), -Math.sin(phi), 0], { occ: mix(0.82, 1, smooth(0, 1, edge)) });
      }),
      // Half-disc vault ends: u across (x), v up from the spring line.
      tympanum: (far) => A.bake(256, 128, (i, j) => {
        const x = -W2 + ((i + 0.5) / 256) * ROOM.width;
        const y = ROOM.springY + VR * (1 - (j + 0.5) / 128);
        if (far && Math.hypot(x, y - ROOM.springY) < ROOM.lunette) return GLASS;
        return light([x, y, far ? FAR : ROOM.near], [0, 0, far ? -1 : 1]);
      })
    };
    return L;
  }

  // =====================================================================
  // Geometry helpers (room-local coordinates; the room runs along +z)
  // =====================================================================
  function geometry(positions, uvs, indices) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  }

  // Quad from four corners given in uv order: (0,0) (1,0) (1,1) (0,1).
  function quad(p00, p10, p11, p01) {
    return geometry([...p00, ...p10, ...p11, ...p01], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
  }

  // Grid over (u, v) in [0,1]^2 with a position function.
  function grid(nu, nv, fn) {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        pos.push(...fn(u, v));
        uv.push(u, v);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i;
        idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
      }
    }
    return geometry(pos, uv, idx);
  }

  function halfDisc(z, segments = 32) {
    const pos = [0, ROOM.springY, z], uv = [0.5, 0], idx = [];
    for (let i = 0; i <= segments; i++) {
      const phi = (i / segments) * Math.PI;
      const x = -VR * Math.cos(phi), y = VR * Math.sin(phi);
      pos.push(x, ROOM.springY + y, z);
      uv.push((x / VR + 1) / 2, y / VR);
      if (i > 0) idx.push(0, i, i + 1);
    }
    return geometry(pos, uv, idx);
  }

  function material(texType, renderer, { repeat = [1, 1], lightCanvas = null, alphaTest = 0, color = null } = {}) {
    const opts = { side: THREE.DoubleSide };
    if (texType) {
      const map = A.getTexture(texType, renderer).clone();
      map.needsUpdate = true;
      map.repeat.set(repeat[0], repeat[1]);
      opts.map = map;
    }
    if (color) opts.color = new THREE.Color(color);
    if (lightCanvas) {
      opts.lightMap = A.lightmapTexture(lightCanvas);
      opts.lightMapIntensity = 2 * Math.PI; // the lightmap stores half-scale light
    }
    if (alphaTest) opts.alphaTest = alphaTest;
    return new THREE.MeshBasicMaterial(opts);
  }

  // Is a room-local point inside the entrance arch (plus its molding)? Used so admin
  // placement ignores the opening.
  function inArch(lx, ly, margin = ARCH.molding + 0.05) {
    const r = ARCH.halfWidth + margin;
    if (Math.abs(lx) > r) return false;
    return ly < ARCH.springY || Math.hypot(lx, ly - ARCH.springY) < r;
  }

  // =====================================================================
  // gallery-room
  // =====================================================================
  AFRAME.registerComponent('gallery-room', {
    schema: { angle: { default: 90 } },
    init() {
      const renderer = this.el.sceneEl.renderer;
      const group = new THREE.Group();
      const lm = roomLighting(this.data.angle);
      const add = (geo, mat, userData = {}) => {
        const mesh = new THREE.Mesh(geo, mat);
        Object.assign(mesh.userData, userData);
        group.add(mesh);
        return mesh;
      };
      const H = ROOM.springY;

      // Floor.
      add(quad([-W2, 0, ROOM.near], [W2, 0, ROOM.near], [W2, 0, FAR], [-W2, 0, FAR]),
        material('planks', renderer, { repeat: [ROOM.width / 4, ROOM.length / 4], lightCanvas: lm.floor() }),
        { surface: 'floor' });

      // Side walls (u along the room, v up).
      [-1, 1].forEach((side) => {
        const x = side * W2;
        add(quad([x, 0, ROOM.near], [x, 0, FAR], [x, H, FAR], [x, H, ROOM.near]),
          material('roomWall', renderer, { repeat: [ROOM.bays, 1], lightCanvas: lm.side(side) }),
          { surface: 'wall' });
      });

      // Far wall and entrance wall (u across from -x to +x, v up).
      add(quad([-W2, 0, FAR], [W2, 0, FAR], [W2, H, FAR], [-W2, H, FAR]),
        material('roomEnd', renderer, { lightCanvas: lm.end(true) }), { surface: 'wall' });
      const entry = add(quad([-W2, 0, ROOM.near], [W2, 0, ROOM.near], [W2, H, ROOM.near], [-W2, H, ROOM.near]),
        material('roomEntry', renderer, { lightCanvas: lm.end(false), alphaTest: 0.5 }),
        { surface: 'wall' });
      entry.userData.isHole = (p) => { // p is in world space
        const l = entry.worldToLocal(p.clone());
        return inArch(l.x, l.y);
      };

      // Barrel vault and its half-disc ends.
      add(grid(32, 1, (u, v) => {
        const phi = u * Math.PI;
        return [-VR * Math.cos(phi), H + VR * Math.sin(phi), ROOM.near + v * ROOM.length];
      }), material('roomVault', renderer, { repeat: [1, ROOM.bays], lightCanvas: lm.vault() }));
      add(halfDisc(FAR), material('tympanumFar', renderer, { lightCanvas: lm.tympanum(true) }));
      add(halfDisc(ROOM.near), material('tympanumNear', renderer, { lightCanvas: lm.tympanum(false) }));

      // Projecting cornice ledges.
      const ledgeMat = new THREE.MeshBasicMaterial({ color: '#d3cbbe' });
      const ledge = (w, d, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), ledgeMat);
        m.position.set(x, ROOM.corniceTop - 0.11, z);
        group.add(m);
      };
      ledge(0.3, ROOM.length, -W2 + 0.15, ROOM.near + ROOM.length / 2);
      ledge(0.3, ROOM.length, W2 - 0.15, ROOM.near + ROOM.length / 2);
      ledge(ROOM.width, 0.3, 0, FAR - 0.15);
      ledge(ROOM.width, 0.3, 0, ROOM.near + 0.15);

      // Passage through the wall thickness, from the curved rotunda wall to the room.
      // Its near edge follows the curve so there's no gap or lip at the arch.
      const curveZ = (x) => Math.sqrt(ROT_R * ROT_R - x * x) - 0.01;
      const hw = ARCH.halfWidth, sy = ARCH.springY;
      const jambMat = new THREE.MeshBasicMaterial({ color: '#8e8576', side: THREE.DoubleSide });
      [-1, 1].forEach((side) => {
        const x = side * hw;
        group.add(new THREE.Mesh(quad([x, 0, curveZ(x)], [x, 0, ROOM.near], [x, sy, ROOM.near], [x, sy, curveZ(x)]), jambMat));
      });
      group.add(new THREE.Mesh(grid(16, 1, (u, v) => {
        const phi = u * Math.PI;
        const x = -hw * Math.cos(phi);
        const z0 = curveZ(x);
        return [x, sy + hw * Math.sin(phi), z0 + v * (ROOM.near - z0)];
      }), new THREE.MeshBasicMaterial({ color: '#b3aa9b', side: THREE.DoubleSide })));
      group.add(new THREE.Mesh(grid(8, 1, (u, v) => {
        const x = -hw + u * 2 * hw;
        const z0 = curveZ(x);
        return [x, 0.002, z0 + v * (ROOM.near + 0.02 - z0)];
      }), material('planks', renderer, { repeat: [0.9, 0.3], color: '#9b8d79' })));

      this.el.setObject3D('room', group);
      this.el.object3D.rotation.set(0, rad(this.data.angle), 0);

      layout.rooms.push({
        angle: rad(this.data.angle),
        rects: [
          { x0: -hw + 0.45, x1: hw - 0.45, z0: 8.6, z1: ROOM.near + 0.6 },       // passage
          { x0: -W2 + 0.45, x1: W2 - 0.45, z0: ROOM.near + 0.45, z1: FAR - 0.45 } // gallery
        ]
      });
    },
    remove() {
      const a = rad(this.data.angle);
      layout.rooms = layout.rooms.filter((r) => r.angle !== a);
    }
  });

  // =====================================================================
  // rotunda-walls: the curved wall, split into plain stretches and arched bays
  // =====================================================================
  AFRAME.registerComponent('rotunda-walls', {
    schema: { arches: { type: 'array', default: ['90', '150', '210', '270'] } },
    init() {
      const renderer = this.el.sceneEl.renderer;
      const arches = this.data.arches.map(Number).map((d) => ((Math.round(d / 30) * 30) % 360 + 360) % 360);
      const isArch = (k) => arches.includes(k * 30);
      const wallLM = A.getLightmap('wall');
      const H = A.LIGHT.wallH;

      // Build runs of bays: each arch is its own piece; neighbouring plain bays merge.
      const pieces = [];
      const first = [...Array(12).keys()].find((k) => isArch(k));
      const startK = first === undefined ? 0 : first;
      for (let n = 0; n < 12; n++) {
        const k = (startK + n) % 12;
        const last = pieces[pieces.length - 1];
        if (isArch(k)) pieces.push({ start: k * 30 - 15, bays: 1, arch: true, centre: k * 30 });
        else if (last && !last.arch) last.bays++;
        else pieces.push({ start: k * 30 - 15, bays: 1, arch: false });
      }

      pieces.forEach((p) => {
        const len = p.bays * 30;
        const geo = new THREE.CylinderGeometry(ROT_R, ROT_R, H, Math.max(6, p.bays * 8), 1, true, rad(p.start), rad(len));
        const map = A.getTexture(p.arch ? 'wallArch' : 'wall', renderer).clone();
        map.needsUpdate = true;
        map.repeat.set(p.bays, 1);
        const lightMap = wallLM.clone(); // same baked image, shifted to this stretch of wall
        lightMap.needsUpdate = true;
        lightMap.repeat.set(len / 360, 1);
        lightMap.offset.set((((p.start - 15) / 360) % 1 + 1) % 1, 0);
        const mat = new THREE.MeshBasicMaterial({
          map, lightMap, lightMapIntensity: 2 * Math.PI, side: THREE.BackSide, alphaTest: p.arch ? 0.5 : 0
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = H / 2;
        mesh.userData.surface = 'wall';
        mesh.userData.curved = true;
        if (p.arch) {
          const c = rad(p.centre);
          mesh.userData.isHole = (pt) => {
            const s = ROT_R * angDiff(Math.atan2(pt.x, pt.z), c);
            const r = ARCH.halfWidth + ARCH.molding + 0.05;
            return Math.abs(s) < r && (pt.y < ARCH.springY || Math.hypot(s, pt.y - ARCH.springY) < r);
          };
        }
        this.el.object3D.add(mesh);
      });
    }
  });

  window.MuseumRooms = { ROOM };
})();
