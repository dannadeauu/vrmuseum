/* global THREE */

/**
 * Info desk: a long, angled white reception counter (three facets, two tiers, a brushed-steel
 * kick plate and "INFORMATION" lettered on the front) under a hanging white oval sign whose
 * underside glows, with a steel bin and a brochure stand beside it. The visitor computer sits
 * on the counter.
 *
 * Lighting is baked, never real-time (cheap on Quest), and follows the reference photo:
 *   - room light: the same model that lights the plaster walls (MuseumArch.wallLight), so the
 *     whites match the walls at every height, darkening into the floor;
 *   - sign light: the oval's glowing underside lights the counter tops brightly, washes the
 *     front faces (brighter near the top), leaves the ledge undersides dark and pools on the floor;
 *   - per-facet shading and crisp shadow lines under each ledge, painted into the textures.
 * The light is stored as vertex colours, worked out once when the desk is built (bakeLight).
 *
 * Clicking the computer screen opens the desk's link in a browser window in the middle of the
 * screen (in VR it leaves VR first, since web pages can't be shown inside the headset).
 * Admins change the link (and the sign's wording) in the admin editor.
 *
 * Record fields: { kind: 'infodesk', link, signText, position, rotationY }
 */
window.InfoDesk = (() => {
  const DEFAULT_LINK = 'https://en.wikipedia.org/wiki/Virtual_reality';
  const DEFAULT_SIGN = 'INFORMATION';
  const SANS = 'Futura, "Century Gothic", "Avenir Next", "Trebuchet MS", system-ui, sans-serif';
  // Tall, condensed capitals like the lettering in the reference photo.
  const CAPS = '"DIN Alternate", "DIN Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

  // Desk plan (metres, desk-local; +z is the front where visitors stand). The front edge runs
  // left to right: an angled wing, a straight middle, an angled wing.
  const FRONT = [{ x: -1.62, z: -0.02 }, { x: -0.8, z: 0.48 }, { x: 0.8, z: 0.48 }, { x: 1.62, z: -0.02 }];
  const KICK_H = 0.07;        // brushed-steel plinth
  const BODY_D = 0.62;        // depth of the lower body
  const LEDGE_Y = 0.92;       // top of the lower body; a 4 cm ledge sits on it
  const LEDGE_T = 0.04;
  const UPPER_IN = 0.3;       // the raised upper tier starts this far back from the front
  const UPPER_Y = 1.1;        // top of the upper tier; a 3.5 cm cap sits on it
  const CAP_T = 0.035;
  const TOP_Y = UPPER_Y + CAP_T;         // where the monitor stands
  const LEDGE_TOP = LEDGE_Y + LEDGE_T;   // where the keyboard lies
  // Oval sign.
  const SIGN_RX = 2.05, SIGN_RZ = 1.15, SIGN_H = 0.42, SIGN_Y = 3.0;
  const PLASTER = '#f2ece1'; // same plaster white as the museum walls (js/architecture.js)
  const SIGN_GLOW = [1.0, 0.98, 0.94]; // the diffuser's light: near-white, a touch warm
  const DIFFUSER_K = 0.1;  // counter tops right under the sign get about +0.6
  const BOUNCE_K = 0.32;   // the floor's glow lifts the front faces by about +0.4
  // Baked key light: from the front-left, slightly above (desk-local, horizontal part).
  const LIGHT = new THREE.Vector2(-0.45, 1).normalize();

  // Turn whatever an admin typed into a safe http(s) address, or '' if it isn't one.
  function normaliseLink(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch (e) { return ''; }
  }
  const hostOf = (link) => { try { return new URL(link).host.replace(/^www\./, ''); } catch (e) { return link; } };
  const signWords = (r) => (r.signText || DEFAULT_SIGN).toUpperCase();

  // ---------------------------------------------------------------- baked textures

  function tex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  const basic = (opts) => new THREE.MeshBasicMaterial(opts);
  const rad = THREE.MathUtils.degToRad;
  const textures = new Map();
  const cached = (key, make) => {
    if (!textures.has(key)) textures.set(key, make());
    return textures.get(key);
  };

  // How much baked light a vertical face with outward normal (nx, nz) gets (0.7 to 1).
  const shadeOf = (nx, nz) => 0.7 + 0.3 * Math.max(0, nx * LIGHT.x + nz * LIGHT.y);

  // Letters spaced out, centred on (cx, cy), squeezed to fit maxW.
  function trackedText(g, text, cx, cy, size, track, maxW) {
    g.font = `700 ${size}px ${CAPS}`;
    const widths = [...text].map((ch) => g.measureText(ch).width);
    let total = widths.reduce((a, b) => a + b, 0) + track * (text.length - 1);
    const squeeze = total > maxW ? maxW / total : 1;
    g.save();
    g.translate(cx, cy);
    g.scale(squeeze, 1);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    let x = -total / 2;
    [...text].forEach((ch, i) => { g.fillText(ch, x, 0); x += widths[i] + track; });
    g.restore();
  }

  // A white face of the counter: shaded by direction, a shadow line under the ledge above it,
  // a little darker near the floor, and optional lettering.
  function fasciaTexture(len, h, shade, text, ledgeShadow) {
    const key = ['fascia', len.toFixed(2), h.toFixed(2), shade.toFixed(2), text || '', ledgeShadow].join('|');
    return cached(key, () => tex(Math.max(64, Math.round(len * 360)), Math.max(16, Math.round(h * 360)), (g, W, H) => {
      g.fillStyle = PLASTER; g.fillRect(0, 0, W, H);
      g.fillStyle = `rgba(48,40,32,${((1 - shade) * 0.6).toFixed(3)})`; g.fillRect(0, 0, W, H);
      if (ledgeShadow) { // crisp shadow line under the overhanging ledge, then a soft fade
        g.fillStyle = 'rgba(40,32,24,0.38)'; g.fillRect(0, 0, W, 3);
        const gr = g.createLinearGradient(0, 3, 0, Math.min(H, 34));
        gr.addColorStop(0, 'rgba(40,32,24,0.24)'); gr.addColorStop(1, 'rgba(40,32,24,0)');
        g.fillStyle = gr; g.fillRect(0, 3, W, Math.min(H, 34));
      }
      if (text) {
        g.fillStyle = '#26272a';
        trackedText(g, text, W / 2, H * 0.27, Math.round(0.105 * 360 * 1.3), 10, W * 0.86);
      }
    }));
  }

  function steelTexture() {
    return cached('steel', () => tex(16, 64, (g, W, H) => {
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#6f7277'); gr.addColorStop(0.3, '#d4d7db'); gr.addColorStop(0.55, '#a3a6ab'); gr.addColorStop(1, '#5d6065');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }));
  }

  // Brushed-steel cylinder, shaded round its curve (u goes round from the front).
  function steelBinTexture() {
    return cached('bin', () => tex(512, 128, (g, W, H) => {
      for (let x = 0; x < W; x += 2) {
        const a = (x / W) * Math.PI * 2;                 // 0 = front
        const nx = Math.sin(a), nz = Math.cos(a);
        const l = 0.35 + 0.5 * Math.max(0, nx * LIGHT.x + nz * LIGHT.y) + 0.25 * Math.pow(Math.max(0, nz), 8);
        const v = Math.round(90 + 150 * Math.min(1, l));
        g.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
        g.fillRect(x, 0, 2, H);
      }
      g.fillStyle = 'rgba(255,255,255,0.08)';
      for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1); // brushed lines
      const gr = g.createLinearGradient(0, H * 0.7, 0, H);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.3)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }));
  }

  function floorShadowTexture() {
    return cached('shadow', () => tex(256, 256, (g, S) => {
      const c = S / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c);
      gr.addColorStop(0, 'rgba(20,12,6,0.62)');
      gr.addColorStop(0.45, 'rgba(20,12,6,0.4)');
      gr.addColorStop(0.7, 'rgba(20,12,6,0.1)');
      gr.addColorStop(1, 'rgba(20,12,6,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }));
  }

  // Cool white glow under the sign, pooled on the floor and the counter (added on top).
  function glowTexture() {
    return cached('glow', () => tex(256, 256, (g, S) => {
      const c = S / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c);
      gr.addColorStop(0, 'rgba(255,252,244,0.9)');
      gr.addColorStop(0.55, 'rgba(255,250,240,0.45)');
      gr.addColorStop(1, 'rgba(255,248,236,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }));
  }

  // The oval sign's band: white, lettered on the front and the back. The band is a stretched
  // cylinder, so the lettering is squeezed sideways to come out with its true proportions.
  function bandTexture(text) {
    return cached('band|' + text, () => tex(4096, 256, (g, W, H) => {
      g.fillStyle = PLASTER; g.fillRect(0, 0, W, H);
      for (let x = 0; x < W; x += 4) { // shade round the oval
        const a = (x / W) * Math.PI * 2;
        const nx = Math.sin(a) / SIGN_RX, nz = Math.cos(a) / SIGN_RZ, l = Math.hypot(nx, nz);
        g.fillStyle = `rgba(48,40,32,${(1 - shadeOf(nx / l, nz / l)).toFixed(3)})`;
        g.fillRect(x, 0, 4, H);
      }
      // Lit from below by its own diffuser: the band darkens towards the top, the lower lip glows.
      let gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, 'rgba(60,52,44,0.22)'); gr.addColorStop(0.7, 'rgba(60,52,44,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      gr = g.createLinearGradient(0, H, 0, H - 30);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, H - 30, W, 30);
      const squeeze = (SIGN_H / H) / (2 * Math.PI * SIGN_RX / W); // canvas px -> true aspect at the front
      g.fillStyle = '#25262a';
      for (const cx of [0, W / 2, W]) {
        g.save();
        g.translate(cx, 0);
        g.scale(squeeze, 1);
        trackedText(g, text, 0, H * 0.5, 150, 26, (W * 0.3) / squeeze);
        g.restore();
      }
    }));
  }

  // The glowing diffuser under the sign: bright white, a touch dimmer at the rim.
  function undersideTexture() {
    return cached('under', () => tex(256, 256, (g, S) => {
      const c = S / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.85, '#fdfbf6'); gr.addColorStop(0.97, '#e9e5dd'); gr.addColorStop(1, '#cfcac1');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }));
  }

  // Brochure stand front: stepped pockets with leaflets.
  function brochureTexture() {
    return cached('brochure', () => tex(256, 768, (g, W, H) => {
      g.fillStyle = '#f3f1ed'; g.fillRect(0, 0, W, H);
      const COLS = ['#2c6fb2', '#e4e1da', '#d24f3c', '#3c3d41', '#7aa95c', '#f1c04a'];
      g.fillStyle = '#2f3034'; g.font = `700 22px ${CAPS}`; g.textAlign = 'center';
      g.fillText('INFORMATION', W / 2, 34);
      for (let row = 0; row < 5; row++) {
        const y = 70 + row * 135;
        for (let col = 0; col < 2; col++) {
          const x = 18 + col * 118;
          g.fillStyle = COLS[(row * 2 + col) % COLS.length];
          g.fillRect(x + 6, y, 100, 105);
          g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(x + 16, y + 12, 80, 10);
        }
        g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(10, y + 60, W - 20, 62); // pocket front
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(10, y + 60, W - 20, 3);
      }
      const gr = g.createLinearGradient(0, H * 0.6, 0, H);
      gr.addColorStop(0, 'rgba(40,30,20,0)'); gr.addColorStop(1, 'rgba(40,30,20,0.18)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }));
  }

  function keyboardTexture() {
    return cached('keys', () => tex(512, 160, (g, W, H) => {
      g.fillStyle = '#1d1d20'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#2f3035';
      const rows = 5, cols = 15, kw = (W - 20) / cols, kh = (H - 20) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r === rows - 1 && c > 3 && c < 11) continue;
          g.fillRect(10 + c * kw + 2, 10 + r * kh + 2, kw - 4, kh - 4);
        }
      }
      g.fillRect(10 + 4 * kw + 2, 10 + 4 * kh + 2, 7 * kw - 4, kh - 4); // space bar
    }));
  }

  // What the visitor computer shows: a little browser window with the link's address.
  const screens = new Map();
  function screenTexture(link) {
    if (!screens.has(link)) {
      if (screens.size > 8) { const [k, t] = screens.entries().next().value; t.dispose(); screens.delete(k); }
      screens.set(link, drawScreen(link));
    }
    return screens.get(link);
  }
  function drawScreen(link) {
    const host = link ? hostOf(link) : 'No link set';
    return tex(1024, 640, (g, W, H) => {
      g.fillStyle = '#f7f7f8'; g.fillRect(0, 0, W, H);
      // Browser chrome.
      g.fillStyle = '#dfe1e5'; g.fillRect(0, 0, W, 70);
      ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
        g.fillStyle = col; g.beginPath(); g.arc(30 + i * 28, 35, 9, 0, Math.PI * 2); g.fill();
      });
      g.fillStyle = '#ffffff';
      roundRect(g, 130, 16, W - 160, 38, 19); g.fill();
      g.fillStyle = '#3c4043'; g.font = '24px system-ui, sans-serif'; g.textBaseline = 'middle';
      g.fillText(clip(g, link || 'Ask an admin to set a link', W - 200), 152, 36);
      // Page: a heading with the site, faint text lines, and an invitation to click.
      g.fillStyle = '#1a3a6b'; g.font = `600 56px ${SANS}`; g.textBaseline = 'alphabetic';
      g.fillText(clip(g, host, W - 120), 60, 170);
      g.fillStyle = '#d5d8de';
      for (let i = 0; i < 5; i++) g.fillRect(60, 210 + i * 34, (W - 120) * (i === 4 ? 0.55 : 0.92 - (i % 2) * 0.1), 14);
      g.fillStyle = '#ffb347';
      roundRect(g, 60, H - 150, 420, 86, 18); g.fill();
      g.fillStyle = '#1b1b1f'; g.font = `600 40px ${SANS}`; g.textBaseline = 'middle';
      g.fillText(link ? 'Click to browse' : 'No link yet', 92, H - 106);
    });
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function clip(g, text, maxW) {
    if (g.measureText(text).width <= maxW) return text;
    while (text.length > 1 && g.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  // ---------------------------------------------------------------- geometry

  // Where the computer sits: monitor on the upper tier, keyboard and mouse on the front ledge.
  const MONITOR = { x: -0.42, z: 0.04 };
  const KEYBOARD = { x: -0.42, z: 0.35 };

  function mesh(geo, mat, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  }

  function flatOnFloor(w, d, map, x, z, y = 0.012, extra = {}) {
    const m = mesh(new THREE.PlaneGeometry(w, d), basic({ map, transparent: true, depthWrite: false, ...extra }), x, y, z);
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  // Outward normal of the edge a -> b (the side to the left of the direction of travel, seen from above).
  function normalOf(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    return { x: -dz / l, z: dx / l };
  }

  // The same line moved `d` metres inward (negative: outward), with mitred corners.
  function offsetLine(pts, d) {
    const ns = pts.slice(1).map((p, i) => normalOf(pts[i], p));
    return pts.map((p, i) => {
      let n;
      if (i === 0) n = ns[0];
      else if (i === pts.length - 1) n = ns[i - 1];
      else {
        const a = ns[i - 1], b = ns[i];
        const m = { x: a.x + b.x, z: a.z + b.z }, l = Math.hypot(m.x, m.z);
        const k = 1 / ((m.x / l) * a.x + (m.z / l) * a.z);
        n = { x: (m.x / l) * k, z: (m.z / l) * k };
      }
      return { x: p.x - n.x * d, z: p.z - n.z * d };
    });
  }

  // One vertical face from a to b (seen from its outward side), between heights y0 and y1.
  function face(a, b, y0, y1, material) {
    const n = normalOf(a, b), len = Math.hypot(b.x - a.x, b.z - a.z);
    const geo = new THREE.PlaneGeometry(len, y1 - y0, Math.max(1, Math.ceil(len / 0.12)), Math.max(1, Math.ceil((y1 - y0) / 0.06)));
    const m = mesh(geo, material, (a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2);
    m.rotation.y = Math.atan2(n.x, n.z);
    return m;
  }

  // A horizontal polygon (points in order round the outline) at height y.
  function flat(points, y, material) {
    const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.z)));
    const m = mesh(new THREE.ShapeGeometry(shape), material, 0, y, 0);
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  // A solid that follows the desk's plan: `front` line, `depth` deep, from y0 to y1.
  // frontMat(i, len, h, n) gives each front face its material.
  function slab(g, front, depth, y0, y1, { frontMat, top = true, bottom = false, ledgeShadow = false }) {
    const back = offsetLine(front, depth);
    const h = y1 - y0;
    for (let i = 0; i < front.length - 1; i++) {
      const a = front[i], b = front[i + 1], n = normalOf(a, b);
      g.add(face(a, b, y0, y1, frontMat ? frontMat(i, Math.hypot(b.x - a.x, b.z - a.z), h, n)
        : basic({ map: fasciaTexture(Math.hypot(b.x - a.x, b.z - a.z), h, shadeOf(n.x, n.z), '', ledgeShadow) })));
      g.add(face(back[i + 1], back[i], y0, y1, basic({ color: 0xe4ddd1 }))); // staff side, away from the sign
    }
    const last = front.length - 1;
    const endL = normalOf(back[0], front[0]), endR = normalOf(front[last], back[last]);
    g.add(face(back[0], front[0], y0, y1, basic({ map: fasciaTexture(depth, h, shadeOf(endL.x, endL.z), '', false) })));
    g.add(face(front[last], back[last], y0, y1, basic({ map: fasciaTexture(depth, h, shadeOf(endR.x, endR.z), '', false) })));
    const outline = [...front, ...back.slice().reverse()];
    if (top) g.add(flat(outline, y1, basic({ color: PLASTER })));
    if (bottom) { // underside, in shadow
      const under = flat(outline, y0, basic({ color: 0x9d968b, side: THREE.DoubleSide }));
      under.userData.facesDown = true;
      g.add(under);
    }
  }

  function buildDeskGroup(r, ceilingY) {
    const g = new THREE.Group();
    const words = signWords(r);

    // Floor: a soft shadow under the counter, and the sign's glow pooled around it.
    g.add(flatOnFloor(4.4, 1.9, floorShadowTexture(), 0, 0.12));
    g.add(flatOnFloor(SIGN_RX * 2.9, SIGN_RZ * 2.9, glowTexture(), 0, 0.1, 0.016, { blending: THREE.AdditiveBlending, opacity: 0.45 }));

    // Brushed-steel kick plate, set back a little.
    const kick = offsetLine(FRONT, 0.025);
    const steel = basic({ map: steelTexture() });
    for (let i = 0; i < kick.length - 1; i++) g.add(face(kick[i], kick[i + 1], 0, KICK_H, steel));

    // Lower body, lettered on both wings.
    slab(g, FRONT, BODY_D, KICK_H, LEDGE_Y, {
      top: false,
      ledgeShadow: true,
      frontMat: (i, len, h, n) => basic({ map: fasciaTexture(len, h, shadeOf(n.x, n.z), i === 1 ? '' : words, true) })
    });
    // Front ledge (overhangs 2.5 cm), raised upper tier, and its cap.
    slab(g, offsetLine(FRONT, -0.025), BODY_D + 0.025, LEDGE_Y, LEDGE_TOP, { bottom: true });
    const upper = offsetLine(FRONT, UPPER_IN);
    slab(g, upper, BODY_D - UPPER_IN, LEDGE_TOP, UPPER_Y, { top: false, ledgeShadow: true });
    slab(g, offsetLine(upper, -0.02), BODY_D - UPPER_IN + 0.02, UPPER_Y, TOP_Y, { bottom: true });

    // On the counter: keyboard and mouse on the ledge, a small acrylic notice on the top.
    const kb = mesh(new THREE.BoxGeometry(0.42, 0.018, 0.13), [
      basic({ color: 0x18181b }), basic({ color: 0x18181b }), basic({ map: keyboardTexture() }),
      basic({ color: 0x18181b }), basic({ color: 0x232327 }), basic({ color: 0x18181b })
    ], KEYBOARD.x, LEDGE_TOP + 0.009, KEYBOARD.z);
    g.add(kb);
    const mouse = mesh(new THREE.SphereGeometry(0.03, 16, 8), basic({ color: 0x2a2a2e }), KEYBOARD.x + 0.3, LEDGE_TOP + 0.004, KEYBOARD.z);
    mouse.scale.set(1, 0.45, 1.5);
    g.add(mouse);
    const card = mesh(new THREE.BoxGeometry(0.15, 0.2, 0.006), basic({ color: 0xf7f6f2 }), 0.95, TOP_Y + 0.1, -0.06);
    card.rotation.set(-0.2, rad(-20), 0);
    g.add(card);
    g.add(mesh(new THREE.BoxGeometry(0.16, 0.012, 0.08), basic({ color: 0xd9dde0, transparent: true, opacity: 0.7 }), 0.95, TOP_Y + 0.006, -0.04));

    // Steel bin to the right of the desk, brochure stand to the left.
    const bin = new THREE.Group();
    bin.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.62, 32, 1, true), basic({ map: steelBinTexture() }), 0, 0.31, 0));
    const lid = mesh(new THREE.RingGeometry(0.14, 0.17, 32), basic({ color: 0xc9ccd0 }), 0, 0.62, 0);
    lid.rotation.x = -Math.PI / 2;
    bin.add(lid);
    const hole = mesh(new THREE.CircleGeometry(0.14, 32), basic({ color: 0x1c1c1e }), 0, 0.6, 0);
    hole.rotation.x = -Math.PI / 2;
    bin.add(hole);
    bin.add(flatOnFloor(0.6, 0.6, floorShadowTexture(), 0, 0));
    bin.position.set(1.95, 0, 0.32);
    g.add(bin);

    const stand = new THREE.Group();
    const white = basic({ color: 0xebe5da }), whiteTop = basic({ color: PLASTER });
    stand.add(mesh(new THREE.BoxGeometry(0.42, 1.3, 0.3, 2, 16, 2), [white, basic({ color: 0xdcd8d1 }), whiteTop, white, basic({ map: brochureTexture() }), white], 0, 0.65, 0));
    stand.add(flatOnFloor(0.75, 0.6, floorShadowTexture(), 0, 0));
    stand.position.set(-2.05, 0, 0.45);
    stand.rotation.y = rad(30);
    g.add(stand);

    // Hanging oval sign: white band with the lettering, glowing underside, rods to the ceiling.
    const sign = new THREE.Group();
    sign.position.y = SIGN_Y;
    const band = mesh(new THREE.CylinderGeometry(1, 1, SIGN_H, 128, 1, true), basic({ map: bandTexture(words) }));
    band.userData.ownLight = true; // the housing of the light: room light only
    band.scale.set(SIGN_RX, 1, SIGN_RZ);
    sign.add(band);
    const inner = mesh(new THREE.CylinderGeometry(0.995, 0.995, SIGN_H, 96, 1, true), basic({ color: 0xe6e2da, side: THREE.BackSide }));
    inner.scale.set(SIGN_RX, 1, SIGN_RZ);
    sign.add(inner);
    const glowDisc = mesh(new THREE.CircleGeometry(1, 96), basic({ map: undersideTexture(), toneMapped: false }), 0, -SIGN_H / 2 + 0.03, 0);
    glowDisc.userData.unlit = true; // it IS the light
    glowDisc.rotation.x = Math.PI / 2;  // faces down
    glowDisc.scale.set(SIGN_RX * 0.995, SIGN_RZ * 0.995, 1);
    sign.add(glowDisc);
    const cap = mesh(new THREE.CircleGeometry(1, 96), basic({ color: PLASTER }), 0, SIGN_H / 2, 0);
    cap.userData.ownLight = true;
    cap.rotation.x = -Math.PI / 2;
    cap.scale.set(SIGN_RX, SIGN_RZ, 1);
    sign.add(cap);
    const rodLen = Math.max(0.5, ceilingY - (SIGN_Y + SIGN_H / 2));
    const rodMat = basic({ color: 0x8f8c86 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      sign.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, rodLen, 6), rodMat,
        sx * SIGN_RX * 0.7, SIGN_H / 2 + rodLen / 2, sz * SIGN_RZ * 0.6));
    }
    g.add(sign);
    bakeLight(g, r);
    return g;
  }

  // Bake the light described at the top of this file into vertex colours (linear, like the
  // walls' lightmap: final colour = texture x light).
  function bakeLight(g, r) {
    const A = window.MuseumArch;
    const p = r.position || { x: 0, z: 0 };
    const theta = Math.atan2(p.x, p.z); // which part of the rotunda wall to match
    const sun = A && A.sunDir ? A.sunDir() : null;
    const roomCache = new Map();
    const room = (y) => {
      const k = Math.round(Math.min(5.2, Math.max(0.02, y)) * 25);
      if (!roomCache.has(k)) {
        roomCache.set(k, sun && A.wallLight
          ? A.wallLight(theta, k / 25, sun, { angle: Math.atan2(sun.x, sun.z) }, { skipPilasterAO: true })
          : [0.8, 0.78, 0.74]);
      }
      return roomCache.get(k);
    };
    // The diffuser as small emitters spread over the oval, shining down; and, as in the photo,
    // the bright pool it makes on the floor bouncing back up onto the front of the desk.
    const ring = (y, rings, sx, sz) => {
      const pts = [new THREE.Vector3(0, y, 0)];
      for (const k of rings) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.sin(a) * sx * k, y, Math.cos(a) * sz * k));
        }
      }
      return pts;
    };
    const diffuser = ring(SIGN_Y - SIGN_H / 2, [0.45, 0.8, 1.0], SIGN_RX, SIGN_RZ);
    const pool = ring(0, [0.35, 0.7, 1.0, 1.3], SIGN_RX * 1.2, SIGN_RZ * 1.6)
      .filter((q) => !(Math.abs(q.x) < 1.7 && q.z > -0.7 && q.z < 0.5)); // not under the desk
    const gather = (P, N, pts, fromBelow, soft) => {
      let s = 0;
      for (const q of pts) {
        const dx = q.x - P.x, dy = q.y - P.y, dz = q.z - P.z;
        if (fromBelow ? dy >= 0 : dy <= 0) continue;
        const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
        const recv = Math.max(0, (N.x * dx + N.y * dy + N.z * dz) / d);
        s += recv * (Math.abs(dy) / d) / (d2 + soft);
      }
      return s;
    };
    // The floor glow is wide and soft (large softening), so it can't leave hot spots near the floor.
    const signAt = (P, N) => gather(P, N, diffuser, false, 0.2) * DIFFUSER_K + gather(P, N, pool, true, 0.9) * BOUNCE_K;

    g.updateMatrixWorld(true);
    const P = new THREE.Vector3(), N = new THREE.Vector3(), nm = new THREE.Matrix3();
    g.traverse((o) => {
      if (!o.isMesh || o.userData.unlit) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m.transparent && !m.depthWrite)) return; // shadows and glows
      const geo = o.geometry;
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const pos = geo.attributes.position, nor = geo.attributes.normal;
      nm.getNormalMatrix(o.matrixWorld);
      const cols = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        P.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (o.userData.facesDown) N.set(0, -1, 0); // undersides drawn double-sided
        else N.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        const L = room(P.y);
        const s = o.userData.ownLight ? 0 : signAt(P, N);
        cols[i * 3] = L[0] + SIGN_GLOW[0] * s;
        cols[i * 3 + 1] = L[1] + SIGN_GLOW[1] * s;
        cols[i * 3 + 2] = L[2] + SIGN_GLOW[2] * s;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      mats.forEach((m) => { m.vertexColors = true; m.needsUpdate = true; });
    });
  }

  // The visitor computer: its own entity so it can be clicked.
  function buildComputer(r) {
    const el = document.createElement('a-entity');
    el.classList.add('clickable');
    el.setAttribute('position', `${MONITOR.x} ${TOP_Y} ${MONITOR.z}`);
    el.addEventListener('loaded', () => {
      const g = new THREE.Group();
      const dark = basic({ color: 0x141416 });
      const contact = mesh(new THREE.PlaneGeometry(0.4, 0.3), basic({ map: floorShadowTexture(), transparent: true, depthWrite: false }), 0, 0.002, -0.03);
      contact.rotation.x = -Math.PI / 2;
      g.add(contact);
      g.add(mesh(new THREE.BoxGeometry(0.22, 0.012, 0.16), basic({ color: 0x232327 }), 0, 0.006, -0.03));
      g.add(mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.2, 10), basic({ color: 0x2b2b2f }), 0, 0.11, -0.06));
      g.add(mesh(new THREE.BoxGeometry(0.58, 0.38, 0.03), dark, 0, 0.36, -0.04));
      const screenMat = basic({ map: screenTexture(r.link), toneMapped: false });
      const screen = mesh(new THREE.PlaneGeometry(0.54, 0.338), screenMat, 0, 0.36, -0.0245);
      g.add(screen);
      el.setObject3D('mesh', g);
      el.addEventListener('mouseenter', () => { screenMat.color.setRGB(1.15, 1.08, 0.95); el.sceneEl.canvas.style.cursor = 'pointer'; });
      el.addEventListener('mouseleave', () => { screenMat.color.setRGB(1, 1, 1); el.sceneEl.canvas.style.cursor = ''; });
    }, { once: true });
    el.addEventListener('click', (e) => {
      if (el.sceneEl.is('admin-mode')) return; // admins clicking select the desk instead
      e.stopPropagation();
      open(r.link, r.title);
    });
    return el;
  }

  // Height of the ceiling above a spot: the rotunda dome, or a fixed drop elsewhere.
  function ceilingAbove(p) {
    const d = Math.hypot(p.x, p.z);
    if (d < 9.4) return 6.4 + Math.sqrt(100 - d * d) - 0.3;
    return SIGN_Y + SIGN_H / 2 + 1.8;
  }

  function build(r, baseEntity) {
    const el = baseEntity(r);
    el.addEventListener('loaded', () => {
      el.setObject3D('mesh', buildDeskGroup(r, ceilingAbove(r.position || { x: 0, z: 0 })));
    }, { once: true });
    el.appendChild(buildComputer(r));
    return el;
  }

  // ---------------------------------------------------------------- browsing overlay

  let dom;
  function buildDom() {
    if (dom) return dom;
    const root = document.createElement('div');
    root.id = 'info-browser';
    root.hidden = true;
    root.innerHTML = `
      <div class="ib-card" role="dialog" aria-modal="true" aria-labelledby="ib-title">
        <header>
          <div class="ib-heading">
            <h2 id="ib-title">Info desk</h2>
            <p class="ib-url" id="ib-url"></p>
          </div>
          <button type="button" class="ib-btn" data-act="home" title="Back to the start page">Start page</button>
          <a class="ib-btn" id="ib-newtab" target="_blank" rel="noopener noreferrer">Open in new tab</a>
          <button type="button" class="ib-close" data-act="close" aria-label="Close">×</button>
        </header>
        <div class="ib-stage">
          <iframe id="ib-frame" title="Website" referrerpolicy="no-referrer-when-downgrade"
            allow="fullscreen; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>
          <div class="ib-empty" id="ib-empty">No link has been set for this computer yet.</div>
        </div>
        <p class="ib-hint">Page blank? Some websites don't allow being shown inside other sites. Use <strong>Open in new tab</strong> instead.</p>
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (e.target === root || act === 'close') close();
      if (act === 'home' && dom.link) dom.frame.src = dom.link;
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
    dom = { root, frame: root.querySelector('#ib-frame'), link: '' };
    return dom;
  }

  function open(link, title) {
    const scene = document.querySelector('a-scene');
    // Web pages can't be shown inside a headset: leave VR, then show the browser.
    if (scene && scene.is('vr-mode')) {
      scene.addEventListener('exit-vr', () => open(link, title), { once: true });
      scene.exitVR();
      return;
    }
    const d = buildDom();
    const safe = normaliseLink(link);
    d.link = safe;
    d.root.querySelector('#ib-title').textContent = safe ? hostOf(safe) : (title || 'Info desk');
    d.root.querySelector('#ib-url').textContent = safe;
    const nt = d.root.querySelector('#ib-newtab');
    nt.hidden = !safe;
    if (safe) nt.href = safe;
    d.root.querySelector('#ib-empty').hidden = !!safe;
    d.frame.hidden = !safe;
    if (safe && d.frame.getAttribute('src') !== safe) d.frame.src = safe;
    d.root.hidden = false;
    d.root.querySelector('.ib-close').focus();
  }

  function close() {
    if (!dom) return;
    dom.root.hidden = true;
    if (document.activeElement && dom.root.contains(document.activeElement)) document.activeElement.blur();
  }

  return { build, open, close, normaliseLink, DEFAULT_LINK, DEFAULT_SIGN };
})();
