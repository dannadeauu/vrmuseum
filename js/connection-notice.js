/**
 * Offline notice. When the online museum (Supabase) can't be reached, the page falls back to
 * this device's copy: other visitors, chat and live changes aren't available. This says so,
 * on the page and as a small label inside VR, while js/store.js keeps retrying. When it
 * connects, everything switches over by itself and a short "Connected" note replaces this.
 */
(() => {
  if (!window.MuseumStore || !MuseumStore.configured) return; // no online museum set up

  const OFFLINE = "Offline: can't reach the online museum. You're seeing this device's copy, and other visitors can't see you. Retrying…";
  const CONNECTING = 'Connecting to the online museum…';
  const CONNECTED = "Connected: you're in the shared museum.";

  let wasOffline = false;
  let pill = null, pillText = null, pillBtn = null, hideTimer = null;

  // ---------- on the page ----------
  function ensurePill() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'conn-notice';
    pill.setAttribute('role', 'status');
    pill.innerHTML = '<span class="conn-dot" aria-hidden="true"></span><span class="conn-text"></span><button type="button">Try now</button>';
    pillText = pill.querySelector('.conn-text');
    pillBtn = pill.querySelector('button');
    pillBtn.onclick = () => MuseumStore.retryNow();
    document.body.appendChild(pill);
  }
  function showPill(kind, text) {
    ensurePill();
    clearTimeout(hideTimer);
    pill.dataset.kind = kind;
    pill.hidden = false;
    pillText.textContent = text;
    pillBtn.hidden = kind !== 'offline';
  }
  function hidePill(after) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (pill) pill.hidden = true; }, after);
  }

  // ---------- inside VR ----------
  // Page overlays can't be seen in a headset, so a small label floats near the top of the view.
  let label = null, labelText = '';
  function makeLabel(text, colour) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(20,22,30,0.88)';
    const r = 40;
    g.beginPath();
    g.moveTo(r, 0); g.arcTo(1024, 0, 1024, 200, r); g.arcTo(1024, 200, 0, 200, r);
    g.arcTo(0, 200, 0, 0, r); g.arcTo(0, 0, 1024, 0, r); g.closePath(); g.fill();
    g.fillStyle = colour;
    g.beginPath(); g.arc(60, 100, 16, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2efe9';
    g.font = '600 38px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    // wrap onto at most three lines
    const words = text.split(' '), lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > 880 && line) { lines.push(line); line = w; } else line = t;
    }
    lines.push(line);
    const shown = lines.slice(0, 3);
    shown.forEach((l, i) => g.fillText(l, 100, 100 + (i - (shown.length - 1) / 2) * 48));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62 * 200 / 1024), mat);
    mesh.position.set(0, 0.2, -0.9);
    mesh.renderOrder = 1000;
    return mesh;
  }
  function setLabel(text, colour) {
    const cam = document.querySelector('#camera');
    if (!cam || !cam.object3D) return;
    if (label && labelText === text) return;
    clearLabel();
    if (!text) return;
    label = makeLabel(text, colour);
    labelText = text;
    cam.object3D.add(label);
  }
  function clearLabel() {
    if (!label) return;
    label.parent && label.parent.remove(label);
    label.material.map.dispose(); label.material.dispose(); label.geometry.dispose();
    label = null; labelText = '';
  }
  const inVR = () => { const s = document.querySelector('a-scene'); return !!(s && s.is && s.is('vr-mode')); };

  // ---------- react to the connection ----------
  let vrHideTimer = null;
  function render(status) {
    clearTimeout(vrHideTimer);
    if (status === 'offline') {
      wasOffline = true;
      showPill('offline', OFFLINE);
      if (inVR()) setLabel("Offline: can't reach the online museum. Other visitors can't see you. Retrying…", '#ff8a5c'); else clearLabel();
    } else if (status === 'connecting') {
      if (!wasOffline) return; // the first connection at load: nothing to report yet
      showPill('connecting', CONNECTING);
      if (inVR()) setLabel(CONNECTING, '#ffb347'); else clearLabel();
    } else if (status === 'online') {
      if (!wasOffline) return;
      wasOffline = false;
      showPill('online', CONNECTED);
      hidePill(5000);
      if (inVR()) { setLabel(CONNECTED, '#5fd38d'); vrHideTimer = setTimeout(clearLabel, 5000); } else clearLabel();
    }
  }

  MuseumStore.onStatus(render);
  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    // Entering or leaving VR: move the notice to where it can be seen.
    scene.addEventListener('enter-vr', () => render(MuseumStore.status));
    scene.addEventListener('exit-vr', clearLabel);
    if (MuseumStore.status === 'offline') render('offline');
  });
})();
