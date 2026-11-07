/* global THREE */

/**
 * PDF reader: clicking a PDF exhibit opens it big, for comfortable reading.
 *   - On PC / phone: a reader in the middle of the screen. Arrow keys or the < > buttons
 *     turn pages, Esc or the × closes it (or click outside the page).
 *   - In VR (web overlays can't be seen in a headset): a large floating panel appears in
 *     front of you, with laser buttons. The B button also closes it.
 * Opens at the page showing on the wall, and the wall follows when you close it.
 *
 * PdfReader.open({ doc, page, title, subtitle, description, onPage })
 *   doc: a pdf.js document; onPage(n): called with the page you were on when closing.
 */
window.PdfReader = (() => {
  let state = null; // { doc, page, onPage, ... } while open

  // ---------------------------------------------------------------- PC / phone
  let dom;
  function buildDom() {
    if (dom) return dom;
    const root = document.createElement('div');
    root.id = 'pdf-reader';
    root.hidden = true;
    root.innerHTML = `
      <div class="pr-card" role="dialog" aria-modal="true" aria-labelledby="pr-title">
        <header>
          <div class="pr-heading">
            <h2 id="pr-title"></h2>
            <p class="pr-sub" id="pr-sub"></p>
          </div>
          <button type="button" class="pr-close" aria-label="Close reader">×</button>
        </header>
        <p class="pr-desc" id="pr-desc"></p>
        <div class="pr-stage"><canvas id="pr-canvas" aria-label="PDF page"></canvas><div class="pr-loading">Loading page…</div></div>
        <footer>
          <button type="button" class="pr-prev" aria-label="Previous page">‹</button>
          <span id="pr-count"></span>
          <button type="button" class="pr-next" aria-label="Next page">›</button>
        </footer>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) close(); }); // click outside the card
    root.querySelector('.pr-close').addEventListener('click', close);
    root.querySelector('.pr-prev').addEventListener('click', () => go(-1));
    root.querySelector('.pr-next').addEventListener('click', () => go(1));
    window.addEventListener('keydown', (e) => {
      if (!state || state.vr) return;
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { go(1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(-1); e.preventDefault(); }
    });
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => { if (state && !state.vr) renderDom(); }, 150);
    });
    dom = root;
    return root;
  }

  // Stop the museum's own mouse-look and walking while reading (arrow keys turn pages instead).
  function freezePlayer(frozen) {
    const cam = document.querySelector('#camera');
    if (!cam) return;
    cam.setAttribute('look-controls', 'enabled', !frozen);
    cam.setAttribute('wasd-controls', 'enabled', !frozen);
    const rig = document.querySelector('#rig');
    if (rig && rig.components.jump) {
      if (frozen) rig.components.jump.pause(); else rig.components.jump.play();
    }
  }

  let renderToken = 0;
  async function renderDom() {
    const token = ++renderToken;
    const { doc, page } = state;
    const root = buildDom();
    root.querySelector('#pr-count').textContent = `Page ${page} of ${doc.numPages}`;
    root.querySelector('.pr-prev').disabled = page <= 1;
    root.querySelector('.pr-next').disabled = page >= doc.numPages;
    const stage = root.querySelector('.pr-stage');
    const loading = root.querySelector('.pr-loading');
    loading.hidden = false;
    const p = await doc.getPage(page);
    if (token !== renderToken) return;
    const base = p.getViewport({ scale: 1 });
    const fit = Math.min(stage.clientWidth / base.width, stage.clientHeight / base.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = p.getViewport({ scale: fit * dpr });
    const off = document.createElement('canvas'); // draw off-screen, then swap in: no flicker
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    if (token !== renderToken) return;
    const canvas = root.querySelector('#pr-canvas');
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${Math.round(off.width / dpr)}px`;
    canvas.style.height = `${Math.round(off.height / dpr)}px`;
    canvas.getContext('2d').drawImage(off, 0, 0);
    loading.hidden = true;
  }

  // ---------------------------------------------------------------- VR
  let vrEl = null, vrTex = null;
  function makeButton(label, x, y, w, onClick) {
    const b = document.createElement('a-entity');
    b.classList.add('clickable');
    b.setAttribute('geometry', { primitive: 'plane', width: w, height: 0.11 });
    b.setAttribute('material', { shader: 'flat', color: '#2b2119' });
    b.setAttribute('text', { value: label, align: 'center', color: '#faf8f4', width: w * 1.9, wrapCount: 18 });
    b.setAttribute('position', `${x} ${y} 0.01`);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    b.addEventListener('mouseenter', () => b.setAttribute('material', 'color', '#5a4330'));
    b.addEventListener('mouseleave', () => b.setAttribute('material', 'color', '#2b2119'));
    return b;
  }

  function buildVr() {
    const scene = document.querySelector('a-scene');
    const cam = scene.camera;
    const head = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    cam.getWorldPosition(head);
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();

    const el = document.createElement('a-entity');
    el.id = 'pdf-reader-vr';
    // Placed 1.1 m in front of you at eye level, facing you (it stays put if you look around).
    el.object3D.position.set(head.x + fwd.x * 1.1, head.y - 0.05, head.z + fwd.z * 1.1);
    el.object3D.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);

    const board = document.createElement('a-entity'); // dark backing board
    board.setAttribute('geometry', { primitive: 'plane', width: 1.12, height: 1.32 });
    board.setAttribute('material', { shader: 'flat', color: '#1b1c22', opacity: 0.96, transparent: true });
    board.setAttribute('position', '0 -0.02 -0.01');
    el.appendChild(board);

    const page = document.createElement('a-entity');
    page.setAttribute('geometry', { primitive: 'plane', width: 0.9, height: 1.1 });
    page.setAttribute('material', { shader: 'flat', color: '#ffffff' });
    page.setAttribute('position', '0 0.03 0');
    el.appendChild(page);

    const title = document.createElement('a-entity');
    title.setAttribute('text', { value: state.title, align: 'center', color: '#e8d3a0', width: 1.0, wrapCount: 34 });
    title.setAttribute('position', '0 0.635 0.01');
    el.appendChild(title);

    const count = document.createElement('a-entity');
    count.setAttribute('position', '0 -0.6 0.01');
    el.appendChild(count);

    el.appendChild(makeButton('<  Prev', -0.34, -0.6, 0.26, () => go(-1)));
    el.appendChild(makeButton('Next  >', 0.34, -0.6, 0.26, () => go(1)));
    el.appendChild(makeButton('Close  x', 0.46, 0.635, 0.2, close));

    scene.appendChild(el);
    vrEl = el;
    vrEl._page = page;
    vrEl._count = count;

    // B button closes the reader.
    const right = document.querySelector('#rightHand');
    if (right) right.addEventListener('bbuttondown', close);
  }

  async function renderVr() {
    const token = ++renderToken;
    const { doc, page } = state;
    vrEl._count.setAttribute('text', { value: `${page} / ${doc.numPages}`, align: 'center', color: '#f2efe9', width: 1 });
    const p = await doc.getPage(page);
    if (token !== renderToken || !vrEl) return;
    const base = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: 1400 / base.width }); // sharp enough to read in a headset
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    if (token !== renderToken || !vrEl) return;
    // Fit the page into a 0.9 x 1.1 m area, keeping its shape.
    const aspect = c.height / c.width;
    let w = 0.9, h = 0.9 * aspect;
    if (h > 1.1) { h = 1.1; w = 1.1 / aspect; }
    const pageEl = vrEl._page;
    pageEl.setAttribute('geometry', { primitive: 'plane', width: w, height: h });
    const mesh = pageEl.getObject3D('mesh');
    if (!mesh) return;
    const tex = new THREE.CanvasTexture(c); // fresh texture per page (see the black-PDF fix)
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const old = mesh.material;
    mesh.material = new THREE.MeshBasicMaterial({ map: tex });
    if (old && old.dispose) old.dispose();
    if (vrTex) vrTex.dispose();
    vrTex = tex;
  }

  // ---------------------------------------------------------------- shared
  function go(dir) {
    if (!state) return;
    const next = Math.min(state.doc.numPages, Math.max(1, state.page + dir));
    if (next === state.page) return;
    state.page = next;
    if (state.vr) renderVr(); else renderDom();
  }

  function open({ doc, page = 1, title = '', subtitle = '', description = '', onPage = null }) {
    if (state) close();
    const scene = document.querySelector('a-scene');
    state = { doc, page: Math.min(Math.max(1, page), doc.numPages), onPage, title, vr: scene.is('vr-mode') };
    if (state.vr) {
      buildVr();
      renderVr();
      return;
    }
    const root = buildDom();
    root.querySelector('#pr-title').textContent = title || 'Document';
    root.querySelector('#pr-sub').textContent = subtitle;
    const desc = root.querySelector('#pr-desc');
    desc.textContent = description;
    desc.hidden = !description;
    root.hidden = false;
    freezePlayer(true);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    requestAnimationFrame(renderDom); // after layout, so the page fits the stage
  }

  function close() {
    if (!state) return;
    const { onPage, page, vr } = state;
    state = null;
    renderToken++;
    if (vr) {
      const right = document.querySelector('#rightHand');
      if (right) right.removeEventListener('bbuttondown', close);
      if (vrEl) vrEl.parentNode.removeChild(vrEl);
      if (vrTex) { vrTex.dispose(); vrTex = null; }
      vrEl = null;
    } else if (dom) {
      dom.hidden = true;
      freezePlayer(false);
    }
    if (onPage) onPage(page);
  }

  // Leaving VR with the floating reader open: close it (it belongs to the headset view).
  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    scene.addEventListener('exit-vr', () => { if (state && state.vr) close(); });
  });

  return { open, close, get isOpen() { return !!state; } };
})();
