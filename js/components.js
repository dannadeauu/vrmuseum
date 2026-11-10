/* global AFRAME, THREE */

/**
 * thumbstick-locomotion — put on the rig.
 * Left stick: glide in the direction you're looking, easing in and out (no lurches).
 * Right stick: smooth turning (or snap turns with turn: snap).
 */
AFRAME.registerComponent('thumbstick-locomotion', {
  schema: {
    leftHand: { type: 'selector' },
    rightHand: { type: 'selector' },
    speed: { default: 2 },          // metres per second at full stick
    turn: { default: 'smooth' },    // smooth | snap
    turnSpeed: { default: 90 },     // degrees per second at full stick (smooth)
    snapAngle: { default: 45 },     // degrees per flick (snap)
    deadzone: { default: 0.15 },
    easing: { default: 8 }          // how quickly speed follows the stick (higher = snappier)
  },

  init() {
    this.stick = { x: 0, y: 0 };
    this.turnX = 0;
    this.turnReady = true;
    this.vel = new THREE.Vector2(); // current ground velocity (x, z)
    this.camera = this.el.querySelector('[camera]');
    this.fwd = new THREE.Vector3();
    this.before = new THREE.Vector3();
    this.after = new THREE.Vector3();

    this.onMove = (e) => { this.stick.x = e.detail.x; this.stick.y = e.detail.y; };
    this.onTurn = (e) => {
      this.turnX = e.detail.x;
      if (this.data.turn !== 'snap') return;
      if (Math.abs(e.detail.x) < 0.5) { this.turnReady = true; return; }
      if (!this.turnReady) return;
      this.turnReady = false;
      this.rotateAroundHead(THREE.MathUtils.degToRad(this.data.snapAngle) * (e.detail.x > 0 ? -1 : 1));
    };
  },

  play() {
    this.data.leftHand && this.data.leftHand.addEventListener('thumbstickmoved', this.onMove);
    this.data.rightHand && this.data.rightHand.addEventListener('thumbstickmoved', this.onTurn);
  },

  pause() {
    this.data.leftHand && this.data.leftHand.removeEventListener('thumbstickmoved', this.onMove);
    this.data.rightHand && this.data.rightHand.removeEventListener('thumbstickmoved', this.onTurn);
  },

  // Rotate the rig around the player's head (not the rig origin), so turning doesn't slide you.
  rotateAroundHead(angle) {
    const rig = this.el.object3D;
    this.camera.object3D.getWorldPosition(this.before);
    rig.rotation.y += angle;
    rig.updateMatrixWorld(true);
    this.camera.object3D.getWorldPosition(this.after);
    rig.position.x += this.before.x - this.after.x;
    rig.position.z += this.before.z - this.after.z;
  },

  tick(t, dt) {
    if (!dt) return;
    const d = this.data;
    const s = Math.min(dt, 50) / 1000; // clamp so a hitch doesn't teleport you

    // Smooth turning, with a soft response curve for fine control.
    if (d.turn !== 'snap' && Math.abs(this.turnX) > d.deadzone) {
      const amt = (Math.abs(this.turnX) - d.deadzone) / (1 - d.deadzone);
      this.rotateAroundHead(-Math.sign(this.turnX) * amt * amt * THREE.MathUtils.degToRad(d.turnSpeed) * s);
    }

    // Target velocity from the left stick, relative to where you're looking.
    let tx = 0, tz = 0;
    const { x, y } = this.stick;
    const mag = Math.hypot(x, y);
    if (mag > d.deadzone) {
      this.camera.object3D.getWorldDirection(this.fwd).negate(); // camera entity faces -z
      this.fwd.y = 0;
      if (this.fwd.lengthSq() > 1e-6) {
        this.fwd.normalize();
        const k = Math.min(1, (mag - d.deadzone) / (1 - d.deadzone)) / mag; // rescale past the deadzone
        const sx = x * k, sy = y * k;
        const rightX = -this.fwd.z, rightZ = this.fwd.x;
        tx = (this.fwd.x * -sy + rightX * sx) * d.speed;
        tz = (this.fwd.z * -sy + rightZ * sx) * d.speed;
      }
    }

    // Ease the actual velocity toward the target: smooth starts and stops.
    const e = 1 - Math.exp(-d.easing * s);
    this.vel.x += (tx - this.vel.x) * e;
    this.vel.y += (tz - this.vel.y) * e;
    if (Math.abs(this.vel.x) < 1e-4 && Math.abs(this.vel.y) < 1e-4) return;
    const pos = this.el.object3D.position;
    pos.x += this.vel.x * s;
    pos.z += this.vel.y * s;
  }
});

