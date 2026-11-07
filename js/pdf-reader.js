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
  let state = null; // { doc, page, zoom, onPage, ... } while open
  const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3, 4]; // 1 = whole page fits the reader
  const VR_ZOOMS = [0.8, 1, 1.25, 1.5, 2];

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
          <div class="pr-pages">
            <button type="button" class="pr-prev" aria-label="Previous page">‹</button>
            <span id="pr-count"></span>
            <button type="button" class="pr-next" aria-label="Next page">›</button>
          </div>
          <div class="pr-zoom" role="group" aria-label="Zoom">
            <button type="button" class="pr-zoom-out" aria-label="Zoom out">−</button>
            <button type="button" class="pr-zoom-fit" aria-label="Fit page">Fit</button>
            <button type="button" class="pr-zoom-in" aria-label="Zoom in">+</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) close(); }); // click outside the card
    root.querySelector('.pr-close').addEventListener('click', close);
    root.querySelector('.pr-prev').addEventListener('click', () => go(-1));
    root.querySelector('.pr-next').addEventListener('click', () => go(1));
    root.querySelector('.pr-zoom-in').addEventListener('click', () => zoom(1));
    root.querySelector('.pr-zoom-out').addEventListener('click', () => zoom(-1));
    root.querySelector('.pr-zoom-fit').addEventListener('click', () => zoom(0));
    const stage = root.querySelector('.pr-stage');
    // Ctrl/Cmd + scroll wheel, or a trackpad pinch (browsers send it as Ctrl + wheel).
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    stage.addEventListener('dblclick', () => zoom(state && state.zoom > 1 ? 0 : 3)); // double-click: 2x / fit
    window.addEventListener('keydown', (e) => {
      if (!state || state.vr) return;
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { go(1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(-1); e.preventDefault(); }
      if (e.key === '+' || e.key === '=') { zoom(1); e.preventDefault(); }
      if (e.key === '-' || e.key === '_') { zoom(-1); e.preventDefault(); }
      if (e.key === '0') { zoom(0); e.preventDefault(); }
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
    root.querySelector('.pr-zoom-fit').textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
    root.querySelector('.pr-zoom-out').disabled = state.zoom <= ZOOMS[0];
    root.querySelector('.pr-zoom-in').disabled = state.zoom >= ZOOMS[ZOOMS.length - 1];
    const stage = root.querySelector('.pr-stage');
    // Remember which part of the page is in the middle, to keep it there after zooming.
    const cx = stage.scrollWidth > stage.clientWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : 0.5;
    const cy = stage.scrollHeight > stage.clientHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0.5;
    const loading = root.querySelector('.pr-loading');
    loading.hidden = false;
    const p = await doc.getPage(page);
    if (token !== renderToken) return;
    const base = p.getViewport({ scale: 1 });
    const pad = 24; // stage padding
    const fit = Math.min((stage.clientWidth - pad) / base.width, (stage.clientHeight - pad) / base.height);
    const cssScale = fit * state.zoom;
    // Sharp on high-DPI screens, but cap the canvas size (big zooms can get huge).
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxPixels = 16e6;
    const px = base.width * base.height * cssScale * cssScale * dpr * dpr;
    if (px > maxPixels) dpr *= Math.sqrt(maxPixels / px);
    const vp = p.getViewport({ scale: cssScale * dpr });
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
    if (state.keepView) {
      stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
    } else {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = 0; // new page: start at the top
    }
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
    count.setAttribute('scale', '0.8 0.8 0.8');
    el.appendChild(count);

    el.appendChild(makeButton('<  Prev', -0.22, -0.6, 0.22, () => go(-1)));
    el.appendChild(makeButton('Next  >', 0.22, -0.6, 0.22, () => go(1)));
    el.appendChild(makeButton('-', -0.48, -0.6, 0.1, () => zoom(-1)));
    el.appendChild(makeButton('+', 0.48, -0.6, 0.1, () => zoom(1)));
    const zl = document.createElement('a-entity');
    zl.setAttribute('position', '-0.48 -0.68 0.01');
    zl.setAttribute('text', { value: '100%', align: 'center', color: '#b9b2a6', width: 0.6 });
    el.appendChild(zl);
    el.appendChild(makeButton('Close  x', 0.46, 0.635, 0.2, close));

    scene.appendChild(el);
    vrEl = el;
    vrEl._page = page;
    vrEl._count = count;
    vrEl._zoomLabel = zl;

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
    const px = 1400 * Math.min(2, Math.max(1, state.zoom)); // sharper when the panel is bigger
    const vp = p.getViewport({ scale: px / base.width });
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
    state.keepView = false;
    if (state.vr) renderVr(); else renderDom();
  }

  // dir: +1 zoom in, -1 zoom out, 0 back to fit (or a ZOOMS index when > 1, e.g. 3 = 2x).
  function zoom(dir) {
    if (!state) return;
    const steps = state.vr ? VR_ZOOMS : ZOOMS;
    let i = steps.indexOf(state.zoom);
    if (i < 0) i = steps.indexOf(1);
    let next;
    if (dir === 0) next = state.vr ? 1 : 1;
    else if (dir > 1 && !state.vr) next = ZOOMS[Math.min(ZOOMS.length - 1, dir)];
    else next = steps[Math.min(steps.length - 1, Math.max(0, i + dir))];
    if (next === state.zoom) return;
    state.zoom = next;
    state.keepView = true;
    if (state.vr) {
      vrEl.object3D.scale.setScalar(next);
      vrEl._zoomLabel.setAttribute('text', 'value', `${Math.round(next * 100)}%`);
      if (next > 1.2) renderVr(); // re-render sharper for bigger sizes
    } else {
      renderDom();
    }
  }

  function open({ doc, page = 1, title = '', subtitle = '', description = '', onPage = null }) {
    if (state) close();
    const scene = document.querySelector('a-scene');
    state = { doc, page: Math.min(Math.max(1, page), doc.numPages), onPage, title, vr: scene.is('vr-mode'), zoom: 1, keepView: false };
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
