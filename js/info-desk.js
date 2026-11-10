/* global AFRAME, THREE */

/**
 * Info desk: a round white information desk under a hanging "Info Zone" ring sign,
 * with a low book shelf behind it and a visitor computer on the counter.
 *
 * Everything is lit with light baked into canvas textures (no real-time lights or shadows,
 * which keeps it cheap on Quest): the counter-top shadow line, the cabinet shading round the
 * curve, the warm LED glow spilling onto the floor, the glowing sign letters and the LED rings
 * under the sign.
 *
 * Clicking the computer screen opens the desk's link in a browser window in the middle of the
 * screen (in VR it leaves VR first, since web pages can't be shown inside the headset).
 * Admins change the link (and the sign's wording) in the admin editor.
 *
 * Record fields: { kind: 'infodesk', link, signText, position, rotationY }
 */
window.InfoDesk = (() => {
  const DEFAULT_LINK = 'https://en.wikipedia.org/wiki/Virtual_reality';
  const DEFAULT_SIGN = 'Info Zone';
  const SANS = 'Futura, "Century Gothic", "Avenir Next", "Trebuchet MS", system-ui, sans-serif';

  // Desk proportions (metres). Local +z is the front, where visitors stand.
  const CAB_R = 0.8;          // cabinet outer radius
  const TOP_R = 0.86;         // counter top (overhangs the cabinet)
  const IN_R = 0.42;          // inner edge of the counter (staff side)
  const KICK = 0.1;           // recessed plinth with the LED strip
  const TOP_Y = 0.98;         // counter surface height
  const LIP = 0.045;          // counter thickness
  const GAP = 90;             // opening at the back for staff, degrees
  const SIGN_R = 1.32, SIGN_H = 0.44, SIGN_Y = 3.05;
  const LIGHT_DIR = -35;      // baked key light comes from the front-left (degrees round the desk)

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

  // How much baked light a surface facing round-the-desk angle `deg` gets (0.62 to 1).
  const lightAt = (deg) => 0.7 + 0.3 * Math.max(0, Math.cos(rad(deg - LIGHT_DIR)));

  // Shade a texture column by column for a cylinder covering [start, start + len] degrees.
  function shadeColumns(g, W, H, start, len, strength = 1) {
    for (let x = 0; x < W; x += 4) {
      const deg = start + (x / W) * len;
      g.fillStyle = `rgba(30,24,18,${((1 - lightAt(deg)) * strength).toFixed(3)})`;
      g.fillRect(x, 0, 4, H);
    }
  }

  const textures = {};
  function cabinetTexture() {
    if (textures.cabinet) return textures.cabinet;
    const start = 180 + GAP / 2, len = 360 - GAP;
    textures.cabinet = tex(2048, 256, (g, W, H) => {
      g.fillStyle = '#f5f3ee';
      g.fillRect(0, 0, W, H);
      shadeColumns(g, W, H, start, len);
      // Shadow line under the counter's overhang.
      let gr = g.createLinearGradient(0, 0, 0, H * 0.22);
      gr.addColorStop(0, 'rgba(40,30,20,0.32)');
      gr.addColorStop(1, 'rgba(40,30,20,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.22);
      // Warm LED light bouncing up from the floor near the bottom.
      gr = g.createLinearGradient(0, H, 0, H * 0.55);
      gr.addColorStop(0, 'rgba(255,214,160,0.55)');
      gr.addColorStop(1, 'rgba(255,214,160,0)');
      g.fillStyle = gr; g.fillRect(0, H * 0.55, W, H * 0.45);
      // Cupboard door seams, with a light edge beside each groove, and small push latches.
      const doors = 7;
      for (let i = 1; i < doors; i++) {
        const x = Math.round((i / doors) * W);
        g.fillStyle = 'rgba(60,55,50,0.55)'; g.fillRect(x - 1, 6, 3, H - 10);
        g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(x + 2, 6, 2, H - 10);
        g.fillStyle = 'rgba(80,75,70,0.6)';
        g.beginPath(); g.arc(x - 14, 46, 4, 0, Math.PI * 2); g.arc(x + 16, 46, 4, 0, Math.PI * 2); g.fill();
      }
    });
    return textures.cabinet;
  }

  function innerTexture() {
    if (textures.inner) return textures.inner;
    textures.inner = tex(512, 128, (g, W, H) => {
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#9c978f'); gr.addColorStop(0.5, '#c9c4bb'); gr.addColorStop(1, '#8f8a82');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    });
    return textures.inner;
  }

  // Counter top, seen from above. Canvas top = back of the desk, bottom = front.
  function counterTexture() {
    if (textures.counter) return textures.counter;
    const S = 1024, toPx = (m) => (m / TOP_R + 1) / 2 * S;
    textures.counter = tex(S, S, (g) => {
      g.fillStyle = '#faf8f4'; g.fillRect(0, 0, S, S);
      // Pool of light from the sign's LED ring above, brightest at the front-left.
      const gr = g.createRadialGradient(toPx(-0.25), toPx(0.35), 40, S / 2, S / 2, S * 0.6);
      gr.addColorStop(0, 'rgba(255,250,240,0)');
      gr.addColorStop(1, 'rgba(60,50,40,0.22)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      // Soft contact shadows under the things on the counter.
      const blot = (x, z, w, d, a) => {
        g.save();
        g.filter = 'blur(10px)';
        g.fillStyle = `rgba(40,30,20,${a})`;
        g.beginPath();
        g.ellipse(toPx(x), toPx(z), w / TOP_R * S / 2, d / TOP_R * S / 2, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      };
      MONITOR_SPOTS.forEach(([x, z]) => blot(x, z - 0.02, 0.13, 0.1, 0.35));
      blot(KEYBOARD[0], KEYBOARD[1], 0.24, 0.08, 0.22);
      blot(0.5, -0.2, 0.06, 0.06, 0.3);   // water bottle
      blot(-0.62, 0.2, 0.1, 0.08, 0.25);  // tray
      // Inner edge darkens slightly (it's in the desk's own shadow).
      const ring = g.createRadialGradient(S / 2, S / 2, IN_R / TOP_R * S / 2, S / 2, S / 2, (IN_R + 0.1) / TOP_R * S / 2);
      ring.addColorStop(0, 'rgba(50,40,30,0.25)'); ring.addColorStop(1, 'rgba(50,40,30,0)');
      g.fillStyle = ring; g.fillRect(0, 0, S, S);
    });
    return textures.counter;
  }

  function edgeTexture() {
    if (textures.edge) return textures.edge;
    const start = 180 + GAP / 2, len = 360 - GAP;
    textures.edge = tex(1024, 32, (g, W, H) => {
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, '#f1eee8'); gr.addColorStop(1, '#d9d4cb');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      shadeColumns(g, W, H, start, len, 0.8);
    });
    return textures.edge;
  }

  // Warm light from the LED strip in the plinth, spilling onto the floor (added on top).
  function floorGlowTexture() {
    if (textures.glow) return textures.glow;
    textures.glow = tex(512, 512, (g, S) => {
      const c = S / 2, toPx = (m) => (m / 1.6) * c; // plane is 3.2 m across
      const gr = g.createRadialGradient(c, c, toPx(0.7), c, c, toPx(1.55));
      gr.addColorStop(0, 'rgba(255,196,130,0.95)');
      gr.addColorStop(0.18, 'rgba(255,190,120,0.7)');
      gr.addColorStop(0.5, 'rgba(255,180,110,0.22)');
      gr.addColorStop(1, 'rgba(255,170,100,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      g.globalCompositeOperation = 'destination-out'; // nothing under the desk itself
      g.beginPath(); g.arc(c, c, toPx(0.7), 0, Math.PI * 2); g.fill();
    });
    return textures.glow;
  }

  function floorShadowTexture() {
    if (textures.shadow) return textures.shadow;
    textures.shadow = tex(256, 256, (g, S) => {
      const c = S / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c);
      gr.addColorStop(0, 'rgba(20,12,6,0.7)');
      gr.addColorStop(0.45, 'rgba(20,12,6,0.45)');
      gr.addColorStop(0.62, 'rgba(20,12,6,0.12)');
      gr.addColorStop(1, 'rgba(20,12,6,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    });
    return textures.shadow;
  }

  // The ring sign's band: black, with the words in glowing white letters three times round.
  const bandCache = new Map();
  function bandTexture(text) {
    if (bandCache.has(text)) return bandCache.get(text);
    const t = tex(4096, 256, (g, W, H) => {
      g.fillStyle = '#121214'; g.fillRect(0, 0, W, H);
      shadeColumns(g, W, H, 0, 360, 0.6);
      // Rounded top and bottom edges catch a little light.
      let gr = g.createLinearGradient(0, 0, 0, 14);
      gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, 14);
      gr = g.createLinearGradient(0, H, 0, H - 14);
      gr.addColorStop(0, 'rgba(255,220,180,0.25)'); gr.addColorStop(1, 'rgba(255,220,180,0)');
      g.fillStyle = gr; g.fillRect(0, H - 14, W, 14);
      // Letters, with a soft halo so they read as lit from inside.
      let size = 150;
      g.font = `500 ${size}px ${SANS}`;
      const maxW = W / 3 - 160;
      const w = g.measureText(text).width;
      if (w > maxW) { size = Math.floor(size * maxW / w); g.font = `500 ${size}px ${SANS}`; }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i < 3; i++) {
        const x = (i / 3) * W;
        for (const dx of [x, x + W, x - W]) {
          if (dx < -W / 3 || dx > W + W / 3) continue;
          g.shadowColor = 'rgba(255,255,255,0.85)'; g.shadowBlur = 26;
          g.fillStyle = '#fffdf6';
          g.fillText(text, dx, H / 2 + 6);
          g.shadowBlur = 0;
          g.fillText(text, dx, H / 2 + 6);
        }
      }
    });
    bandCache.set(text, t);
    return t;
  }

  // Underside of the sign: dark, with two warm LED rings.
  function undersideTexture() {
    if (textures.under) return textures.under;
    textures.under = tex(512, 512, (g, S) => {
      const c = S / 2, toPx = (m) => (m / SIGN_R) * c;
      g.fillStyle = '#1c1b1d'; g.fillRect(0, 0, S, S);
      const ringAt = (r, w) => {
        g.save();
        g.shadowColor = 'rgba(255,190,120,1)'; g.shadowBlur = 18;
        g.strokeStyle = '#ffe2b8'; g.lineWidth = w;
        g.beginPath(); g.arc(c, c, toPx(r), 0, Math.PI * 2); g.stroke();
        g.restore();
      };
      ringAt(1.2, 5);
      ringAt(0.95, 4);
      const gr = g.createRadialGradient(c, c, 0, c, c, toPx(0.85));
      gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    });
    return textures.under;
  }

  // Low shelf behind the desk: white frame, black cubbies, picture books facing out.
  function shelfTexture(seed) {
    const key = 'shelf' + seed;
    if (textures[key]) return textures[key];
    let s = seed * 9301 + 49297;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const COVERS = ['#e0b13a', '#d7553b', '#5a8fc9', '#7fb069', '#f2e3c6', '#c46aa3', '#3f6e9e', '#f08a4b', '#9bc4cb', '#eac35a'];
    textures[key] = tex(1024, 512, (g, W, H) => {
      g.fillStyle = '#f2f0eb'; g.fillRect(0, 0, W, H);
      const frame = 26, rows = 2, cols = 3;
      const cw = (W - frame * (cols + 1)) / cols, ch = (H - frame * (rows + 1)) / rows;
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const x = frame + k * (cw + frame), y = frame + r * (ch + frame);
          g.fillStyle = '#18181a'; g.fillRect(x, y, cw, ch);
          // Books leaning back on a sloped display, two or three per cubby.
          const n = 2 + Math.floor(rnd() * 2);
          const bw = (cw - 16 * (n + 1)) / n;
          for (let b = 0; b < n; b++) {
            const bx = x + 16 + b * (bw + 16), bh = ch * (0.68 + rnd() * 0.18), by = y + ch - bh - 8;
            g.fillStyle = COVERS[Math.floor(rnd() * COVERS.length)];
            g.fillRect(bx, by, bw, bh);
            // A simple cover: title block and a picture blob.
            g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(bx + bw * 0.12, by + bh * 0.08, bw * 0.76, bh * 0.14);
            g.fillStyle = COVERS[Math.floor(rnd() * COVERS.length)];
            g.beginPath(); g.ellipse(bx + bw / 2, by + bh * 0.6, bw * 0.3, bh * 0.22, 0, 0, Math.PI * 2); g.fill();
            // Spine shading.
            const sg = g.createLinearGradient(bx, 0, bx + bw, 0);
            sg.addColorStop(0, 'rgba(0,0,0,0.35)'); sg.addColorStop(0.12, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.12)');
            g.fillStyle = sg; g.fillRect(bx, by, bw, bh);
          }
          // The shelf above shadows the top of each cubby.
          const gr = g.createLinearGradient(0, y, 0, y + ch * 0.55);
          gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr; g.fillRect(x, y, cw, ch * 0.55);
        }
      }
      // Overall light from the front-left.
      const lg = g.createLinearGradient(0, 0, W, 0);
      lg.addColorStop(0, 'rgba(255,250,240,0)'); lg.addColorStop(1, 'rgba(40,30,20,0.18)');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
      const bg = g.createLinearGradient(0, H * 0.7, 0, H);
      bg.addColorStop(0, 'rgba(40,30,20,0)'); bg.addColorStop(1, 'rgba(40,30,20,0.22)');
      g.fillStyle = bg; g.fillRect(0, H * 0.7, W, H * 0.3);
    });
    return textures[key];
  }

  function endPanelTexture() {
    if (textures.endPanel) return textures.endPanel;
    textures.endPanel = tex(128, 512, (g, W, H) => {
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, '#d23b33'); gr.addColorStop(1, '#a92823');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.save();
      g.translate(W / 2 + 4, 24);
      g.rotate(Math.PI / 2);
      g.fillStyle = '#ffffff';
      g.font = `500 64px ${SANS}`;
      g.textBaseline = 'middle';
      g.fillText('Quick Picks', 0, 0);
      g.restore();
    });
    return textures.endPanel;
  }

  function keyboardTexture() {
    if (textures.keys) return textures.keys;
    textures.keys = tex(512, 160, (g, W, H) => {
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
    });
    return textures.keys;
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

  // Where things sit on the counter (desk-local x, z).
  const MONITOR_SPOTS = [[-0.36, 0.5]];
  const KEYBOARD = [-0.22, 0.66];

  function mesh(geo, mat, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  }

  function buildDeskGroup(r, ceilingY) {
    const g = new THREE.Group();
    const cylStart = rad(180 + GAP / 2), cylLen = rad(360 - GAP);

    // Floor: soft shadow, then the warm LED glow round the base.
    const shadow = mesh(new THREE.PlaneGeometry(2.6, 2.6), basic({ map: floorShadowTexture(), transparent: true, depthWrite: false }), 0, 0.011, -0.1);
    shadow.rotation.x = -Math.PI / 2;
    g.add(shadow);
    const glow = mesh(new THREE.PlaneGeometry(3.2, 3.2), basic({
      map: floorGlowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55
    }), 0, 0.014, 0);
    glow.rotation.x = -Math.PI / 2;
    g.add(glow);

    // Recessed plinth (the LED strip lives here) and its glowing lower edge.
    g.add(mesh(new THREE.CylinderGeometry(CAB_R - 0.06, CAB_R - 0.06, KICK, 64, 1, false, cylStart, cylLen),
      basic({ color: 0x2a2725 }), 0, KICK / 2, 0));
    const led = mesh(new THREE.TorusGeometry(CAB_R - 0.04, 0.006, 6, 96, cylLen), basic({ color: 0xffe0b0 }));
    led.rotation.x = Math.PI / 2; // lie flat; the arc then runs from +x round towards +z
    const ledTurn = new THREE.Group();
    ledTurn.add(led);
    ledTurn.position.y = KICK - 0.004;
    ledTurn.rotation.y = rad(GAP / 2); // line the arc up with the cabinet (opening at the back)
    g.add(ledTurn);

    // Cabinet: outer curved doors, inner (staff) wall, and end panels either side of the opening.
    const cabH = TOP_Y - LIP - KICK;
    g.add(mesh(new THREE.CylinderGeometry(CAB_R, CAB_R, cabH, 96, 1, true, cylStart, cylLen),
      basic({ map: cabinetTexture() }), 0, KICK + cabH / 2, 0));
    g.add(mesh(new THREE.CylinderGeometry(IN_R + 0.02, IN_R + 0.02, cabH, 64, 1, true, cylStart, cylLen),
      basic({ map: innerTexture(), side: THREE.BackSide }), 0, KICK + cabH / 2, 0));
    for (const end of [cylStart, cylStart + cylLen]) {
      const midR = (CAB_R + IN_R) / 2;
      const p = mesh(new THREE.BoxGeometry(CAB_R - IN_R, TOP_Y - LIP, 0.02), basic({ color: 0xd6d1c8 }),
        Math.sin(end) * midR, (TOP_Y - LIP) / 2, Math.cos(end) * midR);
      p.rotation.y = end - Math.PI / 2;
      g.add(p);
    }

    // Counter: top surface, front edge, inner edge.
    const top = mesh(new THREE.RingGeometry(IN_R, TOP_R, 96, 1, rad(90 + GAP / 2), cylLen),
      basic({ map: counterTexture() }), 0, TOP_Y, 0);
    top.rotation.x = -Math.PI / 2;
    g.add(top);
    g.add(mesh(new THREE.CylinderGeometry(TOP_R, TOP_R, LIP, 96, 1, true, cylStart, cylLen),
      basic({ map: edgeTexture() }), 0, TOP_Y - LIP / 2, 0));
    const under = mesh(new THREE.RingGeometry(CAB_R, TOP_R, 96, 1, rad(270 + GAP / 2), cylLen),
      basic({ color: 0xb9b3a9 }), 0, TOP_Y - LIP, 0);
    under.rotation.x = Math.PI / 2;
    g.add(under);
    g.add(mesh(new THREE.CylinderGeometry(IN_R, IN_R, LIP, 64, 1, true, cylStart, cylLen),
      basic({ color: 0xe4e0d8, side: THREE.BackSide }), 0, TOP_Y - LIP / 2, 0));

    // Things on the counter.
    const kb = mesh(new THREE.BoxGeometry(0.42, 0.018, 0.13), [
      basic({ color: 0x18181b }), basic({ color: 0x18181b }), basic({ map: keyboardTexture() }),
      basic({ color: 0x18181b }), basic({ color: 0x232327 }), basic({ color: 0x18181b })
    ], KEYBOARD[0], TOP_Y + 0.009, KEYBOARD[1]);
    kb.rotation.y = rad(-22);
    g.add(kb);
    const mouse = mesh(new THREE.SphereGeometry(0.03, 16, 8), basic({ color: 0x2a2a2e }), 0.04, TOP_Y + 0.004, 0.72);
    mouse.scale.set(1, 0.45, 1.5);
    g.add(mouse);
    const bottle = new THREE.Group();
    bottle.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 20), basic({ color: 0xcfe3ef, transparent: true, opacity: 0.6 }), 0, 0.1, 0));
    bottle.add(mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.06, 20), basic({ color: 0xffffff }), 0, 0.12, 0));
    bottle.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 12), basic({ color: 0x2d6fb7 }), 0, 0.215, 0));
    bottle.position.set(0.5, TOP_Y, -0.2);
    g.add(bottle);
    const tray = mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.04, 24), basic({ color: 0xf07d2b }), -0.62, TOP_Y + 0.02, 0.2);
    tray.scale.z = 0.7;
    g.add(tray);

    // Staff monitor (seen from behind) on the right.
    const back = new THREE.Group();
    back.add(mesh(new THREE.BoxGeometry(0.5, 0.32, 0.03), basic({ color: 0x1b1b1e }), 0, 0.3, 0));
    back.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 10), basic({ color: 0x2b2b2f }), 0, 0.08, -0.04));
    back.add(mesh(new THREE.BoxGeometry(0.2, 0.012, 0.14), basic({ color: 0x2b2b2f }), 0, 0.006, -0.04));
    back.position.set(0.35, TOP_Y, 0.05);
    back.rotation.y = rad(160);
    g.add(back);

    // Low shelf behind the desk: books both sides, red "Quick Picks" end panel.
    const SW = 2.5, SH = 1.2, SD = 0.42, SZ = -1.2;
    const side = basic({ color: 0xdedbd5 }), topMat = basic({ color: 0xf6f4f0 });
    const shelf = mesh(new THREE.BoxGeometry(SW, SH, SD), [
      side, side, topMat, side, basic({ map: shelfTexture(3) }), basic({ map: shelfTexture(7) })
    ], 0, SH / 2, SZ);
    g.add(shelf);
    const endMat = basic({ map: endPanelTexture() });
    g.add(mesh(new THREE.BoxGeometry(0.05, SH + 0.12, SD + 0.06), [endMat, endMat, basic({ color: 0xb8302a }), side, basic({ color: 0xbe322b }), basic({ color: 0xbe322b })],
      SW / 2 + 0.025, (SH + 0.12) / 2, SZ));
    const shelfShadow = mesh(new THREE.PlaneGeometry(SW + 0.5, SD + 0.6), basic({ map: floorShadowTexture(), transparent: true, depthWrite: false }), 0, 0.012, SZ);
    shelfShadow.rotation.x = -Math.PI / 2;
    g.add(shelfShadow);

    // Hanging ring sign: black band with glowing words, LED rings underneath, rods to the ceiling.
    const sign = new THREE.Group();
    sign.position.y = SIGN_Y;
    sign.add(mesh(new THREE.CylinderGeometry(SIGN_R, SIGN_R, SIGN_H, 96, 1, true), basic({ map: bandTexture(r.signText || DEFAULT_SIGN) })));
    sign.add(mesh(new THREE.CylinderGeometry(SIGN_R - 0.004, SIGN_R - 0.004, SIGN_H, 64, 1, true), basic({ color: 0x0e0e10, side: THREE.BackSide })));
    const bottom = mesh(new THREE.CircleGeometry(SIGN_R, 96), basic({ map: undersideTexture() }), 0, -SIGN_H / 2, 0);
    bottom.rotation.x = Math.PI / 2;
    sign.add(bottom);
    const lid = mesh(new THREE.CircleGeometry(SIGN_R, 64), basic({ color: 0x151517 }), 0, SIGN_H / 2, 0);
    lid.rotation.x = -Math.PI / 2;
    sign.add(lid);
    const rodLen = Math.max(0.5, ceilingY - (SIGN_Y + SIGN_H / 2));
    const rodMat = basic({ color: 0x9a978f });
    for (let i = 0; i < 4; i++) {
      const a = rad(45 + i * 90);
      sign.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, rodLen, 8), rodMat,
        Math.sin(a) * SIGN_R * 0.75, SIGN_H / 2 + rodLen / 2, Math.cos(a) * SIGN_R * 0.75));
    }
    g.add(sign);

    return g;
  }

  // The visitor computer: its own entity so it can be clicked.
  function buildComputer(r) {
    const el = document.createElement('a-entity');
    el.classList.add('clickable');
    const [x, z] = MONITOR_SPOTS[0];
    el.setAttribute('position', `${x} ${TOP_Y} ${z}`);
    el.setAttribute('rotation', '0 -18 0');
    el.addEventListener('loaded', () => {
      const g = new THREE.Group();
      const dark = basic({ color: 0x141416 });
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
