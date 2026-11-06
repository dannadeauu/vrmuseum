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
  const STALE_MS = 15000;      // hide a robot that hasn't been heard from for this long
  const BUBBLE_MS = 7000;      // how long a chat bubble stays above a robot
  const MAX_CHAT = 200;        // characters per message
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
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  let myName = cleanName(store.get('museum-visitor-name')) || `Visitor ${Math.floor(10 + Math.random() * 90)}`;

  // Colour from the id: golden-angle hues keep neighbours distinct.
  function colourFor(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = (h * 137.508) % 360;
    return new THREE.Color().setHSL(hue / 360, 0.72, 0.52);
  }

  // ---------- the robot ----------
  const shared = {}; // geometries reused by every robot
  function geo() {
    if (shared.head) return shared;
    const ico = (r, d) => new THREE.IcosahedronGeometry(r, d);
    shared.head = ico(0.17, 1);
    shared.visor = ico(0.13, 1);
    shared.eye = new THREE.TorusGeometry(0.03, 0.009, 4, 8, Math.PI);
    shared.ear = new THREE.CylinderGeometry(0.055, 0.055, 0.06, 8);
    shared.earHole = new THREE.CylinderGeometry(0.022, 0.022, 0.062, 6);
    shared.fin = new THREE.BoxGeometry(0.035, 0.11, 0.06);
    shared.topBump = new THREE.CylinderGeometry(0.05, 0.065, 0.045, 6);
    shared.body = ico(0.15, 1);
    shared.badge = new THREE.CircleGeometry(0.055, 5);
    shared.arm = ico(0.055, 0);
    shared.hand = ico(0.05, 1);
    return shared;
  }

  function makeRobot(colour) {
    const g = geo();
    const shell = new THREE.Color(0xffffff).lerp(colour, 0.38);   // tinted body
    const accent = colour.clone();                                // ears, fins, badge, arms
    const lam = (c, extra = {}) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...extra });
    // A soft self-glow keeps the robots bright and clean whichever way the room light falls.
    const shellMat = lam(shell, { emissive: shell.clone().multiplyScalar(0.55) });
    const accentMat = lam(accent, { emissive: accent.clone().multiplyScalar(0.35) });
    const visorMat = lam(0x0d1f6e, { emissive: 0x1636b8, emissiveIntensity: 0.55 });
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
    const visor = new THREE.Mesh(g.visor, visorMat);
    visor.scale.set(1.12, 0.66, 0.55);
    visor.position.set(0, -0.005, 0.1);
    head.add(visor);
    [-1, 1].forEach((side) => {
      const eye = new THREE.Mesh(g.eye, eyeMat); // upside-down "U": a happy ^ eye
      eye.position.set(side * 0.052, 0.0, 0.172);
      head.add(eye);
      const ear = new THREE.Mesh(g.ear, accentMat);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(side * 0.195, -0.005, 0);
      head.add(ear);
      const hole = new THREE.Mesh(g.earHole, darkMat);
      hole.rotation.z = Math.PI / 2;
      hole.position.set(side * 0.2, -0.005, 0);
      head.add(hole);
      const fin = new THREE.Mesh(g.fin, accentMat);
      fin.position.set(side * 0.19, 0.08, -0.005);
      fin.rotation.z = side * -0.25;
      head.add(fin);
    });
    const top = new THREE.Mesh(g.topBump, shellMat);
    top.position.set(0, 0.165, -0.01);
    head.add(top);

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
      arm.scale.set(0.85, 1.6, 0.85);
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
    if (!p) {
      const colour = colourFor(id);
      const robot = makeRobot(colour);
      container.add(robot.root);
      robot.hands.forEach((h) => container.add(h));
      p = {
        robot, colour, name: '', tag: null, bubble: null, bubbleUntil: 0, lastSeen: performance.now(),
        target: null, cur: { x: 0, y: -100, z: 0, yaw: 0, pitch: 0 }, hands: [null, null]
      };
      robot.root.visible = false; // until the first position arrives
      peers.set(id, p);
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
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    chatLog.appendChild(li);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- realtime ----------
  let channel, track;

  async function start() {
    await MuseumStore.ready;
    const online = MuseumStore.online();
    if (!online) return; // offline: no multiplayer

    const scene = document.querySelector('a-scene');
    container = new THREE.Group();
    container.name = 'visitors';
    scene.object3D.add(container);
    const myColour = colourFor(myId);
    buildChat();

    channel = online.sb.channel('museum-lobby', {
      config: { presence: { key: myId }, broadcast: { self: false } }
    });

    track = () => channel.track({ name: myName, color: '#' + myColour.getHexString() });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const ids = Object.keys(state);
      chatCount.textContent = ids.length <= 1 ? 'Just you' : `${ids.length} people here`;
      ids.filter((id) => id !== myId).forEach((id) => ensurePeer(id, state[id][0] || {}));
      [...peers.keys()].forEach((id) => { if (!ids.includes(id)) removePeer(id); });
    });
    const announced = new Set(); // visitors whose arrival was already shown
    // A name change arrives as leave + join for the same visitor: report it as a rename.
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
      if (key === myId || !newPresences[0]) return;
      const name = cleanName(newPresences[0].name) || 'Someone';
      const known = peers.get(key);
      if (announced.has(key)) {
        if (known && known.name && known.name !== name) systemLine(`${known.name} is now ${name}`);
      } else {
        announced.add(key);
        systemLine(`${name} joined`);
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
      const now = Date.now();
      if (now - lastSent < 800) return false; // gentle rate limit
      lastSent = now;
      channel.send({ type: 'broadcast', event: 'chat', payload: { id: myId, name: myName, text } });
      addChatLine(myName, myColour, text, true);
      return true;
    };

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { track(); systemLine('Connected. Press Enter to chat.'); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') systemLine('Chat connection problem, retrying…');
    });

    startPoseLoop(scene);
    animate(scene);
  }

  // Send my head (and VR hands) position, only when it changes noticeably.
  function startPoseLoop(scene) {
    const cam = document.querySelector('#camera');
    const pos = new THREE.Vector3(), fwd = new THREE.Vector3();
    const hand = new THREE.Vector3();
    let last = null, lastAt = 0;
    const r2 = (n) => Math.round(n * 100) / 100;
    setInterval(() => {
      if (!channel) return;
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
    }, 1000 / SEND_HZ);
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
        if (now - p.lastSeen > STALE_MS) robot.root.visible = false;
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

  // For debugging in the console.
  window.MuseumVisitors = { peers, get id() { return myId; }, get name() { return myName; } };
})();
