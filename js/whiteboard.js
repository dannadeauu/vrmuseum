/* global AFRAME, THREE, MuseumStore */

/**
 * MuseumBoards: whiteboards anyone can draw on.
 *
 * A whiteboard is an ordinary flat exhibit (framed like a painting, with a plaque; built in
 * js/user-exhibits.js) whose picture is a drawing canvas. Under the frame is a row of
 * controls every visitor can use: colour swatches, an eraser, a brush-size slider (with a dot showing
 * the size), Undo (your own last stroke; also Ctrl/Cmd+Z) and Clear.
 *
 * Drawing works with the mouse (drag on the board), touch, and the VR lasers (hold the
 * trigger). Dragging on a board or the slider doesn't turn the view.
 *
 * Sharing, when the online museum is set up:
 *   - live: strokes stream to everyone through a Supabase Realtime broadcast channel
 *     ("museum-boards"), point by point while they're drawn;
 *   - saved: each finished stroke is a row in museum_board_strokes (see supabase/setup.sql),
 *     so latecomers see the drawing. Clear deletes the board's rows.
 * Offline (no Supabase), drawings are kept in this browser (localStorage).
 *
 * Stroke: { id, c: colour, s: width as a fraction of the board's width, p: [x, y, x, y, ...] }
 * with x, y from 0 to 1 (top-left origin).
 */