/**
 * bounds — put on the rig. Keeps the player's head inside the walkable area,
 * whether they moved via WASD (camera), thumbstick (rig), or walking in room-scale.
 *   bounds="layout: true"  rotunda + passages + gallery rooms (window.MuseumLayout, js/rooms.js)
 *   bounds="radius: 9"     a single round room
 *   bounds="minX: ...; maxX: ...; minZ: ...; maxZ: ..."  a rectangular room
 */
AFRAME.registerComponent('bounds', {
  schema: {
    layout: { default: false },
    radius: { default: 0 },
    minX: { default: -10 }, maxX: { default: 10 }, minZ: { default: -10 }, maxZ: { default: 10 }
  },
  init() {
    this.head = new THREE.Vector3();
    this.camera = this.el.querySelector('[camera]');
  },
  // Nearest walkable point to (x, z), or null if (x, z) is already walkable.
  nearestWalkable(x, z) {
    const L = window.MuseumLayout;
    const R = L.rotundaR;
    const d = Math.hypot(x, z);
    if (d <= R) return null;
    let best = { x: (x / d) * R, z: (z / d) * R };
    let bestD = d - R;
    for (const room of L.rooms) {
      const c = Math.cos(room.angle), s = Math.sin(room.angle);
      const lx = x * c - z * s, lz = x * s + z * c; // world -> room-local
      for (const r of room.rects) {
        const cx = Math.min(r.x1, Math.max(r.x0, lx));
        const cz = Math.min(r.z1, Math.max(r.z0, lz));
        const dist = Math.hypot(lx - cx, lz - cz);
        if (dist === 0) return null;
        if (dist < bestD) {
          bestD = dist;
          best = { x: cx * c + cz * s, z: -cx * s + cz * c }; // room-local -> world
        }
      }
    }
    return best;
  },
  tick() {
    const d = this.data;
    this.camera.object3D.getWorldPosition(this.head);
    const p = this.el.object3D.position;
    if (d.layout && window.MuseumLayout) {
      const n = this.nearestWalkable(this.head.x, this.head.z);
      if (n) {
        p.x += n.x - this.head.x;
        p.z += n.z - this.head.z;
      }
      return;
    }
    if (d.radius > 0) {
      const dist = Math.hypot(this.head.x, this.head.z);
      if (dist > d.radius) {
        const k = (dist - d.radius) / dist;
        p.x -= this.head.x * k;
        p.z -= this.head.z * k;
      }
      return;
    }
    if (this.head.x > d.maxX) p.x -= this.head.x - d.maxX;
    if (this.head.x < d.minX) p.x += d.minX - this.head.x;
    if (this.head.z > d.maxZ) p.z -= this.head.z - d.maxZ;
    if (this.head.z < d.minZ) p.z += d.minZ - this.head.z;
  }
});

/**
 * exhibit — adds a frame, a wall plaque, and a description panel that
 * toggles when the piece is clicked (mouse on PC, trigger in VR).
 */
