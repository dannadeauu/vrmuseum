/* global AFRAME, THREE, MuseumStore */

/**
 * MuseumItems — turns saved records (see store.js) into exhibits in the scene.
 * Loads for every visitor; admin.js uses it to add, rebuild and remove items.
 */
window.MuseumItems = (() => {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const PLINTH_H = 1;
  const HOVER_GAP = 0.25; // metres between the plinth top and a hovering piece

  const urls = new Map();     // fileId -> blob URL
  const textures = new Map(); // fileId -> THREE.Texture (images)
  const pdfs = new Map();     // fileId -> Promise<PDFDocumentProxy>
  let pdfjsPromise;

  function container() {
    return document.querySelector('#user-exhibits');
  }

  // Exhibits either use an uploaded file (fileId) or link to a file hosted elsewhere
  // (src: a path on this site like "assets/statue.glb", or a full https:// address).
  // Internally both are "keys": the fileId, or "url:" + src.
  const srcKey = (r) => (r.src ? 'url:' + r.src : r.fileId);
  const linkUrl = (key) => new URL(key.slice(4), location.href).href;

  async function fileUrl(fileId) {
    if (fileId.startsWith('url:')) return linkUrl(fileId);
    const pub = MuseumStore.publicUrl(fileId); // online: load straight from Supabase Storage
    if (pub) return pub;
    if (urls.has(fileId)) return urls.get(fileId);
    const file = await MuseumStore.getFile(fileId);
    if (!file) throw new Error('Missing file ' + fileId);
    const url = URL.createObjectURL(file.blob);
    urls.set(fileId, url);
    return url;
  }

  function forgetFile(fileId) {
    if (urls.has(fileId)) URL.revokeObjectURL(urls.get(fileId));
    urls.delete(fileId);
    if (textures.has(fileId)) textures.get(fileId).dispose();
    textures.delete(fileId);
    pdfs.delete(fileId);
  }

  // ---------- helpers used by admin.js when a file is first added ----------

  async function loadImage(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // needed for WebGL textures from Supabase Storage
    img.src = url;
    await img.decode();
    return img;
  }

  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS + 'pdf.min.js';
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = () => reject(new Error('Could not load the PDF viewer (pdf.js)'));
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  // Draw a PDF page into a canvas. pdf.js normally paces this with window.requestAnimationFrame,
  // which the Quest Browser pauses during an immersive VR session, so a page drawn in VR never
  // finished and stayed white. In VR, render with the 'print' intent instead (it doesn't use
  // requestAnimationFrame) and pause between chunks with setTimeout, so the headset keeps its
  // frame rate while the page draws.
  function renderPdfPage(page, ctx, viewport) {
    const scene = document.querySelector('a-scene');
    if (!(scene && scene.is && scene.is('vr-mode'))) return page.render({ canvasContext: ctx, viewport }).promise;
    const task = page.render({ canvasContext: ctx, viewport, intent: 'print' });
    task.onContinue = (cont) => setTimeout(cont, 0);
    return task.promise;
  }
  window.MuseumPdfRender = renderPdfPage; // the big reader (js/pdf-reader.js) uses it too

  async function pdfDoc(fileId) {
    if (!pdfs.has(fileId)) {
      pdfs.set(fileId, (async () => {
        const lib = await loadPdfJs();
        if (fileId.startsWith('url:')) return lib.getDocument({ url: linkUrl(fileId) }).promise;
        const file = await MuseumStore.getFile(fileId);
        const data = new Uint8Array(await file.blob.arrayBuffer());
        return lib.getDocument({ data }).promise;
      })());
      pdfs.get(fileId).catch(() => pdfs.delete(fileId)); // don't remember failures: retry next time
    }
    return pdfs.get(fileId);
  }

  // Inspect a freshly uploaded file: returns { kind, aspect, pageCount }.
  async function inspect(fileId, kind) {
    if (kind === 'image') {
      const img = await loadImage(await fileUrl(fileId));
      return { aspect: img.naturalHeight / img.naturalWidth };
    }
    if (kind === 'pdf') {
      const doc = await pdfDoc(fileId);
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      return { aspect: vp.height / vp.width, pageCount: doc.numPages };
    }
    return { aspect: 1 };
  }

  // For "Add from link": what kind of exhibit an address points to, and its proportions.
  async function inspectLink(src) {
    const kind = kindOf({ name: src.split(/[?#]/)[0], type: '' });
    if (!kind) throw new Error('the address should end in .png, .jpg, .webp, .gif, .pdf, .glb or .gltf');
    const info = await inspect('url:' + src, kind);
    if (kind === 'model') {
      const res = await fetch(linkUrl('url:' + src), { method: 'HEAD' });
      if (!res.ok) throw new Error(`the file wasn't found (HTTP ${res.status})`);
    }
    return { kind, ...info };
  }

  function kindOf(file) {
    const name = file.name.toLowerCase();
    if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (name.endsWith('.glb') || name.endsWith('.gltf')) return 'model';
    if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif)$/.test(name)) return 'image';
    return null;
  }

  // ---------- building entities ----------

  function setMap(el, map) {
    const apply = () => {
      const mesh = el.getObject3D('mesh');
      if (mesh) mesh.material = new THREE.MeshBasicMaterial({ map });
    };
    if (el.hasLoaded) apply(); else el.addEventListener('loaded', apply, { once: true });
  }

  function exhibitAttr(r, extra) {
    return Object.assign({
      title: r.title || 'Untitled',
      artist: r.artist || '',
      year: r.year || '',
      description: r.description || ''
    }, r.kind === 'pdf' ? { panel: false, hint: '(click / trigger to read)' } : {},
    r.kind === 'whiteboard' ? { panel: false, hint: 'Pick a colour below and draw', frameColor: '#b7bbc1', hoverGrow: false } : {},
    extra);
  }

  function baseEntity(r) {
    const el = document.createElement('a-entity');
    el.classList.add('clickable');
    el.dataset.itemId = r.id;
    el.setAttribute('position', r.position);
    el.setAttribute('rotation', { x: 0, y: r.rotationY || 0, z: 0 });
    return el;
  }

  // ---------- flat items (images and PDFs): on a wall, or standing on the floor ----------

  const FRAME = 0.08; // frame border added by the exhibit component

  const onFloor = (r) => r.mount === 'floor';

  // Height of the picture's centre when it stands on the floor.
  function floorCenterY(r) {
    const h = r.size * (r.aspect || 1);
    if (!r.stand) return h / 2 + FRAME + 0.04; // resting on its small feet
    // On a stand: aim for eye level (~1.5 m), but keep a visible post and stay under ~2.6 m.
    const minBottom = r.kind === 'pdf' || r.kind === 'whiteboard' ? 0.6 : 0.45; // room for controls underneath
    const bottom = Math.min(1.2, Math.max(minBottom, 1.5 - h / 2));
    return bottom + h / 2;
  }

  function box(w, h, d, x, y, z, color) {
    const b = document.createElement('a-box');
    b.classList.add('clickable'); // so the stand can be clicked to select its picture
    b.setAttribute('width', w);
    b.setAttribute('height', h);
    b.setAttribute('depth', d);
    b.setAttribute('position', `${x} ${y} ${z}`);
    b.setAttribute('color', color);
    return b;
  }

  // Children are positioned relative to the picture's centre; the floor is at -cy.
  function addStand(el, r, w, h, cy) {
    const floor = -cy;
    const wood = '#2b2119';
    const metal = '#3b3b3f';
    if (r.stand) {
      el.appendChild(box(0.06, cy, 0.06, 0, floor + cy / 2, -0.11, metal));            // post up to the centre
      el.appendChild(box(0.6, 0.04, 0.45, 0, floor + 0.02, -0.11, metal));              // base plate
      el.appendChild(box(w + 0.24, 0.04, 0.14, 0, -h / 2 - FRAME - 0.02, -0.01, wood)); // ledge it rests on
    } else {
      [-1, 1].forEach((side) =>
        el.appendChild(box(0.08, 0.04, 0.32, side * w / 3, floor + 0.02, -0.035, wood))); // two feet
    }
  }

  function flatEntity(r) {
    const w = r.size;
    const h = r.size * (r.aspect || 1);
    const pdf = r.kind === 'pdf';
    const el = baseEntity(r);
    el.setAttribute('width', w);   // read by the exhibit component
    el.setAttribute('height', h);
    el.setAttribute('geometry', { primitive: 'plane', width: w, height: h });
    el.setAttribute('material', { shader: 'flat', color: '#ffffff' });

    if (!onFloor(r)) {
      el.setAttribute('exhibit', exhibitAttr(r));
      return el;
    }

    const cy = floorCenterY(r);
    el.setAttribute('position', { x: r.position.x, y: cy, z: r.position.z });
    addStand(el, r, w, h, cy);
    addShadow(el, w + 0.3, r.stand ? 0.7 : 0.45, -cy);
    const extra = {};
    if (r.stand && r.kind !== 'whiteboard') { // (a whiteboard's controls go there; its plaque stays to the right)
      // Plaque on the post, under the picture (and under the PDF page buttons).
      extra.plaqueOffset = `0 ${-h / 2 - FRAME - (pdf ? 0.45 : 0.28)} 0.01`;
    } else if (pdf) {
      // No room under a PDF resting near the floor, so its page buttons go on top; lift the description panel above them.
      extra.panelOffset = `0 ${h / 2 + 0.9} 0.05`;
    }
    el.setAttribute('exhibit', exhibitAttr(r, extra));
    return el;
  }

  // Where the PDF page buttons go: under the page, or on top for a PDF standing on the floor without a stand.
  function pdfControlsY(r) {
    const h = r.size * (r.aspect || 1);
    if (onFloor(r)) return r.stand ? -h / 2 - 0.25 : h / 2 + FRAME + 0.15; // clear the stand's ledge
    return -h / 2 - 0.2;
  }

  async function buildImage(r) {
    const el = flatEntity(r);
    const key = srcKey(r);
    if (!textures.has(key)) {
      const img = await loadImage(await fileUrl(key));
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      textures.set(key, tex);
    }
    setMap(el, textures.get(key));
    return el;
  }

  async function buildPdf(r) {
    const el = flatEntity(r);
    const doc = await pdfDoc(srcKey(r));
    let pageNum = 1;
    let rendering = Promise.resolve();
    let shown = null; // texture currently on screen

    // Each page is drawn into its own canvas and only shown once fully rendered, as a
    // fresh texture. (A texture uploaded while the canvas was still blank keeps that
    // first size on the GPU, so a later, bigger page can't replace it: it stays black.)
    const showPage = (canvas) => {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const apply = () => {
        const mesh = el.getObject3D('mesh');
        if (!mesh) return;
        const old = mesh.material;
        mesh.material = new THREE.MeshBasicMaterial({ map: tex });
        if (old && old.dispose) old.dispose();
        if (shown) shown.dispose();
        shown = tex;
      };
      if (el.hasLoaded) apply(); else el.addEventListener('loaded', apply, { once: true });
    };

    const label = document.createElement('a-entity');
    const render = (n) => {
      rendering = rendering.then(async () => {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 1536 / base.width }); // ~1.5k px wide: sharp, still Quest-friendly
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // paper colour behind transparent PDFs
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await renderPdfPage(page, ctx, vp);
        showPage(canvas);
        label.setAttribute('text', { value: `${n} / ${doc.numPages}`, align: 'center', color: '#2b2119', width: 1 });
      });
    };
    render(1); // the page shows white until the first render is ready

    // Page controls under the document (work with the mouse and VR lasers).
    const y = pdfControlsY(r);
    label.setAttribute('position', `0 ${y} 0.01`);
    el.appendChild(label);

    if (doc.numPages > 1) {
      [['prev', '<', -1], ['next', '>', 1]].forEach(([name, glyph, dir]) => {
        const btn = document.createElement('a-entity');
        btn.classList.add('clickable');
        btn.setAttribute('position', `${dir * 0.35} ${y} 0.01`);
        btn.setAttribute('geometry', 'primitive: plane; width: 0.22; height: 0.16');
        btn.setAttribute('material', 'shader: flat; color: #2b2119');
        btn.setAttribute('text', { value: glyph, align: 'center', color: '#faf8f4', width: 2 });
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also toggle the description
          if (el.sceneEl.is('admin-mode')) return;
          const next = Math.min(doc.numPages, Math.max(1, pageNum + dir));
          if (next !== pageNum) { pageNum = next; render(pageNum); }
        });
        el.appendChild(btn);
      });
    }

    // Click the document to read it big: a reader in the middle of the screen (or, in VR,
    // a floating panel in front of you). It opens at this page and the wall follows along.
    el.addEventListener('click', () => {
      if (el.sceneEl.is('admin-mode') || !window.PdfReader) return;
      window.PdfReader.open({
        doc,
        page: pageNum,
        title: r.title || 'Document',
        subtitle: [r.artist, r.year].filter(Boolean).join(', '),
        description: r.description || '',
        onPage: (n) => { if (n !== pageNum) { pageNum = n; render(pageNum); } }
      });
    });
    return el;
  }

  // Soft round contact shadow on the floor (the room's own lighting is baked,
  // so movable things carry their own shadow with them). y is relative to el.
  let shadowTex;
  function addShadow(el, w, d, y = 0) {
    if (!shadowTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(25,15,5,0.55)');
      gr.addColorStop(0.55, 'rgba(25,15,5,0.25)');
      gr.addColorStop(1, 'rgba(25,15,5,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      shadowTex = new THREE.CanvasTexture(c);
    }
    const sh = document.createElement('a-entity');
    sh.setAttribute('geometry', { primitive: 'plane', width: w * 1.6, height: d * 1.6 });
    sh.setAttribute('rotation', '-90 0 0');
    sh.setAttribute('position', `0 ${y + 0.012} 0`);
    sh.addEventListener('loaded', () => {
      sh.getObject3D('mesh').material = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    }, { once: true });
    el.appendChild(sh);
  }

  // Things that stand on the floor (3D models, the starter sculpture): optional plinth with
  // the piece on top, a plaque and a description panel. `contentY` lifts the piece above its base.
  function floorPiece(r, content, contentY = 0) {
    const el = baseEntity(r);
    const lift = r.plinth ? PLINTH_H : 0;
    // Pillar plinth: a dark-brown round column between a square base and a square cap.
    const shaftR = Math.max(0.31, r.size * 0.38);
    const pw = shaftR * 2 + 0.16; // footprint of the base and cap

    if (r.plinth) {
      const part = (tag, attrs) => {
        const p = document.createElement(tag);
        p.classList.add('clickable'); // the pointer ray only tests elements marked clickable, not their children
        Object.entries(attrs).forEach(([k, v]) => p.setAttribute(k, v));
        el.appendChild(p);
      };
      const dark = 'color: #2f2118; roughness: 0.55; metalness: 0.05';
      const mid = 'color: #3d2b1f; roughness: 0.5; metalness: 0.05';
      const ring = 'color: #4a3527; roughness: 0.45; metalness: 0.08';
      const B = 0.12, C = 0.1; // base and cap slab heights
      part('a-box', { width: pw, depth: pw, height: B, position: `0 ${B / 2} 0`, material: dark });                       // base slab
      part('a-cylinder', { radius: shaftR + 0.05, height: 0.05, 'segments-radial': 32, position: `0 ${B + 0.025} 0`, material: ring }); // base moulding
      part('a-cylinder', {                                                                                                // column shaft
        radius: shaftR, height: PLINTH_H - B - C - 0.1, 'segments-radial': 32,
        position: `0 ${B + 0.05 + (PLINTH_H - B - C - 0.1) / 2} 0`, material: mid
      });
      part('a-cylinder', { radius: shaftR + 0.05, height: 0.05, 'segments-radial': 32, position: `0 ${PLINTH_H - C - 0.025} 0`, material: ring }); // neck moulding
      part('a-box', { width: pw, depth: pw, height: C, position: `0 ${PLINTH_H - C / 2} 0`, material: dark });             // cap slab
    }
    addShadow(el, r.plinth ? pw : r.size, r.plinth ? pw : r.size);

    content.classList.add('outline-target', 'clickable');
    const hover = r.hover ? HOVER_GAP : 0; // "Hover": float a little above the plinth (or floor)
    content.setAttribute('position', `0 ${lift + hover + contentY} 0`);
    // Optional slow turntable spin (the starter knot spins unless switched off).
    if (r.spin ?? r.kind === 'knot') content.setAttribute('slow-spin', '');
    el.appendChild(content);

    const front = r.plinth ? shaftR + 0.02 : r.size / 2 + 0.3; // plaque sits on the column's face
    el.setAttribute('exhibit', exhibitAttr(r, {
      frame: false,
      plaqueOffset: r.plinth ? `0 ${PLINTH_H - 0.25} ${front}` : `0 0.3 ${front}`,
      panelOffset: `0 ${lift + hover + r.size + 0.6} 0`
    }));
    return el;
  }

  async function buildModel(r) {
    const model = document.createElement('a-entity');
    model.setAttribute('gltf-model', await fileUrl(srcKey(r)));
    model.addEventListener('model-loaded', () => fitModel(model, r.size));
    return floorPiece(r, model);
  }

  // The starter bronze knot sculpture (no file needed).
  function buildKnot(r) {
    const knot = document.createElement('a-torus-knot');
    knot.setAttribute('radius', 0.28);
    knot.setAttribute('radius-tubular', 0.06);
    knot.setAttribute('material', 'color: #b08d57; metalness: 0.6; roughness: 0.35');
    knot.setAttribute('scale', `${r.size / 0.68} ${r.size / 0.68} ${r.size / 0.68}`); // knot is ~0.68 m across
    return floorPiece(r, knot, r.size / 2);
  }

  // ---------- bench: a "waterfall" bench of laminated pine, the same wood as the floor ----------
  // A thick slab whose ends turn down into two full-depth legs. `size` is its length.
  const BENCH_H = 0.45, BENCH_D = 0.4, BENCH_T = 0.09; // height, depth, slab/leg thickness (metres)

  // Seamless 1 m x 1 m tile of glued-up pine strips running along u, coloured like the floor planks.
  let benchWoodTex;
  function benchWood() {
    if (benchWoodTex) return benchWoodTex;
    const { canvas, rng } = window.MuseumArch;
    const S = 1024, strips = 26, sw = S / strips;
    const [c, g] = canvas(S, S);
    const r = rng(5150);
    g.fillStyle = '#ddbb87';
    g.fillRect(0, 0, S, S);
    for (let k = 0; k < strips; k++) {
      const y = k * sw;
      let x = -r() * S;
      while (x < S) {
        const len = (0.9 + r() * 1.6) * S;
        const col = `hsl(${33 + r() * 6}, ${50 + r() * 12}%, ${71 + r() * 8}%)`;
        const grains = Array.from({ length: 5 }, () => [1.5 + r() * (sw - 3), (r() - 0.5) * 5, (r() - 0.5) * 5, 0.07 + r() * 0.1]);
        const knots = Array.from({ length: Math.floor(r() * 2.4) }, () => [r() * len, 2 + r() * 5]);
        for (const off of [0, -S, S]) { // draw again shifted so strips wrap seamlessly
          const px = x + off;
          if (px > S || px + len < 0) continue;
          g.fillStyle = col;
          g.fillRect(px, y, len, sw);
          grains.forEach(([gy, a, b, alpha]) => {
            g.strokeStyle = `rgba(150,95,40,${alpha})`;
            g.lineWidth = 1.1;
            g.beginPath();
            g.moveTo(px, y + gy);
            g.bezierCurveTo(px + len * 0.3, y + gy + a, px + len * 0.7, y + gy + b, px + len, y + gy);
            g.stroke();
          });
          knots.forEach(([kx, kr]) => { // small dark pin knots, as in douglas fir
            g.fillStyle = 'rgba(120,72,30,0.55)';
            g.beginPath(); g.ellipse(px + kx, y + sw / 2, kr * 1.6, kr, 0, 0, Math.PI * 2); g.fill();
          });
          g.fillStyle = 'rgba(110,70,30,0.3)';
          g.fillRect(px + len - 1, y, 1.2, sw); // finger joint
        }
        x += len;
      }
      g.fillStyle = 'rgba(110,70,30,0.22)';
      g.fillRect(0, y, S, 1); // glue line
    }
    benchWoodTex = new THREE.CanvasTexture(c);
    benchWoodTex.colorSpace = THREE.SRGBColorSpace;
    benchWoodTex.wrapS = benchWoodTex.wrapT = THREE.RepeatWrapping;
    benchWoodTex.anisotropy = 4;
    return benchWoodTex;
  }

  // One box of the bench, with UVs in metres (grain along `grain`: 'x' or 'y') and baked
  // ambient occlusion in its vertex colours.
  function benchPart(w, h, d, cx, cy, grain, occlusion) {
    const geo = new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w / 0.05)), Math.max(1, Math.round(h / 0.03)), 6);
    geo.translate(cx, cy, 0);
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = nor.getX(i), ny = nor.getY(i);
      // Face axes: pick the in-face coordinate that runs along the grain for u.
      let u, v;
      if (Math.abs(nx) > 0.5) { u = grain === 'y' ? y : z; v = grain === 'y' ? z : y; }
      else if (Math.abs(ny) > 0.5) { u = x; v = z; }
      else { u = grain === 'y' ? y : x; v = grain === 'y' ? x : y; }
      uv.setXY(i, u + 0.37, v + 0.11);
      const o = occlusion(x, y, z, nx, ny);
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = o;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }

  function benchMesh(L) {
    const H = BENCH_H, T = BENCH_T, D = BENCH_D;
    const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const mix = (a, b, t) => a + (b - a) * t;
    const inner = L / 2 - T;   // x of the legs' inner faces
    const under = H - T;       // height of the slab's underside
    // Ambient occlusion for a point on the bench (local metres) with face normal (nx, ny).
    const occlusion = (x, y, z, nx, ny) => {
      // At the floor the leg takes the floor shadow's shade, fading out up the leg, so the two blend.
      let o = mix(1 - 0.75 * benchShadowAlpha(L, x, z), 1, smooth(0, 0.2, y));
      const edge = mix(0.85, 1, smooth(0, 0.05, D / 2 - Math.abs(z)));      // the open front/back let light in
      if (ny < -0.5 && y < H - T / 2) {                                     // slab underside
        o *= 0.42 * mix(0.7, 1, smooth(0, 0.25, inner - Math.abs(x))) / edge;
        o *= mix(1.25, 1, smooth(0, 0.08, D / 2 - Math.abs(z)));
      } else if (Math.abs(nx) > 0.5 && Math.abs(x) < inner + 0.001 && Math.sign(nx) === -Math.sign(x)) { // legs' inner faces
        o *= 0.6 * mix(0.72, 1, smooth(0, 0.22, under - y)) * edge;
      } else if (Math.abs(nx) < 0.5 && Math.abs(ny) < 0.5 && Math.abs(x) < inner && y < under + 0.001) {
        o *= 0.75; // inner edges of the legs seen from the front
      }
      if (ny > 0.5) o = 1;                                                  // top face: open to the sky
      return Math.min(1, o);
    };
    const parts = [
      benchPart(L, T, D, 0, H - T / 2, 'x', occlusion),                           // seat slab
      benchPart(T, H - T, D, -L / 2 + T / 2, (H - T) / 2, 'y', occlusion),   // left leg
      benchPart(T, H - T, D, L / 2 - T / 2, (H - T) / 2, 'y', occlusion)     // right leg
    ];
    const mat = new THREE.MeshStandardMaterial({ map: benchWood(), vertexColors: true, roughness: 0.82, metalness: 0 });
    const group = new THREE.Group();
    parts.forEach((geo) => group.add(new THREE.Mesh(geo, mat)));
    return group;
  }

  // Contact shadow baked for the bench's footprint: tight and dark under the legs, a soft
  // shade under the seat, fading out around it. Multiplied onto the floor.
  // How dark the bench's shadow is on the floor at (x, z), bench-local metres (0..0.85 alpha).
  // Shared by the floor shadow and the base of the legs, so the two meet without a seam.
  const boxDist = (x, z, bx, hx, hz) => Math.hypot(Math.max(Math.abs(x - bx) - hx, 0), Math.max(Math.abs(z) - hz, 0));
  function benchShadowAlpha(L, x, z) {
    const dl = Math.min(boxDist(x, z, -L / 2 + BENCH_T / 2, BENCH_T / 2, BENCH_D / 2),
                        boxDist(x, z, L / 2 - BENCH_T / 2, BENCH_T / 2, BENCH_D / 2));
    const legs = 0.32 * Math.exp(-dl / 0.07) + 0.18 * Math.exp(-dl / 0.2);
    const ds = boxDist(x, z, 0, L / 2, BENCH_D / 2);
    const depthIn = Math.min(L / 2 - Math.abs(x), BENCH_D / 2 - Math.abs(z)); // >0 under the seat
    const seat = ds > 0 ? 0.42 * Math.exp(-ds / 0.14) : 0.42 + 0.2 * Math.min(1, depthIn / 0.15);
    return Math.min(0.85, 1 - (1 - Math.min(1, legs)) * (1 - seat));
  }

  const benchShadowTex = {};
  function benchShadow(L) {
    const key = L.toFixed(2);
    if (benchShadowTex[key]) return benchShadowTex[key];
    const pad = 0.45, W = L + pad * 2, Dd = BENCH_D + pad * 2, ppm = 128;
    const cw = Math.round(W * ppm), ch = Math.round(Dd * ppm);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    const img = g.createImageData(cw, ch);
    for (let j = 0; j < ch; j++) {
      const z = (j + 0.5) / ppm - Dd / 2;
      for (let i = 0; i < cw; i++) {
        const x = (i + 0.5) / ppm - W / 2;
        const a = benchShadowAlpha(L, x, z);
        const o = (j * cw + i) * 4;
        img.data[o] = 28; img.data[o + 1] = 17; img.data[o + 2] = 6;
        img.data[o + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return (benchShadowTex[key] = { tex, W, D: Dd });
  }

  function buildBench(r) {
    const el = baseEntity(r);
    const L = Math.max(0.6, r.size);
    const body = document.createElement('a-entity');
    body.classList.add('outline-target', 'clickable');
    body.setObject3D('mesh', benchMesh(L));
    el.appendChild(body);

    const { tex, W, D } = benchShadow(L);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(W, D),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.006;
    sh.renderOrder = 1;
    sh.raycast = () => {}; // not a click target
    el.object3D.add(sh);
    return el;
  }

  // ---------- signs: lettering in Playfair Display drawn onto a plate ----------
  const SIGN_STYLES = {
    bronze: { plate: '#2b2119', ink: '#d9b56c', rule: 'rgba(217,181,108,0.55)' },
    stone: { plate: '#efe9df', ink: '#3a2f27', rule: 'rgba(58,47,39,0.35)' },
    navy: { plate: '#26324a', ink: '#e8d3a0', rule: 'rgba(232,211,160,0.5)' },
    'letters-dark': { plate: null, ink: '#3a2f27' },
    'letters-light': { plate: null, ink: '#f4efe6' }
  };
  const SIGN_FONT = '"Playfair Display", Georgia, "Times New Roman", serif';
  let fontReady;
  function signFont() {
    // Loaded from Google Fonts in index.html; falls back to Georgia if offline.
    if (!fontReady) {
      fontReady = Promise.all([
        document.fonts.load(`700 120px ${SIGN_FONT}`),
        document.fonts.load(`400 120px ${SIGN_FONT}`)
      ]).catch(() => null);
    }
    return fontReady;
  }

  async function signCanvas(r) {
    await signFont();
    const style = SIGN_STYLES[r.style] || SIGN_STYLES.bronze;
    const lines = String(r.text || ' ').split('\n').map((l) => l.trim() || ' ');
    const FS = 140, LH = 190, PADX = 130, PADY = 80;
    const font = `${r.bold === false ? 400 : 700} ${FS}px ${SIGN_FONT}`;
    const m = document.createElement('canvas').getContext('2d');
    m.font = font;
    if ('letterSpacing' in m) m.letterSpacing = '0.08em';
    const textW = Math.max(...lines.map((l) => m.measureText(l).width), FS);
    const W = Math.min(4096, Math.ceil(textW + PADX * 2));
    const H = Math.ceil(lines.length * LH + PADY * 2);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (style.plate) {
      g.fillStyle = style.plate;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = style.rule; // fine inset border
      g.lineWidth = 6;
      g.strokeRect(28, 28, W - 56, H - 56);
    }
    g.font = font;
    if ('letterSpacing' in g) g.letterSpacing = '0.08em';
    g.fillStyle = style.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const scale = Math.min(1, (W - PADX * 2) / textW); // squeeze very long lines to fit 4096 px
    lines.forEach((l, i) => {
      g.save();
      g.translate(W / 2, PADY + LH * (i + 0.5) + FS * 0.04);
      g.scale(scale, 1);
      g.fillText(l, 0, 0);
      g.restore();
    });
    return c;
  }

  // Height / width of a sign, for placement before it's built.
  async function signAspect(r) {
    const c = await signCanvas(r);
    return c.height / c.width;
  }

  async function buildSign(r) {
    const c = await signCanvas(r);
    r.aspect = c.height / c.width;
    const w = r.size, h = r.size * r.aspect;
    const style = SIGN_STYLES[r.style] || SIGN_STYLES.bronze;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const el = baseEntity(r);
    el.setAttribute('geometry', { primitive: 'plane', width: w, height: h });
    el.setAttribute('material', { shader: 'flat', color: '#ffffff' });
    el.addEventListener('loaded', () => {
      el.getObject3D('mesh').material = new THREE.MeshBasicMaterial({
        map: tex, transparent: !style.plate, alphaTest: style.plate ? 0 : 0.05
      });
    }, { once: true });
    if (onFloor(r)) {
      const cy = floorCenterY(r);
      el.setAttribute('position', { x: r.position.x, y: cy, z: r.position.z });
      addStand(el, r, w, h, cy);
      addShadow(el, w + 0.3, r.stand ? 0.7 : 0.45, -cy);
    }
    return el;
  }


  // ---------- avatar station: change your own robot's colour, hat and eyes ----------
  // Everyone sees THEIR OWN robot above the platform. Choices save in this browser
  // (and come back next visit) and update your robot for other visitors right away.
  const HAT_LABEL = { none: 'No hat', cowboy: 'Cowboy hat', headset: 'VR headset' };
  const EYE_LABEL = { happy: 'Happy eyes', open: 'Open eyes', wink: 'Wink' };

  function canvasTexture(draw, size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  let wheelTex;
  function hueWheelTexture() {
    if (wheelTex) return wheelTex;
    wheelTex = canvasTexture((g, S) => {
      const c = S / 2, R = S / 2 - 2, r = S / 4;
      for (let d = 0; d < 360; d += 1) { // one thin wedge per degree: hue = angle
        const a0 = (d - 0.6) * Math.PI / 180, a1 = (d + 0.6) * Math.PI / 180;
        g.fillStyle = `hsl(${d}, 85%, 55%)`;
        g.beginPath();
        g.arc(c, c, R, a0, a1);
        g.arc(c, c, r, a1, a0, true);
        g.closePath();
        g.fill();
      }
    }, 512);
    return wheelTex;
  }

  // Text with a soft translucent pill behind it, readable on any wall or painting.
  let pillTex;
  function pillTexture() {
    if (pillTex) return pillTex;
    pillTex = canvasTexture((g, S) => {
      const h = S / 4, r = h / 2;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(r, 0); g.lineTo(S - r, 0); g.arc(S - r, r, r, -Math.PI / 2, Math.PI / 2);
      g.lineTo(r, h); g.arc(r, r, r, Math.PI / 2, -Math.PI / 2); g.closePath(); g.fill();
    }, 512);
    pillTex.repeat.set(1, 0.25); // only the top quarter holds the pill shape
    pillTex.offset.set(0, 0.75);
    return pillTex;
  }
  function pillLabel(text, x, y, { width = 0.9, color = '#f4f2ee' } = {}) {
    const el = document.createElement('a-entity');
    el.setAttribute('position', `${x} ${y} 0`);
    const pill = document.createElement('a-entity');
    pill.setAttribute('position', '0 0 -0.002');
    pill.addEventListener('loaded', () => {
      pill.getObject3D('mesh').material = new THREE.MeshBasicMaterial({
        map: pillTexture(), color: 0x14151a, transparent: true, opacity: 0.6, depthWrite: false
      });
    }, { once: true });
    el.appendChild(pill);
    const set = (value) => {
      const w = Math.max(0.2, value.length * width * 0.026 + 0.08); // roughly fits the text
      const h = 0.065 * (width / 0.9);
      pill.setAttribute('geometry', { primitive: 'plane', width: w, height: h });
      el.setAttribute('text', { value, align: 'center', color, width });
    };
    set(text);
    return { el, set };
  }

  // A small turning 3D preview of just the part being chosen: your hat on its own ('hat'),
  // or your visor and eyes ('eyes'). Rebuilt whenever you change your look.
  AFRAME.registerComponent('look-preview', {
    schema: { part: { default: 'hat' } },
    init() {
      this.build = () => {
        const A = window.MuseumAvatar;
        if (!A) return;
        const look = A.look;
        const robot = A.makeRobot(look);
        const frame = new THREE.Group(); // stands in for the head, so parts keep their shape
        if (this.data.part === 'eyes') {
          const skull = robot.head.children.find((o) => o.isMesh && o.getObjectByName('visor'));
          frame.scale.copy(skull.scale); // the face plate follows the head's oval shape
          skull.children.filter((o) => o.name === 'visor' || o.name === 'eye').forEach((o) => frame.add(o));
        } else if (look.hat === 'none') {
          // "No hat": a small grey crossed-out circle.
          const grey = new THREE.MeshBasicMaterial({ color: 0xb9b2a6 });
          frame.add(new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.009, 8, 40), grey));
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.016, 0.016), grey);
          bar.rotation.z = Math.PI / 4;
          frame.add(bar);
        } else {
          robot.head.children.filter((o) => o.name === 'hat').forEach((o) => {
            o.rotation.x = look.hat === 'headset' ? 0.15 : o.rotation.x; // headset: show the goggles face-on
            frame.add(o);
          });
        }
        // Centre whatever was picked on this spot.
        const holder = new THREE.Group();
        holder.add(frame);
        holder.updateMatrixWorld(true);
        const c = new THREE.Box3().setFromObject(frame).getCenter(new THREE.Vector3());
        frame.position.sub(c);
        this.el.setObject3D('mesh', holder);
      };
      this.build();
      if (window.MuseumAvatar) this.off = window.MuseumAvatar.onChange(this.build);
    },
    tick(t) {
      const m = this.el.getObject3D('mesh');
      if (!m) return;
      // Hats turn all the way round; the eyes sway gently so they stay facing you.
      m.rotation.y = this.data.part === 'hat' ? t / 2200 : Math.sin(t / 1800) * 0.35;
    },
    remove() { if (this.off) this.off(); }
  });

  function flatPanel(tex, w, h, extra = {}) {
    const e = document.createElement('a-entity');
    e.setAttribute('geometry', { primitive: 'plane', width: w, height: h });
    e.setAttribute('material', { shader: 'flat', transparent: true, alphaTest: 0.05, side: 'double' });
    e.addEventListener('loaded', () => { e.getObject3D('mesh').material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05 }); }, { once: true });
    Object.entries(extra).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  function roundButton(glyph, x, y, onClick) {
    const b = document.createElement('a-entity');
    b.classList.add('clickable');
    b.setAttribute('geometry', { primitive: 'circle', radius: 0.05, segments: 32 });
    b.setAttribute('material', { shader: 'flat', color: '#f4f2ee' });
    b.setAttribute('text', { value: glyph, align: 'center', color: '#1b1b1f', width: 0.9, zOffset: 0.002 });
    b.setAttribute('position', `${x} ${y} 0.01`);
    b.addEventListener('mouseenter', () => b.setAttribute('material', 'color', '#ffd28a'));
    b.addEventListener('mouseleave', () => b.setAttribute('material', 'color', '#f4f2ee'));
    b.addEventListener('click', (e) => {
      if (b.sceneEl.is('admin-mode')) return; // admins clicking select the station instead
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // Your own robot, floating above the platform; rebuilt whenever you change your look.
  AFRAME.registerComponent('avatar-preview', {
    init() {
      this.build = () => {
        if (!window.MuseumAvatar) return;
        const robot = window.MuseumAvatar.makeRobot(window.MuseumAvatar.look);
        this.el.setObject3D('mesh', robot.root);
      };
      this.build();
      if (window.MuseumAvatar) this.off = window.MuseumAvatar.onChange(this.build);
      this.t = 0;
    },
    tick(t, dt) {
      const m = this.el.getObject3D('mesh');
      if (!m) return;
      m.rotation.y = Math.sin(t / 2200) * 0.6; // gentle turn so you can see the sides
      m.position.y = Math.sin(t / 700) * 0.015;
    },
    remove() { if (this.off) this.off(); }
  });

  function buildCustomizer(r) {
    const el = baseEntity(r);
    const A = window.MuseumAvatar;

    // Platform (click it in admin mode to move or rotate the station).
    const plat = document.createElement('a-cylinder');
    plat.classList.add('outline-target', 'clickable');
    plat.setAttribute('radius', 0.72);
    plat.setAttribute('height', 0.14);
    plat.setAttribute('segments-radial', 48);
    plat.setAttribute('position', '0 0.07 0');
    plat.setAttribute('material', 'color: #3c3e44; roughness: 0.6');
    el.appendChild(plat);
    const rim = document.createElement('a-torus');
    rim.classList.add('clickable');
    rim.setAttribute('radius', 0.72);
    rim.setAttribute('radius-tubular', 0.012);
    rim.setAttribute('segments-tubular', 64);
    rim.setAttribute('rotation', '90 0 0');
    rim.setAttribute('position', '0 0.14 0');
    rim.setAttribute('material', 'color: #c9a35c; metalness: 0.5; roughness: 0.4');
    el.appendChild(rim);
    addShadow(el, 1.6, 1.6);

    const preview = document.createElement('a-entity');
    preview.setAttribute('position', '0 1.12 0');
    preview.setAttribute('avatar-preview', '');
    el.appendChild(preview);

    if (!A) return el; // multiplayer script missing: just the platform

    const PY = 1.95; // panel row height
    // Hue wheel: click a colour on the ring.
    const wheel = flatPanel(hueWheelTexture(), 0.44, 0.44);
    wheel.classList.add('clickable');
    wheel.setAttribute('position', `-0.6 ${PY} 0`);
    const knob = document.createElement('a-entity');
    knob.setAttribute('geometry', { primitive: 'ring', radiusInner: 0.024, radiusOuter: 0.036, segmentsTheta: 32 });
    knob.setAttribute('material', { shader: 'flat', color: '#ffffff' });
    const knobFill = document.createElement('a-entity');
    knobFill.setAttribute('geometry', { primitive: 'circle', radius: 0.024, segments: 24 });
    knob.appendChild(knobFill);
    wheel.appendChild(knob);
    const placeKnob = (hue) => {
      const a = hue * Math.PI / 180, rr = 0.165; // middle of the ring (0.11 to 0.22 m)
      knob.setAttribute('position', `${Math.cos(a) * rr} ${-Math.sin(a) * rr} 0.004`);
      knobFill.setAttribute('material', { shader: 'flat', color: '#' + A.hueColour(hue).getHexString() });
    };
    placeKnob(A.look.hue);
    wheel.addEventListener('click', (e) => {
      if (wheel.sceneEl.is('admin-mode')) return;
      const hit = e.detail && e.detail.intersection;
      if (!hit || !hit.uv) return;
      const dx = hit.uv.x - 0.5, dy = 0.5 - hit.uv.y;
      const rad = Math.hypot(dx, dy);
      if (rad < 0.2 || rad > 0.52) return; // clicked the hole in the middle
      e.stopPropagation();
      A.setLook({ hue: Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) });
    });
    el.appendChild(wheel);
    el.appendChild(pillLabel('Colour', -0.6, PY - 0.3).el);

    // Hat and eyes: a small turning 3D preview of your head + < > buttons that cycle options.
    const selector = (x, list, key, part, labels) => {
      const preview = document.createElement('a-entity');
      preview.setAttribute('position', `${x} ${PY + 0.06} 0`);
      preview.setAttribute('scale', part === 'eyes' ? '1.5 1.5 1.5' : '1.1 1.1 1.1');
      preview.setAttribute('look-preview', { part });
      el.appendChild(preview);
      const label = pillLabel('', x, PY - 0.3);
      el.appendChild(label.el);
      const show = (value) => label.set(labels[value]);
      const step = (dir) => {
        const i = list.indexOf(A.look[key]);
        A.setLook({ [key]: list[(i + dir + list.length) % list.length] });
      };
      el.appendChild(roundButton('<', x - 0.09, PY - 0.17, () => step(-1)));
      el.appendChild(roundButton('>', x + 0.09, PY - 0.17, () => step(1)));
      show(A.look[key]);
      return show;
    };
    const showHat = selector(0, A.HATS, 'hat', 'hat', HAT_LABEL);
    const showEyes = selector(0.6, A.EYES, 'eyes', 'eyes', EYE_LABEL);

    el.appendChild(pillLabel('Customise your robot', 0, PY + 0.34, { width: 1.6, color: '#e8d3a0' }).el);

    // Keep the panels in step with your look (also if you change it elsewhere).
    const off = A.onChange((look) => { placeKnob(look.hue); showHat(look.hat); showEyes(look.eyes); });
    // Stop listening once this station is removed or rebuilt.
    const obs = new MutationObserver(() => { if (!el.isConnected) { off(); obs.disconnect(); } });
    el.addEventListener('loaded', () => obs.observe(el.parentNode, { childList: true }), { once: true });
    return el;
  }

  // Whiteboard: a framed board anyone can draw on (js/whiteboard.js), with colours, a brush-size
  // slider and Clear in a row under the frame (or above it, when it rests on the floor on feet).
  function buildWhiteboard(r) {
    const el = flatEntity(r);
    const h = r.size * (r.aspect || 1);
    const y = !onFloor(r) ? -h / 2 - FRAME - 0.12
      : r.stand ? -h / 2 - FRAME - 0.16   // under the stand's ledge
        : h / 2 + FRAME + 0.12;           // no room underneath
    return window.MuseumBoards.attach(el, r, y);
  }

  // Starter paintings: generated abstract art (placeholder-art) until replaced.
  function buildPlaceholder(r) {
    const el = flatEntity(r);
    el.setAttribute('placeholder-art', { seed: r.seed || 1 });
    return el;
  }

  // Scale a model so its largest side is `size` metres, centred, sitting on y=0.
  function fitModel(modelEl, size) {
    const mesh = modelEl.getObject3D('mesh');
    if (!mesh) return;
    mesh.scale.setScalar(1);
    mesh.position.set(0, 0, 0);
    modelEl.object3D.updateMatrixWorld(true);

    const toLocal = modelEl.object3D.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    const m = new THREE.Matrix4();
    mesh.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      // Combine the matrices first: transforming a box twice inflates it when rotated.
      m.multiplyMatrices(toLocal, o.matrixWorld);
      tmp.copy(o.geometry.boundingBox).applyMatrix4(m);
      box.union(tmp);
    });
    if (box.isEmpty()) return;

    const dims = box.getSize(new THREE.Vector3());
    const s = size / Math.max(dims.x, dims.y, dims.z, 1e-6);
    const c = box.getCenter(new THREE.Vector3());
    mesh.scale.setScalar(s);
    mesh.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  }

  const buildToken = new Map(); // id -> latest build request, so stale rebuilds are dropped

  async function build(record) {
    const make = {
      image: buildImage, pdf: buildPdf, model: buildModel,
      placeholder: buildPlaceholder, knot: buildKnot, bench: buildBench, sign: buildSign,
      customizer: buildCustomizer, whiteboard: buildWhiteboard, infodesk: (r) => window.InfoDesk.build(r, baseEntity)
    }[record.kind];
    if (!make) return null;
    const token = {};
    buildToken.set(record.id, token);
    const el = await make(record);
    if (buildToken.get(record.id) !== token) return find(record.id); // a newer edit won
    remove(record.id); // replace any older version of this item
    container().appendChild(el);
    lastBuilt.set(record.id, JSON.stringify(record));
    return el;
  }

  function find(id) {
    return container().querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  }

  function remove(id) {
    const el = find(id);
    if (el) el.parentNode.removeChild(el);
  }

  // ---------- starter exhibits ----------
  // Added once, the first time this browser opens the museum. After that they're ordinary
  // items: move, edit or delete them in admin mode. "Restore starter exhibits" re-adds any
  // that were deleted (fixed ids, so it never duplicates).
  const starter = (n, x, y, z, rotationY, size, aspect, title, description) => ({
    id: `starter-painting-${n}`, kind: 'placeholder', seed: n, mount: 'wall', stand: true,
    position: { x, y, z }, rotationY, size, aspect, plinth: false,
    title, artist: 'Placeholder Artist', year: '2026', description
  });
  // Position on a gallery room's wall: room at `angle` (degrees), room-local x across,
  // z out from the rotunda centre, `rot` = which way it faces inside the room.
  function roomSpot(angle, lx, y, lz, rot) {
    const a = (angle * Math.PI) / 180;
    const x = lx * Math.cos(a) + lz * Math.sin(a);
    const z = -lx * Math.sin(a) + lz * Math.cos(a);
    const r = ((angle + rot + 540) % 360) - 180;
    return { position: { x: +x.toFixed(3), y, z: +z.toFixed(3) }, rotationY: r };
  }
  const galleryStarter = (n, angle, wall, title) => {
    const spot = wall === 'left' ? roomSpot(angle, -5.42, 2.4, 16, 90)
      : wall === 'right' ? roomSpot(angle, 5.42, 2.4, 24, -90)
        : roomSpot(angle, 0, 2.6, 32.92, 180);
    const far = wall === 'far';
    return {
      id: `starter-gallery-${angle}-${wall}`, kind: 'placeholder', seed: n, mount: 'wall', stand: true,
      ...spot, size: far ? 3.4 : 2.6, aspect: far ? 0.7 : 0.75, plinth: false,
      title, artist: 'Placeholder Artist', year: '2026',
      description: 'A starter piece for this gallery. Select it in admin mode to move it, or delete it and upload your own.'
    };
  };

  const STARTERS = [
    starter(1, 8.357, 1.8, -4.825, -60, 2.4, 2 / 3, 'Untitled No. 1',
      'Replace this generated image with real artwork: select it in admin mode, delete it, and upload your own.'),
    starter(2, 0, 1.75, -9.65, 0, 3, 2 / 3, 'Untitled No. 2',
      'Every piece in the museum can be moved, resized, edited or deleted in admin mode.'),
    starter(3, -8.357, 1.8, -4.825, 60, 2.4, 2 / 3, 'Untitled No. 3',
      'Keep images around 2048px on the long side or smaller so they load fast on Quest.'),
    starter(4, -8.357, 1.8, 4.825, 120, 2, 1, 'Square Study',
      'Pieces hung on the curved wall automatically turn to face the centre of the room.'),
    starter(5, 8.357, 1.8, 4.825, -120, 2, 1, 'Square Study II',
      'Click the floor instead of a wall when placing an image to stand it up on a display stand.'),
    {
      id: 'starter-knot', kind: 'knot', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: 0.68, plinth: true,
      title: 'Knot', artist: 'Placeholder Sculptor', year: '2026',
      description: 'Upload a .glb in admin mode to add real sculptures; they get a plinth and plaque the same way.'
    },
    {
      id: 'starter-sign', kind: 'sign', text: 'VIRTUAL MUSEUM', title: 'VIRTUAL MUSEUM', style: 'bronze',
      mount: 'wall', stand: true, position: { x: 0, y: 4.55, z: -9.72 }, rotationY: 0, size: 4.2, aspect: 0.17
    },
    {
      id: 'starter-avatar-station', kind: 'customizer', title: 'Avatar station',
      position: { x: -5.6, y: 0, z: 3.6 }, rotationY: 123, size: 1
    },
    {
      // Info desk in the bay to the left of the "VR MUSEUM" sign (south wall), facing the centre.
      id: 'starter-info-desk', kind: 'infodesk', title: 'Info desk',
      link: 'https://en.wikipedia.org/wiki/Virtual_reality', signText: 'INFORMATION',
      position: { x: 3.6, y: 0, z: 6.24 }, rotationY: -150, size: 1.4
    },
    { id: 'starter-bench-west', kind: 'bench', position: { x: -4.2, y: 0, z: 0 }, rotationY: 90, size: 2.4, title: 'Bench' },
    { id: 'starter-bench-east', kind: 'bench', position: { x: 4.2, y: 0, z: 0 }, rotationY: 90, size: 2.4, title: 'Bench' },
    // Gallery rooms (east, north-east, north-west, west).
    galleryStarter(6, 90, 'left', 'East Gallery I'),
    galleryStarter(7, 90, 'right', 'East Gallery II'),
    galleryStarter(8, 90, 'far', 'East Gallery III'),
    galleryStarter(9, 150, 'left', 'North-East Gallery I'),
    galleryStarter(10, 150, 'right', 'North-East Gallery II'),
    galleryStarter(11, 150, 'far', 'North-East Gallery III'),
    galleryStarter(12, 210, 'left', 'North-West Gallery I'),
    galleryStarter(13, 210, 'right', 'North-West Gallery II'),
    galleryStarter(14, 210, 'far', 'North-West Gallery III'),
    galleryStarter(15, 270, 'left', 'West Gallery I'),
    galleryStarter(16, 270, 'right', 'West Gallery II'),
    galleryStarter(17, 270, 'far', 'West Gallery III')
  ];

  // Layout 2 opened arches where four starter paintings used to hang. Browsers that were
  // set up before that get those paintings moved (only if still at their old spots) and
  // the new gallery pieces added; anything you've moved or deleted is left alone.
  const LAYOUT_VERSION = 3; // 2: arches + gallery starters; 3: the welcome plate became an editable sign
  const OLD_SPOTS = {
    'starter-painting-1': { x: 4.825, z: -8.357 },
    'starter-painting-3': { x: -4.825, z: -8.357 },
    'starter-painting-4': { x: -9.65, z: 0 },
    'starter-painting-5': { x: 9.65, z: 0 }
  };
  async function migrateLayout() {
    const from = (await MuseumStore.local.getMeta('layout')) || 1;
    if (from >= LAYOUT_VERSION) return;
    const items = await MuseumStore.local.allItems();
    const byId = new Map(items.map((r) => [r.id, r]));
    if (from < 3 && !byId.has('starter-sign')) {
      await MuseumStore.local.putItem(JSON.parse(JSON.stringify(STARTERS.find((s) => s.id === 'starter-sign'))));
    }
    if (from >= 2) { await MuseumStore.local.setMeta('layout', LAYOUT_VERSION); return; }
    for (const [id, old] of Object.entries(OLD_SPOTS)) {
      const r = byId.get(id);
      if (r && r.mount !== 'floor' && Math.hypot(r.position.x - old.x, r.position.z - old.z) < 0.05) {
        const fresh = STARTERS.find((s) => s.id === id);
        r.position = { ...fresh.position };
        r.rotationY = fresh.rotationY;
        await MuseumStore.local.putItem(r);
      }
    }
    for (const s of STARTERS) {
      if (s.id.startsWith('starter-gallery-') && !byId.has(s.id)) await MuseumStore.local.putItem(JSON.parse(JSON.stringify(s)));
    }
    await MuseumStore.local.setMeta('layout', LAYOUT_VERSION);
  }

  async function ensureStarters() {
    if (await MuseumStore.local.getMeta('seeded')) return migrateLayout();
    for (const r of STARTERS) await MuseumStore.local.putItem(JSON.parse(JSON.stringify(r)));
    await MuseumStore.local.setMeta('seeded', true);
    await MuseumStore.local.setMeta('layout', LAYOUT_VERSION);
  }

  // An admin opened an empty online museum: save the starters there (once).
  async function seedOnline() {
    if (MuseumStore.mode !== 'online') return;
    if ((await MuseumStore.allItems()).length) { await MuseumStore.setMeta('seeded', true); return; }
    for (const r of STARTERS) await MuseumStore.putItem(JSON.parse(JSON.stringify(r)));
    await MuseumStore.setMeta('seeded', true);
    await MuseumStore.setMeta('layout', LAYOUT_VERSION);
  }

  // Re-add starter pieces that were deleted; returns how many came back.
  async function restoreStarters() {
    const have = new Set((await MuseumStore.allItems()).map((r) => r.id));
    let n = 0;
    for (const r of STARTERS) {
      if (have.has(r.id)) continue;
      const rec = JSON.parse(JSON.stringify(r));
      await MuseumStore.putItem(rec);
      await build(rec);
      n++;
    }
    return n;
  }

  // ---------- loading + live updates ----------
  const lastBuilt = new Map(); // id -> JSON of the version on screen
  const ALWAYS_THERE = ['customizer', 'infodesk'];
  let subscribed = false;

  function onRemoteChange(ev) {
    if (ev.type === 'delete') {
      if (ev.id) discard(ev.id);
      return;
    }
    if (lastBuilt.get(ev.id) === JSON.stringify(ev.record)) return; // already showing it (e.g. our own edit)
    build(ev.record).catch((err) => console.warn('Could not update exhibit', ev.id, err));
  }

  async function loadAll() {
    await MuseumStore.ready;
    let items;
    if (MuseumStore.mode === 'online') {
      items = await MuseumStore.allItems();
      // Nothing published yet: show the starter exhibits until an admin publishes a layout.
      if (!items.length && !(await MuseumStore.getMeta('seeded'))) items = JSON.parse(JSON.stringify(STARTERS));
      if (!subscribed) {
        subscribed = true;
        MuseumStore.onChange(onRemoteChange);
      }
    } else {
      await ensureStarters();
      items = await MuseumStore.allItems();
    }
    // The avatar station and the info desk are always in the museum (admins can move and edit
    // them, not delete them). If one was never saved, show it at its default spot; the first
    // admin edit saves it.
    for (const kind of ALWAYS_THERE) {
      if (!items.some((r) => r.kind === kind)) items.push(JSON.parse(JSON.stringify(STARTERS.find((r) => r.kind === kind))));
    }
    for (const r of items) {
      try { await build(r); } catch (err) { console.warn('Could not load exhibit', r.title, err); }
    }
    document.querySelector('a-scene').emit('museum-items-loaded', { items });
  }

  // Load saved exhibits for every visitor once the scene is ready.
  let loading = null;
  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    const go = () => { loading = loadAll().catch((err) => console.warn('Could not load saved exhibits', err)); };
    if (scene.hasLoaded) go(); else scene.addEventListener('loaded', go, { once: true });
  });

  // Started offline (showing this browser's copy), then the online museum became reachable:
  // swap in the shared exhibits in place, without a reload, so nobody is pulled out of VR.
  async function switchToOnline() {
    if (loading) await loading;
    let items = await MuseumStore.allItems();
    if (!items.length && !(await MuseumStore.getMeta('seeded'))) items = JSON.parse(JSON.stringify(STARTERS));
    for (const kind of ALWAYS_THERE) {
      if (!items.some((r) => r.kind === kind)) items.push(JSON.parse(JSON.stringify(STARTERS.find((r) => r.kind === kind))));
    }
    const keep = new Set(items.map((r) => r.id));
    for (const id of [...lastBuilt.keys()]) if (!keep.has(id)) discard(id);
    for (const r of items) {
      if (lastBuilt.get(r.id) === JSON.stringify(r)) continue; // same as the local copy
      try { await build(r); } catch (err) { console.warn('Could not load exhibit', r.title, err); }
    }
    if (!subscribed) {
      subscribed = true;
      MuseumStore.onChange(onRemoteChange);
    }
  }
  MuseumStore.onOnline(() => switchToOnline().catch((err) => console.warn('Could not load the online museum', err)));

  // Remove an item for good, cancelling any rebuild still in progress.
  function discard(id) {
    buildToken.delete(id);
    lastBuilt.delete(id);
    remove(id);
  }

  // The version of an item now on screen (also for ones never saved, like a default desk).
  function builtRecord(id) {
    const json = lastBuilt.get(id);
    return json ? JSON.parse(json) : null;
  }

  function clearScene() {
    buildToken.clear();
    lastBuilt.clear();
    [...container().children].forEach((el) => el.parentNode.removeChild(el));
    [...urls.keys()].forEach(forgetFile);
  }

  const FLAT_KINDS = ['image', 'pdf', 'placeholder', 'sign', 'whiteboard'];     // hang on walls or stand on the floor
  const FLOOR_KINDS = ['model', 'knot', 'bench', 'customizer', 'infodesk']; // always on the floor

  return {
    build, find, discard, clearScene, loadAll, restoreStarters, inspect, kindOf, forgetFile, floorCenterY,
    signAspect, SIGN_STYLES, LAYOUT_VERSION, prepareLocal: ensureStarters, inspectLink, seedOnline,
    FLAT_KINDS, FLOOR_KINDS, PLINTH_H, ALWAYS_THERE, builtRecord
  };
})();