window.MuseumBoards = (() => {
  // Black plus the museum palette: Ocean, Forrest, Skyline, Tangerine, Toffee, Salsa.
  const COLOURS = ['#1b1b1f', '#4b8299', '#44724f', '#99bfdf', '#e99e26', '#da682f', '#db3100'];
  const ERASER = 'erase';     // a stroke "colour" that paints the clean board back
  const ERASER_SCALE = 3;     // the eraser is three times as wide as the pen at the same setting
  const BRUSH_MIN = 0.004, BRUSH_MAX = 0.05; // stroke width in metres
  const MAX_POINTS = 900;                    // long strokes are split (keeps each saved row small)
  const MIN_STEP = 0.0025;                   // ignore movements smaller than this (fraction of board)
  const SEND_EVERY = 60;                     // ms between live updates while drawing
  const TABLE = 'museum_board_strokes';
  const LOCAL_KEY = 'museum-board-';

  // This visitor's brush, shared by every board.
  const brush = { colour: COLOURS[0], t: 0.25 };
  const brushMetres = () => (BRUSH_MIN + brush.t * (BRUSH_MAX - BRUSH_MIN)) * (brush.colour === ERASER ? ERASER_SCALE : 1);
  const uiListeners = new Set();
  const notifyUi = () => uiListeners.forEach((f) => f());

  // ------------------------------------------------------------------ board state

  const boards = new Map(); // id -> { id, aspect, canvas, ctx, tex, strokes, live, loaded, dirty }

  function boardState(id, aspect) {
    let b = boards.get(id);
    if (b && Math.abs(b.aspect - aspect) > 1e-3) { b.tex.dispose(); boards.delete(id); b = null; }
    if (b) return b;
    const W = aspect <= 1 ? 1024 : Math.round(1024 / aspect);
    const H = Math.round(W * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // The clean board, kept separately: the eraser paints with it (so the sheen comes back too).
    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const g = bg.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    const sheen = g.createLinearGradient(0, 0, W, H); // faint gloss, so it reads as a whiteboard, not paper
    sheen.addColorStop(0, 'rgba(235,238,242,0.0)'); sheen.addColorStop(0.5, 'rgba(235,238,242,0.55)'); sheen.addColorStop(1, 'rgba(235,238,242,0.0)');
    g.fillStyle = sheen; g.fillRect(0, 0, W, H);
    b = { id, aspect, canvas, ctx, tex, bg, erasePaint: ctx.createPattern(bg, 'no-repeat'), strokes: [], live: new Map(), dirty: true };
    boards.set(id, b);
    redraw(b);
    b.loaded = loadStrokes(b);
    return b;
  }

  function redraw(b) {
    const { ctx } = b;
    ctx.drawImage(b.bg, 0, 0);
    b.strokes.forEach((s) => drawStroke(b, s, 0));
    b.live.forEach((s) => drawStroke(b, s, 0));
    b.dirty = true;
  }

  // Draw a stroke from point index `from` (0 = all of it).
  function drawStroke(b, s, from) {
    const { ctx, canvas } = b;
    const W = canvas.width, H = canvas.height, p = s.p;
    if (p.length < 2) return;
    const paint = s.c === ERASER ? b.erasePaint : s.c;
    ctx.strokeStyle = paint; ctx.fillStyle = paint;
    ctx.lineWidth = Math.max(1, s.s * W);
    if (p.length === 2) { // a single dot
      ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      const start = Math.max(0, from - 2);
      ctx.beginPath();
      ctx.moveTo(p[start] * W, p[start + 1] * H);
      for (let i = start + 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
      ctx.stroke();
    }
    b.dirty = true;
  }

  // ------------------------------------------------------------------ saving and sharing

  let channel = null, tableOk = true;
  const online = () => (MuseumStore.mode === 'online' ? MuseumStore.online() : null);

  function connect() {
    const o = online();
    if (channel || !o) return;
    channel = o.sb.channel('museum-boards', { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'pt' }, ({ payload: m }) => {
      const b = boards.get(m.b);
      if (!b) return;
      let s = b.live.get(m.id);
      if (!s) { s = { id: m.id, c: m.c, s: m.s, p: [] }; b.live.set(m.id, s); }
      const from = s.p.length;
      s.p.push(...m.p);
      drawStroke(b, s, from);
    });
    channel.on('broadcast', { event: 'end' }, ({ payload: m }) => {
      const b = boards.get(m.b);
      const s = b && b.live.get(m.id);
      if (!s) return;
      b.live.delete(m.id);
      if (!b.strokes.some((x) => x.id === s.id)) b.strokes.push(s);
    });
    channel.on('broadcast', { event: 'undo' }, ({ payload: m }) => {
      const b = boards.get(m.b);
      if (b && Array.isArray(m.ids)) removeStrokes(b, m.ids);
    });
    channel.on('broadcast', { event: 'clear' }, ({ payload: m }) => {
      history.delete(m.b); // nothing of ours left to undo there
      notifyUi();
      const b = boards.get(m.b);
      if (!b) return;
      b.strokes = []; b.live.clear();
      redraw(b);
    });
    channel.subscribe();
  }
  const send = (event, payload) => { if (channel) channel.send({ type: 'broadcast', event, payload }); };

  async function loadStrokes(b) {
    await MuseumStore.ready;
    const o = online();
    let saved = [];
    if (o) {
      connect();
      const { data, error } = await o.sb.from(TABLE).select('stroke').eq('board_id', b.id).order('created_at');
      if (error) { tableMissing(error); } else saved = data.map((r) => r.stroke);
    } else {
      try { saved = JSON.parse(localStorage.getItem(LOCAL_KEY + b.id) || '[]'); } catch (e) { saved = []; }
    }
    const have = new Set(b.strokes.map((s) => s.id));
    b.strokes = saved.filter((s) => s && Array.isArray(s.p) && !have.has(s.id)).concat(b.strokes);
    redraw(b);
  }

  // Started offline, then connected: show the shared drawings instead of this browser's.
  MuseumStore.onOnline(() => {
    connect();
    for (const b of boards.values()) {
      b.strokes = []; b.live.clear();
      history.delete(b.id);
      b.loaded = loadStrokes(b);
    }
    notifyUi();
  });

  function tableMissing(error) {
    if (!tableOk) return;
    tableOk = false;
    console.warn('Whiteboards: drawings are shared live but not saved. Run supabase/setup.sql again to add the ' +
      TABLE + ' table.', error);
  }

  function saveLocal(b) {
    try { localStorage.setItem(LOCAL_KEY + b.id, JSON.stringify(b.strokes.slice(-1500))); } catch (e) { /* full or private mode */ }
  }

  async function saveStroke(b, s) {
    const o = online();
    if (!o) { saveLocal(b); return; }
    if (!tableOk) return;
    const done = o.sb.from(TABLE).insert({ board_id: b.id, stroke: s }).then(({ error }) => { if (error) tableMissing(error); });
    saving.set(s.id, done);
    await done;
    saving.delete(s.id);
  }
  const saving = new Map(); // stroke id -> insert still in flight

  async function clearBoard(id, { broadcast = true } = {}) {
    history.delete(id);
    notifyUi();
    const b = boards.get(id);
    if (b) { b.strokes = []; b.live.clear(); redraw(b); }
    if (broadcast) send('clear', { b: id });
    const o = online();
    if (!o) { try { localStorage.removeItem(LOCAL_KEY + id); } catch (e) { /* ignore */ } return; }
    if (!tableOk) return;
    const { error } = await o.sb.from(TABLE).delete().eq('board_id', id);
    if (error) tableMissing(error);
  }

  // ------------------------------------------------------------------ undo (this visitor's own strokes)
  // Per board, a stack of this visitor's gestures (one press-drag-release; very long ones are
  // several strokes). Undo takes back the latest gesture, eraser gestures included, for everyone.
  // Kept for this visit only.
  const history = new Map(); // board id -> [[stroke ids], ...]
  let lastBoard = null;      // for Ctrl/Cmd+Z
  const canUndo = (id) => !!(history.get(id) || []).length;

  function removeStrokes(b, ids) {
    const gone = new Set(ids);
    const before = b.strokes.length;
    b.strokes = b.strokes.filter((s) => !gone.has(s.id));
    ids.forEach((i) => b.live.delete(i));
    if (b.strokes.length !== before) redraw(b);
  }

  async function undo(id) {
    const stack = history.get(id);
    if (!stack || !stack.length || (mine && mine.b.id === id)) return; // nothing to undo, or still drawing
    const ids = stack.pop();
    notifyUi();
    const b = boards.get(id);
    if (b) removeStrokes(b, ids);
    send('undo', { b: id, ids });
    const o = online();
    if (!o) { if (b) saveLocal(b); return; }
    if (!tableOk) return;
    await Promise.all(ids.map((i) => saving.get(i)).filter(Boolean)); // let their saves land first
    const { error } = await o.sb.from(TABLE).delete().eq('board_id', id).in('stroke->>id', ids);
    if (error) tableMissing(error);
  }

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || !lastBoard) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // let fields undo text
    if (blocked() || !canUndo(lastBoard)) return;
    e.preventDefault();
    undo(lastBoard);
  });

  // ------------------------------------------------------------------ drawing (this visitor)

  let mine = null; // { b, s, sentTo, lastSend }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // `more`: carrying on the same gesture (a long stroke being split, or back onto the board mid-drag).
  function penDown(b, boardWidth, x, y, more = false) {
    if (!more || !history.get(b.id)) {
      if (!history.has(b.id)) history.set(b.id, []);
      history.get(b.id).push([]);
    }
    lastBoard = b.id;
    const s = { id: newId(), c: brush.colour, s: +(brushMetres() / boardWidth).toFixed(4), p: [r4(x), r4(y)] };
    mine = { b, s, boardWidth, sentTo: 0, lastSend: 0 };
    b.live.set(s.id, s);
    drawStroke(b, s, 0);
    flush(true);
  }
  function penMove(x, y) {
    if (!mine) return;
    const p = mine.s.p;
    const dx = x - p[p.length - 2], dy = y - p[p.length - 1];
    if (Math.hypot(dx, dy * mine.b.aspect) < MIN_STEP) return;
    const from = p.length;
    p.push(r4(x), r4(y));
    drawStroke(mine.b, mine.s, from);
    if (p.length / 2 >= MAX_POINTS) { // split very long strokes, carrying on seamlessly
      const { b, boardWidth } = mine;
      penUp();
      penDown(b, boardWidth, x, y, true);
    }
  }
  function penUp() {
    if (!mine) return;
    flush(true);
    const { b, s } = mine;
    mine = null;
    b.live.delete(s.id);
    b.strokes.push(s);
    const stack = history.get(b.id);
    if (stack && stack.length) stack[stack.length - 1].push(s.id);
    notifyUi();
    send('end', { b: b.id, id: s.id });
    saveStroke(b, s);
  }
  function flush(force) {
    if (!mine) return;
    const now = performance.now();
    if (!force && now - mine.lastSend < SEND_EVERY) return;
    const { s, b } = mine;
    if (mine.sentTo >= s.p.length) return;
    send('pt', { b: b.id, id: s.id, c: s.c, s: s.s, p: s.p.slice(mine.sentTo) });
    mine.sentTo = s.p.length;
    mine.lastSend = now;
  }
  const r4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

  // ------------------------------------------------------------------ pointer handling
  // "Surfaces" take drags: each board, and each brush-size slider.
  // { el, mesh(): THREE.Mesh, down(uv), move(uv | null), up() }
  const surfaces = new Set();
  let drag = null; // { surface, kind: 'mouse' | 'touch' | 'hand', hand? }

  const scene = () => document.querySelector('a-scene');
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const MAX_REACH = 9; // metres

  function rayFrom(x, y) {
    const sc = scene();
    const rect = sc.canvas.getBoundingClientRect();
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, sc.camera);
    ray.camera = sc.camera;
  }

  // The surface under the pointer, if nothing else is in front of it.
  function surfaceAt(x, y) {
    pruneSurfaces();
    if (!surfaces.size) return null;
    rayFrom(x, y);
    const objs = [...document.querySelectorAll('.clickable, .placeable')].map((e) => e.object3D);
    const hit = ray.intersectObjects(objs, true)
      .find((h) => !(h.object.userData.isHole && h.object.userData.isHole(h.point)) && !h.object.isSprite);
    if (!hit || hit.distance > MAX_REACH) return null;
    for (const s of surfaces) if (s.mesh() === hit.object) return { surface: s, uv: hit.uv };
    return null;
  }
  function uvOn(surface, x, y) {
    rayFrom(x, y);
    const m = surface.mesh();
    const hit = m && ray.intersectObject(m, false)[0];
    return hit ? hit.uv : null;
  }

  const blocked = () => { const sc = scene(); return !sc || sc.is('admin-mode'); };

  function onPointerStart(e) {
    const sc = scene();
    if (drag || blocked() || e.target !== sc.canvas) return;
    if (e.type === 'mousedown' && e.button !== 0) return;
    const pt = e.touches ? e.touches[0] : e;
    const found = surfaceAt(pt.clientX, pt.clientY);
    if (!found) return;
    // Ours: don't let the view turn or the cursor click.
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    drag = { surface: found.surface, kind: e.touches ? 'touch' : 'mouse' };
    found.surface.down(found.uv);
  }
  function onPointerMove(e) {
    if (!drag || drag.kind === 'hand') return;
    const pt = e.touches ? e.touches[0] : e;
    if (!pt) return;
    drag.surface.move(uvOn(drag.surface, pt.clientX, pt.clientY));
    if (e.cancelable && e.touches) e.preventDefault();
  }
  function onPointerEnd() {
    if (!drag || drag.kind === 'hand') return;
    const d = drag;
    drag = null;
    d.surface.up();
  }
  window.addEventListener('mousedown', onPointerStart, true);
  window.addEventListener('touchstart', onPointerStart, { capture: true, passive: false });
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('mouseup', onPointerEnd);
  window.addEventListener('touchend', onPointerEnd);
  window.addEventListener('blur', onPointerEnd);

  // VR lasers: hold the trigger to draw (or to drag the slider).
  function handHit(hand) {
    const rc = hand.components.raycaster;
    if (!rc) return null;
    pruneSurfaces();
    for (const s of surfaces) {
      const hit = rc.getIntersection(s.el);
      if (hit && hit.object === s.mesh()) return { surface: s, uv: hit.uv, hit };
    }
    return null;
  }
  function bindHands() {
    ['#leftHand', '#rightHand'].forEach((sel) => {
      const hand = document.querySelector(sel);
      if (!hand) return;
      hand.addEventListener('triggerdown', () => {
        if (drag || blocked()) return;
        const rc = hand.components.raycaster;
        const first = rc && rc.intersections[0];
        const found = handHit(hand);
        if (!found || (first && first.object !== found.hit.object)) return; // something else in front
        drag = { surface: found.surface, kind: 'hand', hand };
        found.surface.down(found.uv);
      });
      hand.addEventListener('triggerup', () => {
        if (!drag || drag.hand !== hand) return;
        const d = drag;
        drag = null;
        d.surface.up();
      });
    });
  }

  AFRAME.registerSystem('whiteboards', {
    init() {
      if (this.el.hasLoaded) bindHands(); else this.el.addEventListener('loaded', bindHands, { once: true });
    },
    tick() {
      if (drag && drag.kind === 'hand') {
        const hit = drag.hand.components.raycaster && drag.hand.components.raycaster.getIntersection(drag.surface.el);
        drag.surface.move(hit && hit.object === drag.surface.mesh() ? hit.uv : null);
      }
      flush(false);
      boards.forEach((b) => { if (b.dirty) { b.tex.needsUpdate = true; b.dirty = false; } });
    }
  });

  // ------------------------------------------------------------------ building a board

  function entity(geometry, material, pos, cls) {
    const e = document.createElement('a-entity');
    if (geometry) e.setAttribute('geometry', geometry);
    if (material) e.setAttribute('material', material);
    if (pos) e.setAttribute('position', pos);
    if (cls) e.classList.add(cls);
    return e;
  }

  // The eraser swatch: a classic two-tone block eraser on a white disc.
  let eraserUrl;
  function eraserIcon() {
    if (eraserUrl) return eraserUrl;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
    g.translate(64, 66);
    g.rotate(-Math.PI / 5);
    g.lineJoin = 'round';
    g.lineWidth = 6; g.strokeStyle = '#1b1b1f';
    g.fillStyle = '#f2a3b3'; g.fillRect(-42, -20, 44, 40);     // pink rubber end
    g.fillStyle = '#4b8299'; g.fillRect(2, -20, 40, 40);       // sleeve (Ocean)
    g.strokeRect(-42, -20, 84, 40);
    g.beginPath(); g.moveTo(2, -20); g.lineTo(2, 20); g.stroke();
    eraserUrl = c.toDataURL();
    return eraserUrl;
  }

  function onClick(e2, fn) {
    e2.addEventListener('click', (e) => {
      if (e2.sceneEl.is('admin-mode')) return; // admins clicking select the board instead
      e.stopPropagation();
      fn();
    });
  }

  // Register a surface; it drops out once its entity has left the scene (board rebuilt or deleted).
  function addSurface(s) {
    surfaces.add(s);
  }
  function pruneSurfaces() {
    surfaces.forEach((s) => { if (s.el.hasLoaded && !s.el.isConnected) surfaces.delete(s); });
  }

  /**
   * Turn a flat exhibit entity into a whiteboard.
   *   el: the exhibit (its plane is the board); r: the record; controlsY: where the controls
   *   row goes (centre, relative to the board's centre).
   */
  function attach(el, r, controlsY) {
    const w = r.size, aspect = r.aspect || 1;
    const b = boardState(r.id, aspect);
    el.addEventListener('loaded', () => {
      const mesh = el.getObject3D('mesh');
      if (mesh) mesh.material = new THREE.MeshBasicMaterial({ map: b.tex });
    }, { once: true });

    // Drawing on the board.
    let drawing = false;
    addSurface({
      el,
      mesh: () => el.getObject3D('mesh'),
      down: (uv) => { drawing = true; penDown(b, w, uv.x, 1 - uv.y); },
      move: (uv) => {
        if (!drawing) return;
        if (!uv) { penUp(); drawing = 'paused'; return; }      // left the board: lift the pen
        if (drawing === 'paused') { drawing = true; penDown(b, w, uv.x, 1 - uv.y, true); return; }
        penMove(uv.x, 1 - uv.y);
      },
      up: () => { if (drawing === true) penUp(); drawing = false; }
    });

    // ---- controls row: colours, brush size, clear
    const row = entity(null, null, `0 ${controlsY} 0.012`);
    const SW = 0.042, STEP = 0.105, TRACK = 0.42;
    const total = COLOURS.length * STEP + SW * 2 + 0.08 + TRACK + 0.06 + 0.16 + 0.06 + 0.22 + 0.04 + 0.24; // colours + eraser … undo, clear
    let x = -total / 2;
    row.appendChild(entity({ primitive: 'plane', width: total + 0.08, height: 0.15 },
      { shader: 'flat', color: '#f4f2ee', opacity: 0.92, transparent: true }, '0 0 -0.002'));

    const rings = [];
    x += SW;
    [...COLOURS, ERASER].forEach((c) => {
      const look = c === ERASER ? { shader: 'flat', src: eraserIcon(), transparent: true } : { shader: 'flat', color: c };
      const sw = entity({ primitive: 'circle', radius: SW, segments: 32 }, look, `${x} 0 0.002`, 'clickable');
      const ring = entity({ primitive: 'ring', radiusInner: SW + 0.008, radiusOuter: SW + 0.017, segmentsTheta: 40 },
        { shader: 'flat', color: '#1b1b1f' }, '0 0 -0.001');
      sw.appendChild(ring);
      rings.push({ c, ring });
      sw.addEventListener('mouseenter', () => sw.object3D.scale.setScalar(1.12));
      sw.addEventListener('mouseleave', () => sw.object3D.scale.setScalar(1));
      onClick(sw, () => { brush.colour = c; notifyUi(); });
      row.appendChild(sw);
      x += STEP;
    });
    x += SW - STEP + 0.08;

    // Brush-size slider: drag (or click) along the track.
    const sx = x + TRACK / 2;
    const slider = entity(null, null, `${sx} 0 0.002`);
    slider.appendChild(entity({ primitive: 'plane', width: TRACK, height: 0.014 }, { shader: 'flat', color: '#c9c3b8' }));
    const fill = entity({ primitive: 'plane', width: 1, height: 0.014 }, { shader: 'flat', color: '#1b1b1f' }, '0 0 0.001');
    slider.appendChild(fill);
    const knob = entity({ primitive: 'circle', radius: 0.026, segments: 32 }, { shader: 'flat', color: '#ffffff' }, '0 0 0.003');
    knob.appendChild(entity({ primitive: 'ring', radiusInner: 0.026, radiusOuter: 0.034, segmentsTheta: 40 }, { shader: 'flat', color: '#1b1b1f' }));
    slider.appendChild(knob);
    const HIT_W = TRACK + 0.06;
    const hit = entity({ primitive: 'plane', width: HIT_W, height: 0.11 },
      { shader: 'flat', color: '#ffffff', opacity: 0, transparent: true, depthWrite: false }, '0 0 0.006', 'clickable');
    slider.appendChild(hit);
    const setFromUv = (uv) => {
      if (!uv) return;
      brush.t = Math.min(1, Math.max(0, (uv.x * HIT_W - 0.03) / TRACK));
      notifyUi();
    };
    addSurface({ el: hit, mesh: () => hit.getObject3D('mesh'), down: setFromUv, move: setFromUv, up: () => {} });
    hit.addEventListener('click', (e) => { if (!hit.sceneEl.is('admin-mode')) e.stopPropagation(); });
    row.appendChild(slider);
    x += TRACK + 0.06;

    // Dot showing the brush at its real size, in the chosen colour (the eraser: white, outlined).
    const dotX = x + 0.08;
    const dot = entity({ primitive: 'circle', radius: 0.01, segments: 32 }, { shader: 'flat', color: '#1b1b1f' }, `${dotX} 0 0.003`);
    const dotRing = entity({ primitive: 'ring', radiusInner: 0.01, radiusOuter: 0.014, segmentsTheta: 40 }, { shader: 'flat', color: '#8a847a' }, '0 0 0.001');
    row.appendChild(dot);
    row.appendChild(dotRing);
    dotRing.setAttribute('position', `${dotX} 0 0.004`);
    x += 0.16 + 0.06;

    // Undo (your own last stroke) and Clear.
    const button = (label, width, cx, fn) => {
      const btn = entity({ primitive: 'plane', width, height: 0.09 }, { shader: 'flat', color: '#1b1b1f' }, `${cx} 0 0.002`, 'clickable');
      btn.setAttribute('text', { value: label, align: 'center', color: '#f4f2ee', width: 0.9, zOffset: 0.002 });
      btn.addEventListener('mouseenter', () => { if (btn.dataset.off !== '1') btn.setAttribute('material', 'color', '#ffb347'); });
      btn.addEventListener('mouseleave', () => btn.setAttribute('material', 'color', btn.dataset.off === '1' ? '#8a847a' : '#1b1b1f'));
      onClick(btn, fn);
      row.appendChild(btn);
      return btn;
    };
    const undoBtn = button('Undo', 0.22, x + 0.11, () => undo(r.id));
    x += 0.22 + 0.04;
    const clear = entity({ primitive: 'plane', width: 0.24, height: 0.09 }, { shader: 'flat', color: '#1b1b1f' }, `${x + 0.12} 0 0.002`, 'clickable');
    clear.setAttribute('text', { value: 'Clear', align: 'center', color: '#f4f2ee', width: 0.9, zOffset: 0.002 });
    clear.addEventListener('mouseenter', () => clear.setAttribute('material', 'color', '#ffb347'));
    clear.addEventListener('mouseleave', () => clear.setAttribute('material', 'color', '#1b1b1f'));
    onClick(clear, () => clearBoard(r.id));
    row.appendChild(clear);

    const update = () => {
      if (!row.isConnected && row.hasLoaded) { uiListeners.delete(update); return; }
      rings.forEach(({ c, ring }) => ring.setAttribute('visible', c === brush.colour));
      const kx = -TRACK / 2 + brush.t * TRACK;
      knob.setAttribute('position', `${kx} 0 0.003`);
      fill.setAttribute('scale', `${Math.max(0.0001, brush.t * TRACK)} 1 1`);
      fill.setAttribute('position', `${(-TRACK + brush.t * TRACK) / 2} 0 0.001`);
      const rad = Math.max(0.003, brushMetres() / 2), erasing = brush.colour === ERASER;
      dot.setAttribute('geometry', 'radius', rad);
      dot.setAttribute('material', 'color', erasing ? '#ffffff' : brush.colour);
      dotRing.setAttribute('visible', erasing);
      dotRing.setAttribute('geometry', { radiusInner: rad, radiusOuter: rad + 0.004 });
      const off = !canUndo(r.id); // greyed out until you've drawn something here
      if ((undoBtn.dataset.off === '1') !== off) {
        undoBtn.dataset.off = off ? '1' : '0';
        undoBtn.setAttribute('material', 'color', off ? '#8a847a' : '#1b1b1f');
      }
    };
    uiListeners.add(update);
    update();
    el.appendChild(row);
    return el;
  }

  return { attach, clearBoard, undo, COLOURS, ERASER };
})();