AFRAME.registerComponent('exhibit', {
  schema: {
    title: { default: 'Untitled' },
    artist: { default: '' },
    year: { default: '' },
    description: { default: '' },
    frame: { default: true },
    plaqueOffset: { default: '' }, // "x y z"; empty = auto (right of the piece)
    panelOffset: { default: '' },  // "x y z"; empty = auto (above the piece)
    panel: { default: true },       // false: clicking doesn't open the description panel (e.g. PDFs open a reader)
    hint: { default: '' },          // plaque hint; empty = "(click / trigger for more)" when there's a description
    frameColor: { default: '#2b2119' },
    hoverGrow: { default: true }    // false: don't swell on hover (e.g. whiteboards, which you draw on)
  },

  init() {
    const el = this.el;
    const d = this.data;
    const w = parseFloat(el.getAttribute('width')) || 1;
    const h = parseFloat(el.getAttribute('height')) || 1;

    if (d.frame) {
      const frame = document.createElement('a-box');
      frame.setAttribute('width', w + 0.16);
      frame.setAttribute('height', h + 0.16);
      frame.setAttribute('depth', 0.06);
      frame.setAttribute('position', '0 0 -0.05'); // front face 2 cm behind the picture: no flicker at a distance
      frame.setAttribute('color', d.frameColor);
      el.appendChild(frame);
    }

    // Plaque: to the right of a painting, or wherever plaqueOffset says.
    const off = d.plaqueOffset
      ? AFRAME.utils.coordinates.parse(d.plaqueOffset)
      : { x: w / 2 + 0.45, y: -h / 2 + 0.25, z: 0.01 };
    const plaque = document.createElement('a-entity');
    plaque.setAttribute('position', `${off.x} ${off.y} ${off.z}`);
    plaque.setAttribute('geometry', 'primitive: plane; width: 0.6; height: 0.32');
    plaque.setAttribute('material', 'color: #faf8f4; shader: flat');
    plaque.setAttribute('text', {
      value: `${d.title}\n${[d.artist, d.year].filter(Boolean).join(', ')}${
        d.hint ? '\n\n' + d.hint : (d.description && d.panel ? '\n\n(click / trigger for more)' : '')}`,
      color: '#2b2119', width: 0.55, align: 'left', wrapCount: 28, baseline: 'center', xOffset: 0.03
    });
    el.appendChild(plaque);

    // Description panel, hidden until clicked.
    const panel = document.createElement('a-entity');
    panel.setAttribute('visible', false);
    const pOff = d.panelOffset
      ? AFRAME.utils.coordinates.parse(d.panelOffset)
      : { x: 0, y: h / 2 + 0.5, z: 0.05 };
    panel.setAttribute('position', `${pOff.x} ${pOff.y} ${pOff.z}`);
    panel.setAttribute('geometry', 'primitive: plane; width: 2.2; height: 0.7');
    panel.setAttribute('material', 'color: #1b1b1f; opacity: 0.92; transparent: true; shader: flat');
    panel.setAttribute('text', {
      value: d.description, color: '#f2efe9', width: 2, align: 'center', wrapCount: 42
    });
    el.appendChild(panel);
    this.panel = panel;

    el.addEventListener('click', () => {
      if (el.sceneEl.is('admin-mode')) return; // in admin mode a click selects instead
      if (!d.description || !d.panel) return; // nothing to show, or the piece handles clicks itself
      panel.setAttribute('visible', !panel.getAttribute('visible'));
    });
    if (d.hoverGrow) {
      el.addEventListener('mouseenter', () => el.object3D.scale.setScalar(1.02));
      el.addEventListener('mouseleave', () => el.object3D.scale.setScalar(1));
    }
  }
});

/**
 * placeholder-art — draws a seeded abstract painting onto a canvas texture
 * so the gallery isn't empty before you have real images.
 */
