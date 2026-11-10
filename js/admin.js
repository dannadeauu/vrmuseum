/* global THREE, MuseumStore, MuseumItems */

/**
 * Admin mode: add images, PDFs and 3D models, place them by clicking a wall
 * or the floor, and edit their details.
 *
 * Open the site with ?admin in the URL (e.g. http://localhost:8000/?admin)
 * to see the Admin button. This is NOT security: anyone who knows the URL can
 * use it, and everything is stored only in this browser. Real admin accounts
 * need a backend (see README).
 */
(() => {
  if (!new URLSearchParams(location.search).has('admin')) return;

  const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.glb,.gltf,image/*,application/pdf,model/gltf-binary';
  const DEFAULT_SIZE = { image: 1.6, pdf: 0.9, model: 0.8 };
  const SIZE_RANGE = {
    image: [0.3, 4], pdf: [0.3, 2.5], model: [0.2, 3],
    placeholder: [0.3, 4], knot: [0.3, 2.5], bench: [1, 4], sign: [0.4, 8], customizer: [1, 1], infodesk: [1.4, 1.4]
  };
  const KIND_LABEL = {
    image: 'Image', pdf: 'PDF', model: '3D model',
    placeholder: 'Painting (starter)', knot: 'Sculpture (starter)', bench: 'Bench', sign: 'Sign',
    customizer: 'Avatar station (can be moved, not deleted)',
    infodesk: 'Info desk (can be moved, not deleted)'
  };
  const isFlat = (rec) => MuseumItems.FLAT_KINDS.includes(rec.kind); // walls or floor; everything else floor only
  const ROOM_HEIGHT = 6;   // wall height of the rotunda
  const ROOM_RADIUS = 10;  // radius of the curved wall
  const FRAME_AND_PLAQUE = 0.8; // how far the frame + plaque reach past the picture's half-width

  let scene, canvas;
  let adminOn = false;
  let placing = null;     // { rec, isNew }
  let selected = null;    // record
  let ghost, helper;
  let downAt = null;      // mouse-down position, to tell clicks from drag-to-look

  // ---------------- UI ----------------

  function buildUi() {
    const toggle = document.createElement('button');
    toggle.id = 'admin-toggle';
    toggle.textContent = 'Admin';
    document.body.appendChild(toggle);

    const panel = document.createElement('aside');
    panel.id = 'admin-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header>
        <strong>Museum admin</strong>
        <button type="button" data-act="close" aria-label="Close admin">×</button>
      </header>
      <p class="admin-note" id="admin-mode-note"></p>
      <p id="admin-status" role="status"></p>

      <section id="admin-login" hidden>
        <p class="admin-hint">Log in with your Supabase admin account to change the museum for everyone.</p>
        <form id="admin-login-form">
          <label class="admin-field">Email <input id="login-email" type="email" autocomplete="username" required></label>
          <label class="admin-field">Password <input id="login-password" type="password" autocomplete="current-password" required></label>
          <button type="submit" class="admin-btn admin-primary admin-wide">Log in</button>
        </form>
      </section>

      <div id="admin-account" hidden>
        <p class="admin-hint" id="admin-who"></p>
        <div class="admin-row">
          <button type="button" class="admin-btn" data-act="logout">Log out</button>
        </div>
      </div>

      <div id="admin-tools">
      <label class="admin-btn admin-primary">
        Add image, PDF or 3D model…
        <input type="file" id="admin-file" accept="${ACCEPT}" hidden>
      </label>
      <form id="admin-link-form" class="admin-link">
        <input id="admin-link" type="text" placeholder="assets/statue.glb or https://…" aria-label="File path or address">
        <button type="submit" class="admin-btn">Add from link</button>
      </form>
      <button type="button" class="admin-btn admin-wide" data-act="add-sign">Add sign</button>
      <p class="admin-hint">Images: PNG, JPG, WebP. 3D: .glb (or a self-contained .gltf). "Add from link" uses a file already on the website (for example in the GitHub repo's assets folder) without uploading it.</p>

      <section id="admin-editor" hidden>
        <h3 id="ed-kind"></h3>
        <label data-show="sign">Sign text <textarea id="ed-text" rows="2"></textarea></label>
        <label data-show="sign">Style
          <select id="ed-style">
            <option value="bronze">Bronze plate, gold letters</option>
            <option value="stone">Stone plate, dark letters</option>
            <option value="navy">Navy plate, gold letters</option>
            <option value="letters-dark">Letters only, dark</option>
            <option value="letters-light">Letters only, light</option>
          </select>
        </label>
        <label data-show="desk">Computer link <input id="ed-link" type="url" placeholder="https://…" spellcheck="false"></label>
        <p data-show="desk" class="admin-hint" id="ed-link-note">Visitors click the computer on the desk to browse this website.</p>
        <label data-show="desk">Hanging sign text <input id="ed-sign-text" type="text" maxlength="24"></label>
        <label data-show="text">Title <input id="ed-title" type="text"></label>
        <label data-show="text">Artist <input id="ed-artist" type="text"></label>
        <label data-show="text">Year <input id="ed-year" type="text"></label>
        <label data-show="text">Description <textarea id="ed-description" rows="4"></textarea></label>
        <label data-show="size">Size <span id="ed-size-val"></span>
          <input id="ed-size" type="range" step="0.05">
        </label>
        <p id="ed-mount" class="admin-hint"></p>
        <label data-show="rotate">Rotation <span id="ed-rot-val"></span>
          <input id="ed-rot" type="range" min="-180" max="180" step="5">
        </label>
        <label data-show="plinth" class="admin-check"><input id="ed-plinth" type="checkbox"> On a plinth</label>
        <label data-show="hover" class="admin-check"><input id="ed-hover" type="checkbox"> Hover</label>
        <label data-show="spin" class="admin-check"><input id="ed-spin" type="checkbox"> Slowly rotate</label>
        <label data-show="stand" class="admin-check"><input id="ed-stand" type="checkbox"> On a display stand</label>
        <div class="admin-row">
          <button type="button" class="admin-btn" data-act="move">Move</button>
          <button type="button" class="admin-btn admin-danger" data-act="delete" data-show="delete">Delete</button>
          <button type="button" class="admin-btn" data-act="deselect">Done</button>
        </div>
      </section>

      <footer class="admin-row">
        <button type="button" class="admin-btn" data-act="export">Export layout</button>
        <label class="admin-btn">Import layout<input type="file" id="admin-import" accept=".json,application/json" hidden></label>
        <button type="button" class="admin-btn" data-act="restore">Restore starter exhibits</button>
      </footer>
      <p class="admin-hint">In admin mode, click any painting, sculpture or bench to move, edit or delete it.</p>
      </div>
    `;
    document.body.appendChild(panel);

    toggle.addEventListener('click', () => setAdmin(!adminOn));
    panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') setAdmin(false);
      if (act === 'move' && selected) startPlacing(selected, false);
      if (act === 'delete') deleteSelected();
      if (act === 'deselect') select(null);
      if (act === 'export') exportLayout();
      if (act === 'add-sign') addSign();
      if (act === 'logout') logOut();
      if (act === 'restore') restoreStarters();
      // Give the keyboard back to the scene so WASD/space work right away.
      if (e.target.tagName === 'BUTTON') e.target.blur();
    });

    $('#admin-login-form').addEventListener('submit', logIn);
    $('#admin-file').addEventListener('change', onUpload);
    $('#admin-link-form').addEventListener('submit', onAddLink);
    $('#admin-import').addEventListener('change', importLayout);

    ['title', 'artist', 'year', 'description'].forEach((key) => {
      $(`#ed-${key}`).addEventListener('input', (e) => edit({ [key]: e.target.value }));
    });
    $('#ed-size').addEventListener('input', (e) => edit({ size: parseFloat(e.target.value) }));
    $('#ed-rot').addEventListener('input', (e) => edit({ rotationY: parseFloat(e.target.value) }));
    $('#ed-plinth').addEventListener('change', (e) => edit({ plinth: e.target.checked }));
    $('#ed-text').addEventListener('input', (e) => edit({ text: e.target.value, title: e.target.value.split('\n')[0] || 'Sign' }));
    $('#ed-link').addEventListener('input', (e) => {
      const link = window.InfoDesk.normaliseLink(e.target.value);
      $('#ed-link-note').textContent = !e.target.value.trim() ? 'No link: the computer will say there is nothing to browse yet.'
        : link ? `Visitors will browse ${link}` : 'That doesn\'t look like a web address (it should start with https://).';
      if (link || !e.target.value.trim()) edit({ link });
    });
    $('#ed-sign-text').addEventListener('input', (e) => edit({ signText: e.target.value.trim() || window.InfoDesk.DEFAULT_SIGN }));
    $('#ed-style').addEventListener('change', (e) => edit({ style: e.target.value }));
    $('#ed-stand').addEventListener('change', (e) => edit({ stand: e.target.checked }));
    $('#ed-spin').addEventListener('change', (e) => edit({ spin: e.target.checked }));
    $('#ed-hover').addEventListener('change', (e) => edit({ hover: e.target.checked }));
  }

  const $ = (sel) => document.querySelector(sel);
  const status = (msg) => { $('#admin-status').textContent = msg || ''; };

  function setAdmin(on) {
    adminOn = on;
    $('#admin-panel').hidden = !on;
    $('#admin-toggle').classList.toggle('active', on);
    if (on) refreshAccess();
    else {
      cancelPlacing();
      select(null);
      scene.removeState('admin-mode');
    }
  }

  const savedNote = () => (MuseumStore.mode === 'online' ? 'Saved: live for everyone.' : 'Saved in this browser.');

  // ---------------- online access (Supabase) ----------------
  // Online, only logged-in museum admins get the editing tools, and every change goes
  // live for all visitors. Offline (Supabase not set up / unreachable) it works as before,
  // saving in this browser only.
  let canEdit = false;

  async function refreshAccess() {
    await MuseumStore.ready;
    const online = MuseumStore.online();
    let who = '', published = true;
    canEdit = true;
    if (online) {
      const session = await online.session();
      who = session ? session.user.email : '';
      canEdit = !!session && (await online.isAdmin().catch(() => false));
      published = !!(await MuseumStore.getMeta('seeded'));
      if (session && !canEdit) {
        status(`You're logged in, but ${who} isn't a museum admin yet. In Supabase's SQL Editor, run supabase/setup.sql again (it gives every existing user admin rights), then reload this page.`);
      }
      else if (canEdit && !published) {
        // Empty online museum: save the starter exhibits so editing works straight away.
        status('Setting up the online museum…');
        try {
          await MuseumItems.seedOnline();
          published = true;
          status('The online museum was empty, so the starter exhibits were saved. Everything you change now saves automatically for everyone.');
        } catch (err) {
          status(`Couldn't set up the online museum: ${err.message}`);
        }
      }
    }
    // Supabase is set up but can't be reached: pause editing, so nothing gets saved only in
    // this browser (where nobody else would see it).
    const configured = !!(window.MUSEUM_SUPABASE && window.MUSEUM_SUPABASE.url && window.MUSEUM_SUPABASE.key);
    if (!online && configured) {
      canEdit = false;
      status("Can't reach the online museum right now, so editing is paused (changes couldn't be shared). Check your connection and reload.");
    }
    $('#admin-mode-note').textContent = online
      ? 'Every change saves automatically and appears for all visitors right away.'
      : configured ? 'Offline: editing paused.'
      : 'Offline: Supabase is not set up or not reachable, so changes are saved in this browser only.';
    $('#admin-login').hidden = !online || !!who;
    $('#admin-account').hidden = !online || !who;
    $('#admin-who').textContent = who ? `Signed in as ${who}` : '';
    const tools = canEdit && published;
    $('#admin-tools').hidden = !tools;
    if (adminOn && tools) scene.addState('admin-mode'); else scene.removeState('admin-mode');
    if (!tools) { cancelPlacing(); select(null); }
  }

  async function logIn(e) {
    e.preventDefault();
    const online = MuseumStore.online();
    if (!online) return;
    status('Logging in…');
    try {
      await online.signIn($('#login-email').value.trim(), $('#login-password').value);
      $('#login-password').value = '';
      status('');
    } catch (err) {
      const msg = String(err.message || err);
      if (/not confirmed/i.test(msg)) {
        status('Couldn\'t log in: this email isn\'t confirmed yet. In Supabase, open Authentication → Users, click the user and choose "Confirm email" (or recreate it with "Auto Confirm User" ticked).');
      } else if (/invalid login credentials/i.test(msg)) {
        status('Couldn\'t log in: wrong email or password. You can reset the password in Supabase under Authentication → Users → the user → "Send password recovery", or delete and recreate the user.');
      } else if (/fetch|network/i.test(msg)) {
        status('Couldn\'t reach Supabase. Check your internet connection and try again.');
      } else {
        status(`Couldn't log in: ${msg}`);
      }
      return;
    }
    refreshAccess();
  }

  async function logOut() {
    const online = MuseumStore.online();
    if (online) await online.signOut();
    status('Logged out.');
    refreshAccess();
  }

  // ---------------- uploading ----------------

  async function onUpload(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const kind = MuseumItems.kindOf(file);
    if (!kind) { status(`"${file.name}" isn't a supported file type.`); return; }
    if (file.size > 50 * 1024 * 1024) {
      status('Heads up: files over 50 MB will load slowly, especially on Quest.');
    }

    cancelPlacing();
    const fileId = MuseumStore.newId();
    await MuseumStore.putFile({ id: fileId, name: file.name, type: file.type, blob: file });

    status(`Reading ${file.name}…`);
    let info;
    try {
      info = await MuseumItems.inspect(fileId, kind);
    } catch (err) {
      await MuseumStore.deleteFile(fileId);
      MuseumItems.forgetFile(fileId);
      status(`Couldn't read ${file.name}: ${err.message}`);
      return;
    }

    const aspect = info.aspect || 1;
    let size = DEFAULT_SIZE[kind];
    if (kind !== 'model') size = Math.min(size, 1.8 / aspect); // keep tall pieces under ~1.8 m

    const rec = {
      id: MuseumStore.newId(),
      fileId,
      kind,
      aspect,
      size: round(size),
      plinth: false, // models start on the floor; tick "On a plinth" in the editor to add one
      mount: kind === 'model' ? 'floor' : 'wall', // images/PDFs switch to 'floor' if placed there
      stand: true,                                 // images/PDFs on the floor get a display stand by default
      rotationY: 0,
      position: { x: 0, y: 0, z: 0 },
      title: file.name.replace(/\.[^.]+$/, ''),
      artist: '',
      year: '',
      description: ''
    };
    select(null);
    startPlacing(rec, true);
  }

  // Add an exhibit that points to a file hosted on the site (or anywhere public) instead
  // of uploading it. Nothing is stored in Supabase except the exhibit's details.
  async function onAddLink(e) {
    e.preventDefault();
    const src = $('#admin-link').value.trim();
    if (!src) return;
    cancelPlacing();
    select(null);
    status(`Checking ${src}…`);
    let info;
    try {
      info = await MuseumItems.inspectLink(src);
    } catch (err) {
      status(`Couldn't use "${src}": ${err.message || 'the file could not be loaded'}. Check the path and that the file is on the website.`);
      return;
    }
    const kind = info.kind;
    const aspect = info.aspect || 1;
    let size = DEFAULT_SIZE[kind];
    if (kind !== 'model') size = Math.min(size, 1.8 / aspect);
    $('#admin-link').value = '';
    startPlacing({
      id: MuseumStore.newId(),
      src,
      kind,
      aspect,
      size: round(size),
      plinth: false,
      mount: kind === 'model' ? 'floor' : 'wall',
      stand: true,
      rotationY: 0,
      position: { x: 0, y: 0, z: 0 },
      title: decodeURIComponent(src.split(/[?#]/)[0].split('/').pop()).replace(/\.[^.]+$/, ''),
      artist: '',
      year: '',
      description: ''
    }, true);
  }

  // ---------------- placing ----------------

  function startPlacing(rec, isNew) {
    placing = { rec, isNew };
    const flat = isFlat(rec);
    if (flat) {
      ghost.setAttribute('geometry', { primitive: 'plane', width: rec.size, height: rec.size * rec.aspect });
    } else {
      ghost.setAttribute('geometry', { primitive: 'cylinder', radius: Math.max(0.3, rec.size * 0.6), height: 0.02 });
    }
    ghost.object3D.visible = false;
    status(`${flat ? 'Click a wall to hang' : 'Click the floor to place'} "${rec.title}"${flat ? ', or click the floor to stand it up' : ''}. Press Esc to cancel.`);
  }

  async function cancelPlacing() {
    if (!placing) return;
    const { rec, isNew } = placing;
    placing = null;
    ghost.object3D.visible = false;
    status('');
    if (isNew && rec.fileId) { // signs have no uploaded file
      await MuseumStore.deleteFile(rec.fileId);
      MuseumItems.forgetFile(rec.fileId);
    }
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function surfaceAt(ev) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, scene.camera);
    // Placeable surfaces: an entity's own mesh, or meshes inside it tagged with userData.surface
    // (the rotunda wall pieces and the gallery rooms).
    const meshes = [];
    document.querySelectorAll('.placeable').forEach((el) => {
      const own = el.getObject3D('mesh');
      el.object3D.traverse((o) => { if (o.isMesh && (o === own || o.userData.surface)) meshes.push(o); });
    });
    // Skip hits inside an archway opening (the wall texture is transparent there).
    const hit = ray.intersectObjects(meshes, false).find((h) => !(h.object.userData.isHole && h.object.userData.isHole(h.point)));
    if (!hit) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // The curved wall is seen from inside, so its stored normals point outward: flip them toward the viewer.
    if (normal.dot(ray.ray.direction) > 0) normal.negate();
    return { point: hit.point, normal, curved: !!hit.object.userData.curved, isFloor: normal.y > 0.7, isWall: Math.abs(normal.y) < 0.3 };
  }

  function placementFor(rec, hit) {
    const deg = THREE.MathUtils.radToDeg;
    if (hit.isFloor) {
      // Models, and images/PDFs standing up, go on the floor facing the player.
      const cam = new THREE.Vector3();
      scene.camera.getWorldPosition(cam);
      const p = hit.point;
      return {
        mount: 'floor',
        position: { x: p.x, y: 0, z: p.z },
        rotationY: Math.round(deg(Math.atan2(cam.x - p.x, cam.z - p.z)))
      };
    }
    if (!isFlat(rec) || !hit.isWall) return null;
    const h = rec.size * rec.aspect;
    const minY = h / 2 + 0.4;
    const maxY = ROOM_HEIGHT - h / 2 - 0.4;
    const y = minY > maxY ? ROOM_HEIGHT / 2 : Math.min(maxY, Math.max(minY, hit.point.y));
    const n = hit.normal;
    // On a curved wall a flat piece must sit far enough in that its edges and its
    // plaque (to the right) don't sink into the wall.
    const halfSpan = rec.size / 2 + FRAME_AND_PLAQUE;
    const inner = ROOM_RADIUS - 0.05;
    const offset = hit.curved
      ? Math.max(0.08, ROOM_RADIUS - Math.sqrt(Math.max(0, inner * inner - halfSpan * halfSpan)))
      : 0.08; // flat gallery walls
    return {
      mount: 'wall',
      position: { x: hit.point.x + n.x * offset, y, z: hit.point.z + n.z * offset },
      rotationY: Math.round(deg(Math.atan2(n.x, n.z)))
    };
  }

  function onMouseMove(ev) {
    if (!placing) return;
    const hit = surfaceAt(ev);
    const spot = hit && placementFor(placing.rec, hit);
    ghost.object3D.visible = !!spot;
    if (!spot) return;
    if (!isFlat(placing.rec)) {
      ghost.object3D.position.set(spot.position.x, 0.02, spot.position.z);
      ghost.object3D.rotation.set(0, 0, 0);
    } else if (spot.mount === 'floor') {
      const cy = MuseumItems.floorCenterY(Object.assign({}, placing.rec, spot));
      ghost.object3D.position.set(spot.position.x, cy, spot.position.z);
      ghost.object3D.rotation.set(0, THREE.MathUtils.degToRad(spot.rotationY), 0);
    } else {
      ghost.object3D.position.set(spot.position.x, spot.position.y, spot.position.z);
      ghost.object3D.rotation.set(0, THREE.MathUtils.degToRad(spot.rotationY), 0);
    }
  }

  async function onMouseUp(ev) {
    const wasClick = downAt && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) < 5;
    downAt = null;
    if (!placing || !wasClick) return;
    const hit = surfaceAt(ev);
    const spot = hit && placementFor(placing.rec, hit);
    if (!spot) {
      status(isFlat(placing.rec) ? 'Click a wall or the floor.' : 'This goes on the floor. Click the floor.');
      return;
    }
    const rec = Object.assign(placing.rec, spot);
    placing = null;
    ghost.object3D.visible = false;
    status('Saving…');
    await MuseumStore.putItem(rec);
    await MuseumItems.build(rec);
    status(`Placed "${rec.title}". ${savedNote()}`);
    select(rec);
  }

  // ---------------- selecting & editing ----------------

  async function onSceneClick(e) {
    if (!adminOn || placing || !scene.is('admin-mode')) return;
    let el = e.target;
    while (el && el !== scene && !(el.dataset && el.dataset.itemId)) el = el.parentEl;
    if (!el || el === scene) return;
    const items = await MuseumStore.allItems();
    const rec = items.find((r) => r.id === el.dataset.itemId);
    if (rec) select(rec);
  }

  function select(rec) {
    selected = rec;
    const editor = $('#admin-editor');
    editor.hidden = !rec;
    if (!rec) return;

    $('#ed-kind').textContent = KIND_LABEL[rec.kind];
    $('#ed-title').value = rec.title;
    $('#ed-artist').value = rec.artist;
    $('#ed-year').value = rec.year;
    $('#ed-description').value = rec.description;
    const [min, max] = SIZE_RANGE[rec.kind];
    Object.assign($('#ed-size'), { min, max, value: rec.size });
    $('#ed-size-val').textContent = `${rec.size.toFixed(2)} m`;
    $('#ed-rot').value = rec.rotationY;
    $('#ed-rot-val').textContent = `${rec.rotationY}°`;
    $('#ed-plinth').checked = !!rec.plinth;
    $('#ed-stand').checked = rec.stand !== false;
    $('#ed-spin').checked = !!(rec.spin ?? rec.kind === 'knot');
    $('#ed-hover').checked = !!rec.hover;
    $('#ed-text').value = rec.text || '';
    $('#ed-style').value = rec.style || 'bronze';
    $('#ed-link').value = rec.link || '';
    $('#ed-link-note').textContent = 'Visitors click the computer on the desk to browse this website.';
    $('#ed-sign-text').value = rec.signText || '';

    const model = !isFlat(rec); // floor-only piece: 3D model, sculpture or bench
    const floorFlat = !model && rec.mount === 'floor';
    const show = {
      rotate: model || floorFlat,
      plinth: rec.kind === 'model' || rec.kind === 'knot',
      spin: rec.kind === 'model' || rec.kind === 'knot',
      hover: rec.kind === 'model' || rec.kind === 'knot',
      stand: floorFlat,
      text: !['bench', 'sign', 'customizer', 'infodesk'].includes(rec.kind),
      size: !MuseumItems.ALWAYS_THERE.includes(rec.kind),
      delete: !MuseumItems.ALWAYS_THERE.includes(rec.kind),
      sign: rec.kind === 'sign',
      desk: rec.kind === 'infodesk'
    };
    editor.querySelectorAll('[data-show]').forEach((n) => { n.hidden = !show[n.dataset.show]; });
    $('#ed-mount').textContent = model ? 'On the floor' : floorFlat
      ? 'Standing on the floor. Use Move and click a wall to hang it instead.'
      : 'On a wall. Use Move and click the floor to stand it up instead.';
  }

  let saveTimer;
  function edit(changes) {
    if (!selected) return;
    Object.assign(selected, changes);
    if ('size' in changes) {
      selected.size = round(selected.size);
      $('#ed-size-val').textContent = `${selected.size.toFixed(2)} m`;
    }
    if ('rotationY' in changes) $('#ed-rot-val').textContent = `${selected.rotationY}°`;

    const rec = selected;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await MuseumStore.putItem(rec);
        status(savedNote());
      } catch (err) {
        status(`Couldn't save: ${err.message}. Check you're still logged in.`);
        return;
      }
      await MuseumItems.build(rec);
    }, 250);
  }

  async function deleteSelected() {
    if (!selected) return;
    const rec = selected;
    if (MuseumItems.ALWAYS_THERE.includes(rec.kind)) {
      status(`The ${rec.kind === 'infodesk' ? 'info desk' : 'avatar station'} can be moved and rotated, but not deleted.`);
      return;
    }
    const note = rec.fileId
      ? 'This removes the uploaded file from this browser.'
      : rec.id.startsWith('starter-') ? 'Starter pieces can be brought back with "Restore starter exhibits".' : '';
    if (!confirm(`Delete "${rec.title}" from the museum? ${note}`)) return;
    clearTimeout(saveTimer);
    select(null);
    MuseumItems.discard(rec.id);
    await MuseumStore.deleteItem(rec.id);
    const others = (await MuseumStore.allItems()).some((r) => r.fileId === rec.fileId);
    if (rec.fileId && !others) {
      await MuseumStore.deleteFile(rec.fileId);
      MuseumItems.forgetFile(rec.fileId);
    }
    status(`Deleted "${rec.title}". ${savedNote()}`);
  }

  // Outline the selected item every frame (it may be rebuilt while editing).
  function trackSelection() {
    const el = selected && MuseumItems.find(selected.id);
    const target = el && (el.getObject3D('mesh') || el.querySelector('.outline-target')?.getObject3D('mesh'));
    if (target) {
      helper.setFromObject(target);
      helper.visible = true;
    } else {
      helper.visible = false;
    }
    requestAnimationFrame(trackSelection);
  }

  // New sign: placed like a picture (click a wall, or the floor to put it on a stand).
  async function addSign() {
    cancelPlacing();
    select(null);
    const rec = {
      id: MuseumStore.newId(), kind: 'sign', text: 'NEW SIGN', title: 'NEW SIGN', style: 'bronze',
      mount: 'wall', stand: true, size: 2.4, rotationY: 0, position: { x: 0, y: 0, z: 0 }
    };
    rec.aspect = await MuseumItems.signAspect(rec);
    startPlacing(rec, true);
  }

  async function restoreStarters() {
    const n = await MuseumItems.restoreStarters();
    status(n ? `Restored ${n} starter piece${n === 1 ? '' : 's'}.` : 'All starter pieces are already in the museum.');
  }

  // ---------------- export / import ----------------

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  async function exportLayout(name = 'museum-layout') {
    status('Preparing export…');
    const items = await MuseumStore.allItems();
    const files = await MuseumStore.allFiles();
    const out = {
      format: 'virtual-museum',
      version: 1,
      exportedAt: new Date().toISOString(),
      items,
      files: await Promise.all(files.map(async (f) => ({
        id: f.id, name: f.name, type: f.type, data: await blobToDataUrl(f.blob)
      })))
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status(`Exported ${items.length} item${items.length === 1 ? '' : 's'}.`);
  }

  async function importLayout(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      status("That file isn't valid JSON.");
      return;
    }
    if (data.format !== 'virtual-museum' || !Array.isArray(data.items) || !Array.isArray(data.files)) {
      status("That file isn't a museum layout export.");
      return;
    }
    const where = MuseumStore.mode === 'online' ? 'the ONLINE museum (everyone will see it)' : 'this browser';
    if (!confirm(`Replace everything in ${where} with the ${data.items.length} item(s) from "${file.name}"?` +
      (MuseumStore.mode === 'online' ? '\n\nA backup of the online museum downloads first.' : ''))) return;
    if (MuseumStore.mode === 'online') await exportLayout('museum-backup-before-import');

    status('Importing…');
    await cancelPlacing();
    select(null);
    MuseumItems.clearScene();
    await MuseumStore.clearAll();
    for (const f of data.files) {
      const blob = await (await fetch(f.data)).blob();
      await MuseumStore.putFile({ id: f.id, name: f.name, type: f.type, blob });
    }
    for (const item of data.items) await MuseumStore.putItem(item);
    await MuseumStore.setMeta('seeded', true); // the imported layout decides which starters exist
    await MuseumStore.setMeta('layout', 2);
    await MuseumItems.loadAll();
    status(`Imported ${data.items.length} item${data.items.length === 1 ? '' : 's'}.`);
  }

  const round = (n) => Math.round(n * 100) / 100;

  // ---------------- startup ----------------

  function init() {
    scene = document.querySelector('a-scene');
    canvas = scene.canvas;
    buildUi();

    ghost = document.createElement('a-entity');
    ghost.setAttribute('material', 'shader: flat; color: #ffb347; opacity: 0.45; transparent: true; side: double');
    ghost.object3D.visible = false;
    scene.appendChild(ghost);

    helper = new THREE.BoxHelper(undefined, 0xffb347);
    helper.visible = false;
    scene.object3D.add(helper);
    requestAnimationFrame(trackSelection);

    canvas.addEventListener('mousedown', (ev) => { downAt = { x: ev.clientX, y: ev.clientY }; });
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    scene.addEventListener('click', onSceneClick);
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && placing) cancelPlacing(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const s = document.querySelector('a-scene');
    if (s.hasLoaded) init(); else s.addEventListener('loaded', init, { once: true });
  });
})();
