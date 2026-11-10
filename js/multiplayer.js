/* global AFRAME, THREE, MuseumStore */

/**
 * Multiplayer: see other visitors as floating low-poly robots (each a different
 * colour, with their name above them) and talk in a text chat.
 *
 * Uses Supabase Realtime (the same project as the shared museum):
 *   Presence  - who is here, with their name and colour
 *   Broadcast - head (and VR hand) positions a few times a second, and chat messages
 * Nothing is written to the database, so it doesn't use any storage.
 * Chat is live only: people who arrive later don't see earlier messages.
 * Only runs when the museum is online (Supabase reachable).
 */
(() => {
  const SEND_HZ = 6;           // max position updates per second (only sent when you move)
  const HEARTBEAT_MS = 2500;   // resend now and then even when still, so newcomers see you
  const STALE_MS = 15000;      // hide a robot that hasn't been heard from for this long (and has left presence)
  const LEAVE_GRACE_MS = 10000; // keep a robot this long after it drops out of presence, in case it's back
  const PRESENCE_POSE_MS = 4000; // how often your position is also saved in presence while you move
  const BUBBLE_MS = 7000;      // how long a chat bubble stays above a robot
  const MAX_CHAT = 200;        // characters per message
  // People in the museum at once (logged-in admins don't count). Set in js/supabase-config.js.
  const MAX_VISITORS = Math.max(1, Number((window.MUSEUM_SUPABASE || {}).maxVisitors) || 10);
  const ROBOT_SCALE = 1;

  // ---------- identity ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } }
  };
  const myId = (() => {
    // A fresh id per tab, so two tabs in one browser are two visitors.
    try {
      let id = sessionStorage.getItem('museum-visitor-id');
      if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); sessionStorage.setItem('museum-visitor-id', id); }
      return id;
    } catch { return String(Math.random()).slice(2); }
  })();
  // Which kind of device a visitor is on (shown in chat when they join).
  const device = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent) ? 'headset'
    : /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : 'computer';
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  let myName = cleanName(store.get('museum-visitor-name')) || `Visitor ${Math.floor(10 + Math.random() * 90)}`;

  // Fallback hue from an id (golden-angle steps keep neighbours distinct).
  function hueFor(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return Math.round((h * 137.508) % 360);
  }

  // ---------- avatar look (chosen at the avatar station, saved in this browser) ----------
  const HATS = ['none', 'cowboy', 'headset'];
  const EYES = ['happy', 'open', 'wink'];
  const hueColour = (h) => new THREE.Color().setHSL((((+h || 0) % 360) + 360) % 360 / 360, 0.72, 0.52);
  const normLook = (l, fallbackHue) => ({
    hue: l && l.hue !== undefined && l.hue !== null && Number.isFinite(+l.hue)
      ? Math.round((((+l.hue) % 360) + 360) % 360) : fallbackHue,
    hat: l && HATS.includes(l.hat) ? l.hat : 'none',
    eyes: l && EYES.includes(l.eyes) ? l.eyes : 'happy'
  });
  const lookKey = (l) => `${l.hue}|${l.hat}|${l.eyes}`;
  let myLook = (() => {
    let saved = null;
    try { saved = JSON.parse(store.get('museum-avatar') || 'null'); } catch { /* ignore */ }
    const look = normLook(saved, Math.floor(Math.random() * 360));
    store.set('museum-avatar', JSON.stringify(look)); // same look next visit
    return look;
  })();
  const lookListeners = [];

  // ---------- the robot ----------
  // Cowboy hat brim: an oval ring whose sides sweep up (more toward the edge) while the
  // front and back dip a little, like a classic western hat.
  const BRIM = { rIn: 0.1, rOut: 0.225, depth: 0.86 };
  function brimLift(f, th) {
    const c = Math.cos(th), sn = Math.sin(th);
    return f * f * (0.085 * c * c) - f * f * 0.014 * sn * sn;
  }
  function cowboyBrim(segs = 72, rings = 8) {
    const pos = [], idx = [];
    for (let j = 0; j <= rings; j++) {
      const f = j / rings, r = BRIM.rIn + (BRIM.rOut - BRIM.rIn) * f;
      for (let i = 0; i <= segs; i++) {
        const th = (i / segs) * Math.PI * 2;
        pos.push(Math.cos(th) * r, brimLift(f, th), Math.sin(th) * r * BRIM.depth);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i, b = a + segs + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  function cowboyBrimEdge() {
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const th = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(th) * BRIM.rOut, brimLift(1, th), Math.sin(th) * BRIM.rOut * BRIM.depth));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, 0.0075, 8, true);
  }

  const shared = {}; // geometries reused by every robot

  // A smooth oval panel lying on a sphere of radius R, facing +z. halfW / halfH are the
  // oval's half-size in radians around the sphere, so its rim is a clean curve.
  function ovalPanel(R, halfW, halfH, rings = 12, segs = 48) {
    const pos = [], uv = [], idx = [];
    pos.push(0, 0, R); uv.push(0.5, 0.5);
    for (let r = 1; r <= rings; r++) {
      const f = r / rings;
      for (let k = 0; k < segs; k++) {
        const t = (k / segs) * Math.PI * 2;
        const az = halfW * f * Math.cos(t), el = halfH * f * Math.sin(t);
        pos.push(R * Math.sin(az) * Math.cos(el), R * Math.sin(el), R * Math.cos(az) * Math.cos(el));
        uv.push(0.5 + 0.5 * f * Math.cos(t), 0.5 + 0.5 * f * Math.sin(t));
      }
    }
    const ring = (r, k) => 1 + (r - 1) * segs + (k % segs);
    for (let k = 0; k < segs; k++) idx.push(0, ring(1, k), ring(1, k + 1));
    for (let r = 1; r < rings; r++) {
      for (let k = 0; k < segs; k++) {
        idx.push(ring(r, k), ring(r + 1, k), ring(r + 1, k + 1), ring(r, k), ring(r + 1, k + 1), ring(r, k + 1));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  function geo() {
    if (shared.head) return shared;
    // Smooth, rounded shapes (a few hundred triangles per robot: cheap even with 10 visitors).
    const ball = (r, w = 28, h = 20) => new THREE.SphereGeometry(r, w, h);
    shared.head = ball(0.17);
    shared.visor = ovalPanel(0.17 * 1.02, 0.66, 0.38); // smooth oval face plate on the head's surface
    shared.eye = new THREE.TorusGeometry(0.03, 0.009, 8, 20, Math.PI);
    shared.ear = new THREE.CylinderGeometry(0.055, 0.055, 0.06, 24);
    shared.earHole = new THREE.CylinderGeometry(0.022, 0.022, 0.062, 16);
    shared.fin = new THREE.CapsuleGeometry(0.018, 0.08, 4, 10);
    shared.topBump = new THREE.CylinderGeometry(0.05, 0.065, 0.045, 20);
    shared.body = ball(0.15);
    shared.badge = new THREE.CircleGeometry(0.055, 28);
    shared.arm = ball(0.055, 16, 12);
    shared.hand = ball(0.05, 16, 12);
    shared.eyeDot = new THREE.CircleGeometry(0.026, 24);
    // Cowboy hat: wide brim, pinched crown, dark band.
    shared.brim = cowboyBrim();                  // curls up at the sides, dips front and back
    shared.brimEdge = cowboyBrimEdge();          // darker stitched rim following the curl
    shared.crown = new THREE.CylinderGeometry(0.085, 0.11, 0.12, 32);
    shared.crownTop = new THREE.SphereGeometry(0.085, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    shared.band = new THREE.CylinderGeometry(0.112, 0.114, 0.012, 32, 1, true);
    // VR headset: rounded visor box + strap round the head.
    shared.goggles = new THREE.CapsuleGeometry(0.048, 0.13, 8, 20);
    shared.lens = new THREE.CircleGeometry(0.03, 20);
    shared.strap = new THREE.TorusGeometry(0.168, 0.012, 8, 48);
    return shared;
  }

  function makeRobot(lookOrColour) {
    const look = lookOrColour && lookOrColour.isColor ? null : normLook(lookOrColour, 200);
    const colour = look ? hueColour(look.hue) : lookOrColour;
    const g = geo();
    const shell = new THREE.Color(0xffffff).lerp(colour, 0.38);   // tinted body
    const accent = colour.clone();                                // ears, fins, badge, arms
    // Smooth (per-pixel) shading. Lambert/Phong are among the cheapest lit materials.
    const lam = (c, extra = {}) => new THREE.MeshLambertMaterial({ color: c, ...extra });
    // A soft self-glow keeps the robots bright and clean whichever way the room light falls.
    const shellMat = lam(shell, { emissive: shell.clone().multiplyScalar(0.42) });
    const accentMat = lam(accent, { emissive: accent.clone().multiplyScalar(0.3) });
    // Glassy visor: a little shine catches the light like the reference.
    const visorMat = new THREE.MeshPhongMaterial({
      color: 0x0d1f6e, emissive: 0x1636b8, emissiveIntensity: 0.5, specular: 0x9fc4ff, shininess: 70
    });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xbff4ff });
    const darkMat = lam(0x1a2233);

    const root = new THREE.Group();      // positioned at the visitor's head, turned with their yaw
    const bob = new THREE.Group();       // gentle floating
    root.add(bob);

    // Head (tilts with where they look).
    const head = new THREE.Group();
    bob.add(head);
    const skull = new THREE.Mesh(g.head, shellMat);
    skull.scale.set(1.18, 0.95, 1.0);
    head.add(skull);
    // Visor and eyes ride on the skull so they follow its oval shape exactly.
    const visor = new THREE.Mesh(g.visor, visorMat);
    visor.name = 'visor'; // (names let the avatar station preview just this part)
    visor.position.y = -0.006;
    skull.add(visor);
    const eyesStyle = look ? look.eyes : 'happy';
    [-1, 1].forEach((side) => {
      // Eyes: happy = ^ ^, open = round glowing dots, wink = one dot and one ^.
      const open = eyesStyle === 'open' || (eyesStyle === 'wink' && side < 0);
      const eye = new THREE.Mesh(open ? g.eyeDot : g.eye, eyeMat);
      eye.name = 'eye';
      const az = side * 0.22, el = 0.03, R = 0.17 * 1.045; // just in front of the visor
      eye.position.set(R * Math.sin(az) * Math.cos(el), R * Math.sin(el) - 0.006, R * Math.cos(az) * Math.cos(el));
      eye.rotation.y = az; // face outward from the head
      eye.scale.set(1 / 1.18, (open ? 1.3 : 1) / 0.95, 1); // undo the skull's squash (open eyes a little tall)
      skull.add(eye);
      const ear = new THREE.Mesh(g.ear, accentMat);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(side * 0.195, -0.005, 0);
      head.add(ear);
      const hole = new THREE.Mesh(g.earHole, darkMat);
      hole.rotation.z = Math.PI / 2;
      hole.position.set(side * 0.2, -0.005, 0);
      head.add(hole);
      const fin = new THREE.Mesh(g.fin, accentMat);
      fin.position.set(side * 0.19, 0.085, -0.005);
      fin.rotation.z = side * -0.25;
      fin.scale.set(1, 1, 1.6);
      head.add(fin);
    });
    const hat = look ? look.hat : 'none';
    if (hat === 'none') {
      const top = new THREE.Mesh(g.topBump, shellMat);
      top.position.set(0, 0.165, -0.01);
      head.add(top);
    } else if (hat === 'cowboy') {
      const felt = lam(0xb7773f, { emissive: 0x3a2410, side: THREE.DoubleSide }); // leather brown
      const bandMat = lam(0x5a3a20, { side: THREE.DoubleSide });
      const hatGroup = new THREE.Group();
      hatGroup.name = 'hat';
      hatGroup.position.set(0, 0.165, -0.005);
      hatGroup.rotation.x = -0.12; // tipped back a little
      const brim = new THREE.Mesh(g.brim, felt);
      hatGroup.add(brim);
      const edge = new THREE.Mesh(g.brimEdge, bandMat);
      hatGroup.add(edge);
      const crown = new THREE.Mesh(g.crown, felt);
      crown.position.y = 0.065;
      crown.scale.set(1, 1, 0.82);
      hatGroup.add(crown);
      const top = new THREE.Mesh(g.crownTop, felt);
      top.position.y = 0.125;
      top.scale.set(1, 0.35, 0.82);
      hatGroup.add(top);
      [0.018, 0.034].forEach((y) => { // doubled band, like stitched leather cord
        const band = new THREE.Mesh(g.band, bandMat);
        band.position.y = y;
        band.scale.set(1 - y * 0.6, 1, 0.82);
        hatGroup.add(band);
      });
      head.add(hatGroup);
    } else if (hat === 'headset') {
      const white = lam(0xf2f3f5, { emissive: 0x3a3b40 });
      const black = new THREE.MeshPhongMaterial({ color: 0x15171c, specular: 0x7a8aa0, shininess: 60 });
      const set = new THREE.Group();
      set.name = 'hat';
      set.position.set(0, 0.13, 0.05);
      set.rotation.x = -0.55; // pushed up onto the forehead, so the eyes still show
      const goggles = new THREE.Mesh(g.goggles, white);
      goggles.rotation.z = Math.PI / 2;
      goggles.scale.set(1, 1, 0.75);
      goggles.position.z = 0.08;
      set.add(goggles);
      [-1, 1].forEach((side) => {
        const lens = new THREE.Mesh(g.lens, black);
        lens.position.set(side * 0.055, 0, 0.118);
        set.add(lens);
      });
      head.add(set);
      const strap = new THREE.Mesh(g.strap, lam(0x2a2d34));
      strap.name = 'hatStrap'; // part of the headset, but left out of the station preview
      strap.rotation.x = Math.PI / 2 - 0.5;
      strap.scale.set(1.2, 1.02, 1);
      strap.position.set(0, 0.1, -0.005);
      head.add(strap);
    }

    // Body, badge and arms (turn with yaw only).
    const body = new THREE.Mesh(g.body, shellMat);
    body.scale.set(1.0, 1.12, 0.92);
    body.position.set(0, -0.36, 0);
    bob.add(body);
    const badge = new THREE.Mesh(g.badge, accentMat);
    badge.rotation.z = Math.PI; // point down like a shield
    badge.position.set(0, -0.34, 0.139);
    bob.add(badge);
    const arms = [-1, 1].map((side) => {
      const arm = new THREE.Mesh(g.arm, accentMat);
      arm.scale.set(0.8, 1.55, 0.8);
      arm.position.set(side * 0.17, -0.34, 0.01);
      arm.rotation.z = side * 0.35;
      bob.add(arm);
      return arm;
    });

    // VR hands live in world space (added to the scene separately).
    const hands = [0, 1].map(() => {
      const h = new THREE.Mesh(g.hand, accentMat);
      h.scale.set(1, 0.8, 1.2);
      h.visible = false;
      return h;
    });

    root.scale.setScalar(ROBOT_SCALE);
    return { root, bob, head, arms, hands };
  }

  // Name tag / chat bubble as camera-facing sprites drawn on a canvas.
  function labelSprite(text, { bg = 'rgba(20,22,30,0.82)', fg = '#ffffff', accent = null, fontPx = 44, maxW = 900 } = {}) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.font = font;
    // Wrap into lines.
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    const lh = fontPx * 1.25, padX = 28, padY = 16;
    const w = Math.ceil(Math.min(maxW, Math.max(...lines.map((l) => g.measureText(l).width))) + padX * 2);
    const h = Math.ceil(lines.length * lh + padY * 2);
    c.width = w; c.height = h;
    g.font = font;
    const r = Math.min(26, h / 2);
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect ? g.roundRect(0, 0, w, h, r) : g.rect(0, 0, w, h);
    g.fill();
    if (accent) { g.fillStyle = accent; g.fillRect(0, h - 6, w, 6); }
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, w / 2, padY + lh * (i + 0.5)));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
    const scale = 0.0011; // metres per canvas pixel
    sprite.scale.set(w * scale, h * scale, 1);
    sprite.userData.height = h * scale;
    return sprite;
  }

  // ---------- remote visitors ----------
  const peers = new Map(); // id -> { robot, name, colour, target, cur, lastSeen, tag, bubble }
  let container;

  function ensurePeer(id, meta = {}) {
    let p = peers.get(id);
    const look = normLook(meta.hue !== undefined ? meta : null, hueFor(id));
    if (!p) {
      const robot = makeRobot(look);
      container.add(robot.root);
      robot.hands.forEach((h) => container.add(h));
      p = {
        robot, colour: hueColour(look.hue), look: lookKey(look), name: '', tag: null, bubble: null, bubbleUntil: 0,
        lastSeen: performance.now(), target: null, cur: { x: 0, y: -100, z: 0, yaw: 0, pitch: 0 }, hands: [null, null]
      };
      robot.root.visible = false; // until the first position arrives
      peers.set(id, p);
    } else if (meta.hue !== undefined && lookKey(look) !== p.look) {
      // They changed their look at the avatar station: swap in a new robot in the same spot.
      const old = p.robot;
      const robot = makeRobot(look);
      robot.root.position.copy(old.root.position);
      robot.root.rotation.copy(old.root.rotation);
      robot.root.visible = old.root.visible;
      container.remove(old.root);
      old.hands.forEach((h) => container.remove(h));
      container.add(robot.root);
      robot.hands.forEach((h) => container.add(h));
      if (p.bubble) robot.bob.add(p.bubble);
      p.robot = robot;
      p.colour = hueColour(look.hue);
      p.look = lookKey(look);
      p.name = ''; // re-make the name tag with the new colour
    }
    // Last position saved in presence: use it when the live stream has nothing newer.
    if (Array.isArray(meta.h) && meta.h.length === 3 && meta.h.every(Number.isFinite) &&
        (!p.target || performance.now() - p.lastSeen > 1500)) {
      p.target = { x: meta.h[0], y: meta.h[1], z: meta.h[2], yaw: +meta.yaw || 0, pitch: +meta.pitch || 0 };
      p.lastSeen = performance.now();
      if (!p.robot.root.visible) { Object.assign(p.cur, p.target); p.robot.root.visible = true; }
    }
    if (meta.name !== undefined && cleanName(meta.name) !== p.name) {
      p.name = cleanName(meta.name) || 'Visitor';
      if (p.tag) { p.robot.bob.remove(p.tag); p.tag.material.map.dispose(); p.tag.material.dispose(); }
      p.tag = labelSprite(p.name, { accent: '#' + p.colour.getHexString(), fontPx: 40 });
      p.tag.position.set(0, 0.33, 0);
      p.robot.bob.add(p.tag);
    }
    return p;
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    container.remove(p.robot.root);
    p.robot.hands.forEach((h) => container.remove(h));
    peers.delete(id);
  }

  function showBubble(p, text) {
    if (p.bubble) { p.robot.bob.remove(p.bubble); p.bubble.material.map.dispose(); p.bubble.material.dispose(); }
    p.bubble = labelSprite(text, { bg: 'rgba(255,255,255,0.95)', fg: '#1b1b1f', fontPx: 40, maxW: 700 });
    p.bubble.position.set(0, 0.42 + p.bubble.userData.height / 2, 0);
    p.robot.bob.add(p.bubble);
    p.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  // ---------- chat panel ----------
  let chatLog, chatCount, onSend;
  function buildChat() {
    const wrap = document.createElement('section');
    wrap.id = 'chat';
    wrap.innerHTML = `
      <header>
        <span id="chat-count">Just you</span>
        <label class="chat-name">You: <input id="chat-name" maxlength="24" aria-label="Your name"></label>
        <button type="button" id="chat-toggle" aria-label="Hide chat">–</button>
      </header>
      <ol id="chat-log" aria-live="polite"></ol>
      <form id="chat-form">
        <input id="chat-input" maxlength="${MAX_CHAT}" placeholder="Say something… (Enter)" autocomplete="off">
        <button type="submit">Send</button>
      </form>`;
    document.body.appendChild(wrap);
    chatLog = wrap.querySelector('#chat-log');
    chatCount = wrap.querySelector('#chat-count');
    const nameInput = wrap.querySelector('#chat-name');
    nameInput.value = myName;
    nameInput.addEventListener('change', () => {
      myName = cleanName(nameInput.value) || myName;
      nameInput.value = myName;
      store.set('museum-visitor-name', myName);
      track();
    });
    wrap.querySelector('#chat-toggle').addEventListener('click', (e) => {
      wrap.classList.toggle('collapsed');
      e.target.textContent = wrap.classList.contains('collapsed') ? '+' : '–';
      e.target.blur();
    });
    const input = wrap.querySelector('#chat-input');
    wrap.querySelector('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT);
      if (!text) return;
      if (onSend(text)) input.value = '';
    });
    // Enter (when not typing elsewhere) jumps to the chat box; Escape leaves it.
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === 'Enter' && !typing) { wrap.classList.remove('collapsed'); input.focus(); e.preventDefault(); }
      if (e.key === 'Escape' && t === input) input.blur();
    });
  }

  function addChatLine(name, colour, text, self = false) {
    if (!chatLog) return;
    const li = document.createElement('li');
    if (self) li.className = 'self';
    const who = document.createElement('b');
    who.textContent = name;
    who.style.color = '#' + colour.getHexString();
    const msg = document.createElement('span');
    msg.textContent = ' ' + text; // textContent: never interpreted as HTML
    li.append(who, msg);
    chatLog.appendChild(li);
    while (chatLog.children.length > 80) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function systemLine(text) {
    if (!chatLog) return; // chat not open yet (still choosing a nickname)
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    chatLog.appendChild(li);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- messages inside VR ----------
  // Web-page overlays (like the nickname card) can't be seen inside a headset,
  // so important notices are also shown as a floating label in front of you.
  let toast = null;
  function vrToast(text, ms = 6000) {
    const camEl = document.querySelector('#camera');
    if (!camEl) return;
    if (toast) { camEl.object3D.remove(toast); toast.material.map.dispose(); toast.material.dispose(); }
    toast = labelSprite(text, { fontPx: 38, maxW: 820 });
    toast.position.set(0, -0.18, -0.9);
    toast.renderOrder = 999;
    toast.material.depthTest = false; // always readable, even near walls
    camEl.object3D.add(toast);
    const mine = toast;
    setTimeout(() => {
      if (toast !== mine) return;
      camEl.object3D.remove(mine);
      mine.material.map.dispose();
      mine.material.dispose();
      toast = null;
    }, ms);
  }
  const inVR = () => document.querySelector('a-scene').is('vr-mode');

  // ---------- nickname prompt ----------
  // Shown when someone enters: pick the name others see above your robot.
  // Pre-filled with last visit's name, so returning visitors just press Enter.
  function askNickname(colour) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'nick-overlay';
      overlay.innerHTML = `
        <form id="nick-card" role="dialog" aria-modal="true" aria-labelledby="nick-title">
          <div class="nick-dot" aria-hidden="true"></div>
          <h2 id="nick-title">Welcome to the museum</h2>
          <p>Choose a nickname. It floats above your robot so other visitors know who you are.</p>
          <input id="nick-input" maxlength="24" autocomplete="nickname" aria-label="Nickname" required>
          <p class="nick-error" id="nick-error" role="alert"></p>
          <button type="submit">Enter the museum</button>
        </form>`;
      document.body.appendChild(overlay);
      overlay.querySelector('.nick-dot').style.background = '#' + colour.getHexString();
      const input = overlay.querySelector('#nick-input');
      const saved = cleanName(store.get('museum-visitor-name'));
      input.value = saved;
      input.placeholder = myName;
      setTimeout(() => { input.focus(); input.select(); }, 50);
      const scene = document.querySelector('a-scene');
      const finish = (name) => {
        myName = name;
        store.set('museum-visitor-name', myName);
        overlay.remove();
        scene.removeEventListener('enter-vr', onEnterVR);
        resolve(myName);
      };
      // Went into VR without answering (the card can't be seen in a headset):
      // join with what was typed, the saved name, or a generated one.
      const onEnterVR = () => {
        const name = cleanName(input.value) || myName;
        finish(name);
        setTimeout(() => vrToast(`You're "${name}" here. To change it, take off the headset and edit the name in the chat panel.`, 8000), 600);
      };
      scene.addEventListener('enter-vr', onEnterVR);
      if (inVR()) onEnterVR();
      overlay.querySelector('#nick-card').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = cleanName(input.value);
        if (!name) {
          overlay.querySelector('#nick-error').textContent = 'Please type a nickname (up to 24 characters).';
          input.focus();
          return;
        }
        finish(name);
      });
    });
  }

  // ---------- realtime ----------
  let channel, track;
  let myPose = null;   // my latest position (also saved in presence)
  let trackedAt = 0;   // when presence was last updated
  let trackedPose = null; // the position presence has
  let isPresent = false; // counted in the museum (not waiting outside)
  const setPresent = (v) => { isPresent = v; };

  async function start() {
    await MuseumStore.ready;
    if (!MuseumStore.configured) return; // no online museum set up: no multiplayer
    // Offline at first: wait until the online museum is reachable (it keeps retrying).
    const online = MuseumStore.online() || await MuseumStore.whenOnline;

    const scene = document.querySelector('a-scene');
    container = new THREE.Group();
    container.name = 'visitors';
    scene.object3D.add(container);
    let myColour = hueColour(myLook.hue);
    const announced = new Set(); // visitors whose arrival was already shown
    let isAdmin = false;          // logged-in admins skip the visitor limit
    try { isAdmin = await online.isAdmin(); } catch { /* not logged in */ }
    let joinedAt = 0;
    const syncWaiters = [];       // run on every presence update (room checks)

    channel = online.sb.channel('museum-lobby', {
      config: { presence: { key: myId }, broadcast: { self: false } }
    });

    // Presence holds who is here, their look and their last position. The position is also
    // streamed as fast 'pose' broadcasts, but those can pause (a computer tab in the background,
    // a headset busy entering VR), so presence keeps everyone visible where they were last seen.
    track = () => {
      trackedAt = performance.now();
      trackedPose = myPose;
      return channel.track({
        name: myName, color: '#' + myColour.getHexString(), joinedAt, admin: isAdmin, device,
        hue: myLook.hue, hat: myLook.hat, eyes: myLook.eyes,
        ...(myPose ? { h: myPose.h, yaw: myPose.yaw, pitch: myPose.pitch } : {})
      });
    };
    // Changed look at the avatar station: everyone sees the new robot right away.
    lookListeners.push(() => {
      myColour = hueColour(myLook.hue);
      if (isPresent) track();
    });

    // ---- the 10-visitor limit ----
    // Visitors who count: everyone present except logged-in admins.
    const counted = () => Object.entries(channel.presenceState()).filter(([, m]) => m[0] && !m[0].admin);
    const othersInside = () => counted().filter(([id]) => id !== myId).length;
    // If two people take the last place at the same moment, the earlier arrival keeps it.
    const withinLimit = () => {
      const order = counted()
        .map(([id, m]) => ({ id, t: m[0].joinedAt || 0 }))
        .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
      const i = order.findIndex((v) => v.id === myId);
      return i === -1 || i < MAX_VISITORS;
    };

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const ids = Object.keys(state);
      if (chatCount) chatCount.textContent = ids.length <= 1 ? 'Just you' : `${ids.length} people here`;
      ids.filter((id) => id !== myId).forEach((id) => { ensurePeer(id, state[id][0] || {}).inPresence = true; });
      // Gone from presence: wait a little before removing the robot, since a brief reconnect
      // (theirs or ours) also drops them for a moment and made robots flicker.
      [...peers.entries()].forEach(([id, p]) => {
        if (ids.includes(id)) { p.goneSince = 0; return; }
        p.inPresence = false;
        if (!p.goneSince) p.goneSince = performance.now();
      });
      syncWaiters.slice().forEach((f) => f());
      if (present && !isAdmin && !withinLimit()) {
        // Lost a simultaneous race for the last place: step back out and wait.
        present = false;
        setPresent(false);
        channel.untrack();
        systemLine('The museum just filled up. You\'ll be let back in when someone leaves.');
        waitForRoom().then(enterRoom);
      }
    });
    // A name change arrives as leave + join for the same visitor: report it as a rename.
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
      if (key === myId || !newPresences[0]) return;
      const name = cleanName(newPresences[0].name) || 'Someone';
      const known = peers.get(key);
      if (announced.has(key)) {
        if (known && known.name && known.name !== name) systemLine(`${known.name} is now ${name}`);
      } else {
        announced.add(key);
        const dev = newPresences[0].device;
        systemLine(`${name} joined${dev ? ` (on a ${dev})` : ''}`);
      }
    });
    channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      if (key === myId || !leftPresences[0]) return;
      if (channel.presenceState()[key]) return; // still here (renamed)
      announced.delete(key);
      systemLine(`${cleanName(leftPresences[0].name) || 'Someone'} left`);
    });

    channel.on('broadcast', { event: 'pose' }, ({ payload }) => {
      if (!payload || payload.id === myId || !Array.isArray(payload.h)) return;
      const p = ensurePeer(payload.id);
      p.target = { x: payload.h[0], y: payload.h[1], z: payload.h[2], yaw: payload.yaw || 0, pitch: payload.pitch || 0 };
      p.hands = [payload.l || null, payload.r || null];
      p.lastSeen = performance.now();
      if (!p.robot.root.visible) { Object.assign(p.cur, p.target); p.robot.root.visible = true; }
    });

    const recent = new Map(); // sender -> timestamps (simple flood guard)
    channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (!payload || payload.id === myId) return;
      const text = String(payload.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT);
      if (!text) return;
      const now = Date.now();
      const times = (recent.get(payload.id) || []).filter((t) => now - t < 5000);
      if (times.length >= 5) return; // more than 5 messages in 5 s: ignore
      times.push(now);
      recent.set(payload.id, times);
      const p = ensurePeer(payload.id, { name: payload.name });
      addChatLine(p.name || 'Visitor', p.colour, text);
      showBubble(p, text);
    });

    let lastSent = 0;
    onSend = (text) => {
      if (!isPresent) return false; // waiting outside a full museum
      const now = Date.now();
      if (now - lastSent < 800) return false; // gentle rate limit
      lastSent = now;
      channel.send({ type: 'broadcast', event: 'chat', payload: { id: myId, name: myName, text } });
      addChatLine(myName, myColour, text, true);
      return true;
    };

    // Waiting card while the museum is full; resolves when there's room.
    function waitForRoom() {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'nick-overlay';
        overlay.innerHTML = `
          <div id="nick-card" role="dialog" aria-modal="true" aria-labelledby="full-title">
            <div class="nick-dot" aria-hidden="true"></div>
            <h2 id="full-title">The museum is full</h2>
            <p id="full-count"></p>
            <p>You'll be let in automatically as soon as someone leaves. Keep this page open.</p>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.nick-dot').style.background = '#' + myColour.getHexString();
        const scene = document.querySelector('a-scene');
        const vrNote = () => vrToast(`The museum is full (${MAX_VISITORS} visitors). You'll join automatically when someone leaves.`, 10000);
        scene.addEventListener('enter-vr', vrNote);
        if (inVR()) vrNote();
        const check = () => {
          const n = othersInside();
          overlay.querySelector('#full-count').textContent = `${Math.min(n, MAX_VISITORS)} of ${MAX_VISITORS} visitors are inside right now.`;
          if (n < MAX_VISITORS) {
            syncWaiters.splice(syncWaiters.indexOf(check), 1);
            scene.removeEventListener('enter-vr', vrNote);
            overlay.remove();
            if (inVR()) vrToast("A place opened up: you're in the museum now.", 5000);
            resolve();
          }
        };
        syncWaiters.push(check);
        check();
      });
    }

    let present = false; // tracked in presence = counted, visible and able to chat
    function enterRoom() {
      joinedAt = Date.now();
      present = true;
      setPresent(true);
      track();
    }

    let subscribed;
    const subscribedOnce = new Promise((res) => { subscribed = res; });
    let firstSync;
    const firstSyncOnce = new Promise((res) => { firstSync = res; setTimeout(res, 4000); });
    syncWaiters.push(() => firstSync());

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        subscribed();
        if (present) track(); // reconnected: show up again
      }
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && chatLog) systemLine('Chat connection problem, retrying…');
    });

    // Entry: check there's room, ask for a nickname, then appear to everyone.
    await subscribedOnce;
    await firstSyncOnce;
    if (!isAdmin && othersInside() >= MAX_VISITORS) await waitForRoom();
    await askNickname(myColour);
    buildChat();
    if (!isAdmin && othersInside() >= MAX_VISITORS) {
      systemLine('Someone took the last place while you were choosing a name.');
      await waitForRoom();
    }
    enterRoom();
    systemLine(`Connected as ${myName}. Press Enter to chat.${isAdmin ? ' (Admins don\'t count toward the visitor limit.)' : ''}`);
    const others = Object.entries(channel.presenceState())
      .filter(([id]) => id !== myId)
      .map(([id, metas]) => { announced.add(id); return cleanName(metas[0] && metas[0].name) || 'Visitor'; });
    if (others.length) systemLine(`Here now: ${others.join(', ')}`);

    startPoseLoop(scene);
    animate(scene);
  }

  // A steady tick that keeps going in a background tab. Browsers slow ordinary timers in hidden
  // tabs right down (to once a minute after about 5 minutes), which froze a computer visitor
  // for everyone in VR while they had the headset on. Timers inside a worker aren't slowed.
  function steadyTick(fn, ms) {
    try {
      const src = `setInterval(() => postMessage(0), ${Math.max(16, Math.round(ms))});`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = fn;
      return;
    } catch (e) { /* no workers: fall back to a normal timer */ }
    setInterval(fn, ms);
  }

  // Send my head (and VR hands) position, only when it changes noticeably.
  function startPoseLoop(scene) {
    const cam = document.querySelector('#camera');
    const pos = new THREE.Vector3(), fwd = new THREE.Vector3();
    const hand = new THREE.Vector3();
    let last = null, lastAt = 0;
    const r2 = (n) => Math.round(n * 100) / 100;
    steadyTick(() => {
      if (!channel || !isPresent) return; // invisible to others until named and let in
      cam.object3D.getWorldPosition(pos);
      cam.object3D.getWorldDirection(fwd).negate(); // the camera entity looks down -z
      const yaw = Math.atan2(fwd.x, fwd.z);
      const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
      const payload = { id: myId, h: [r2(pos.x), r2(pos.y), r2(pos.z)], yaw: r2(yaw), pitch: r2(pitch) };
      if (scene.is('vr-mode')) {
        ['#leftHand', '#rightHand'].forEach((sel, i) => {
          const el = document.querySelector(sel);
          if (el && el.object3D.visible) {
            el.object3D.getWorldPosition(hand);
            payload[i ? 'r' : 'l'] = [r2(hand.x), r2(hand.y), r2(hand.z)];
          }
        });
      }
      const now = performance.now();
      const moved = !last || Math.hypot(payload.h[0] - last.h[0], payload.h[1] - last.h[1], payload.h[2] - last.h[2]) > 0.02 ||
        Math.abs(payload.yaw - last.yaw) > 0.03 || Math.abs(payload.pitch - last.pitch) > 0.03 || payload.l || payload.r;
      if (moved || now - lastAt > HEARTBEAT_MS) {
        channel.send({ type: 'broadcast', event: 'pose', payload });
        last = payload;
        lastAt = now;
      }
      // Also save the position in presence (at most every few seconds) when it has changed
      // since the last save, including the spot where you stopped.
      myPose = payload;
      const saved = trackedPose;
      const drifted = !saved || Math.hypot(payload.h[0] - saved.h[0], payload.h[1] - saved.h[1], payload.h[2] - saved.h[2]) > 0.1 ||
        Math.abs(Math.atan2(Math.sin(payload.yaw - saved.yaw), Math.cos(payload.yaw - saved.yaw))) > 0.2;
      if (drifted && now - trackedAt > PRESENCE_POSE_MS) track();
    }, 1000 / SEND_HZ);
    // Going to the background (another window, the screen sleeping, putting on a headset):
    // timers slow right down, so save where we are in presence now.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && channel && isPresent) track();
    });
  }

  // Smoothly move every robot toward its latest position; float, wave, expire.
  // Runs on A-Frame's own frame loop, which keeps going inside VR (window
  // requestAnimationFrame pauses during an immersive session).
  function animate(scene) {
    let prev = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const k = 1 - Math.exp(-dt * 10);
      peers.forEach((p, id) => {
        const { robot } = p;
        // Still in presence = still in the museum: keep them where they were last seen,
        // even if their position updates have paused.
        if (!p.inPresence && now - p.lastSeen > STALE_MS) robot.root.visible = false;
        if (p.goneSince && now - p.goneSince > LEAVE_GRACE_MS && now - p.lastSeen > LEAVE_GRACE_MS) {
          removePeer(id); // really left
          return;
        }
        if (!p.target || !robot.root.visible) return;
        const c = p.cur, t = p.target;
        c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k; c.z += (t.z - c.z) * k;
        let dy = t.yaw - c.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        c.yaw += dy * k;
        c.pitch += (t.pitch - c.pitch) * k;
        robot.root.position.set(c.x, c.y, c.z);
        robot.root.rotation.y = c.yaw;
        robot.head.rotation.x = -c.pitch * 0.7;
        const phase = (id.charCodeAt(0) || 0) * 0.37;
        robot.bob.position.y = Math.sin(now / 700 + phase) * 0.015;
        robot.arms.forEach((a, i) => { a.rotation.x = Math.sin(now / 900 + phase + i * Math.PI) * 0.15; });
        robot.hands.forEach((h, i) => {
          const v = p.hands[i];
          h.visible = !!v;
          if (v) h.position.set(v[0], v[1], v[2]);
        });
        // Hide the hanging arms when VR hands are shown.
        robot.arms.forEach((a) => { a.visible = !p.hands[0] && !p.hands[1]; });
        if (p.bubble && now > p.bubbleUntil) {
          robot.bob.remove(p.bubble);
          p.bubble.material.map.dispose();
          p.bubble.material.dispose();
          p.bubble = null;
        }
      });
    };
    frameStep = step;
  }

  // A-Frame system: runs every frame (also inside VR) and drives the robots.
  let frameStep = null;
  AFRAME.registerSystem('visitor-avatars', {
    tick() { if (frameStep) frameStep(); }
  });

  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    const go = () => start().catch((err) => console.warn('Multiplayer could not start', err));
    if (scene.hasLoaded) go(); else scene.addEventListener('loaded', go, { once: true });
  });

  // The avatar station (js/user-exhibits.js) uses this to preview and change your look.
  window.MuseumAvatar = {
    HATS, EYES, hueColour, makeRobot,
    get look() { return { ...myLook }; },
    setLook(changes) {
      const next = normLook({ ...myLook, ...changes }, myLook.hue);
      if (lookKey(next) === lookKey(myLook)) return;
      myLook = next;
      store.set('museum-avatar', JSON.stringify(myLook)); // remembered for next time
      lookListeners.slice().forEach((f) => f(myLook));
    },
    onChange(f) { lookListeners.push(f); return () => lookListeners.splice(lookListeners.indexOf(f), 1); }
  };

  // For debugging in the console.
  window.MuseumVisitors = { peers, get id() { return myId; }, get name() { return myName; } };
})();