AFRAME.registerComponent('placeholder-art', {
  schema: { seed: { default: 1 } },
  init() {
    let s = this.data.seed * 9301 + 49297;
    const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const palettes = [
      ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
      ['#0d1b2a', '#1b263b', '#415a77', '#778da9', '#e0e1dd'],
      ['#3d405b', '#e07a5f', '#f4f1de', '#81b29a', '#f2cc8f'],
      ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
      ['#606c38', '#283618', '#fefae0', '#dda15e', '#bc6c25']
    ];
    const pal = palettes[this.data.seed % palettes.length];

    const c = document.createElement('canvas');
    c.width = 512; c.height = 512; // drawn at 1024 scale, stored at 512 to save memory on Quest
    const g = c.getContext('2d');
    g.scale(0.5, 0.5);
    g.fillStyle = pal[0];
    g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = pal[1 + Math.floor(rand() * (pal.length - 1))];
      g.globalAlpha = 0.5 + rand() * 0.5;
      if (rand() < 0.5) {
        g.beginPath();
        g.arc(rand() * 1024, rand() * 1024, 30 + rand() * 220, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillRect(rand() * 1024, rand() * 1024, 40 + rand() * 400, 20 + rand() * 300);
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.el.addEventListener('loaded', () => this.apply(tex));
    if (this.el.hasLoaded) this.apply(tex);
  },
  apply(tex) {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh) return;
    mesh.material = new THREE.MeshBasicMaterial({ map: tex });
  }
});

/** slow-spin — gentle rotation for sculptures. */
AFRAME.registerComponent('slow-spin', {
  schema: { speed: { default: 15 } }, // degrees per second
  tick(t, dt) {
    this.el.object3D.rotation.y += THREE.MathUtils.degToRad(this.data.speed) * (dt / 1000);
  }
});

/**
 * jump — put on the rig. Spacebar on PC, the A button on a VR controller.
 */
AFRAME.registerComponent('jump', {
  schema: {
    height: { default: 1 },              // peak height in metres
    gravity: { default: 20 },            // m/s²; higher = snappier jump
    hand: { type: 'selector' },          // controller with the jump button (e.g. #rightHand)
    button: { default: 'abuttondown' }   // A button on Meta Quest controllers
  },

  init() {
    this.vy = 0;
    this.airborne = false;
    this.jump = () => {
      if (this.airborne) return;
      this.vy = Math.sqrt(2 * this.data.gravity * this.data.height);
      this.airborne = true;
    };
    this.onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault(); // stop the page from scrolling
      this.jump();
    };
  },

  play() {
    window.addEventListener('keydown', this.onKey);
    if (this.data.hand) this.data.hand.addEventListener(this.data.button, this.jump);
  },
  pause() {
    window.removeEventListener('keydown', this.onKey);
    if (this.data.hand) this.data.hand.removeEventListener(this.data.button, this.jump);
  },

  tick(t, dt) {
    if (!this.airborne || !dt) return;
    const s = Math.min(dt, 50) / 1000; // clamp so a lag spike doesn't launch you
    const pos = this.el.object3D.position;
    this.vy -= this.data.gravity * s;
    pos.y += this.vy * s;
    if (pos.y <= 0) {
      pos.y = 0;
      this.vy = 0;
      this.airborne = false;
    }
  }
});

/**
 * spawn-facing — put on the rig. When the saved exhibits have loaded, start the
 * visitor across the rotunda from the welcome sign, facing it, wherever the sign
 * has been moved to. Falls back to the rig's own position/rotation if the sign is
 * missing or isn't in the rotunda.
 */
AFRAME.registerComponent('spawn-facing', {
  schema: {
    target: { default: 'starter-sign' }, // saved item id to face
    distance: { default: 7 },            // how far from the centre to start, on the far side
    maxRadius: { default: 10.5 },        // only follow targets inside the rotunda
    spread: { default: 2.5 }             // metres of random side-to-side offset, so visitors who
                                         // arrive together don't stand inside each other
  },
  init() {
    this.done = false;
    this.onLoaded = (e) => {
      if (this.done) return;
      this.done = true;
      const t = (e.detail.items || []).find((r) => r.id === this.data.target);
      // Direction from the centre toward what we face (default: north, like the rig's start).
      let dx = 0, dz = -1;
      if (t) {
        const r = Math.hypot(t.position.x, t.position.z);
        if (r >= 0.5 && r <= this.data.maxRadius) { dx = t.position.x / r; dz = t.position.z / r; }
      }
      const side = (Math.random() * 2 - 1) * this.data.spread;  // left/right of the centre line
      const back = (Math.random() * 2 - 1) * 0.8;               // a little nearer or further
      const dist = this.data.distance + back;
      const rig = this.el.object3D;
      rig.position.set(-dx * dist - dz * side, rig.position.y, -dz * dist + dx * side);
      rig.rotation.set(0, Math.atan2(-dx, -dz), 0); // the camera looks down -z; turn it toward the sign
      const lc = this.el.querySelector('[look-controls]');
      if (lc && lc.components['look-controls']) {
        lc.components['look-controls'].yawObject.rotation.y = 0;
        lc.components['look-controls'].pitchObject.rotation.x = 0;
      }
    };
    this.el.sceneEl.addEventListener('museum-items-loaded', this.onLoaded);
  },
  remove() {
    this.el.sceneEl.removeEventListener('museum-items-loaded', this.onLoaded);
  }
});
