/**
 * MuseumLocalStore — keeps exhibits and uploaded files in this browser (IndexedDB).
 * MuseumStore (bottom of this file) — what the rest of the museum uses: Supabase
 * when it's configured (js/supabase-config.js) and reachable, so everyone sees the
 * same museum and changes appear live; otherwise this browser's local copy.
 *
 *   items: { id, fileId?, kind: 'image'|'pdf'|'model'|'placeholder'|'knot'|'bench',
 *            position: {x,y,z}, rotationY, size, aspect, plinth, mount, stand, seed?,
 *            title, artist, year, description }
 *   files: { id, name, type, blob }
 *   meta:  { key, value }   e.g. 'seeded' once the starter exhibits have been added
 */
window.MuseumLocalStore = (() => {
  const DB_NAME = 'virtual-museum';
  let dbPromise;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const names = req.result.objectStoreNames;
          if (!names.contains('items')) req.result.createObjectStore('items', { keyPath: 'id' });
          if (!names.contains('files')) req.result.createObjectStore('files', { keyPath: 'id' });
          if (!names.contains('meta')) req.result.createObjectStore('meta', { keyPath: 'key' }); // added in v2
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(storeName, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const newId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  return {
    newId,
    allItems: () => run('items', 'readonly', (s) => s.getAll()),
    putItem: (item) => run('items', 'readwrite', (s) => s.put(item)),
    deleteItem: (id) => run('items', 'readwrite', (s) => s.delete(id)),
    getFile: (id) => run('files', 'readonly', (s) => s.get(id)),
    allFiles: () => run('files', 'readonly', (s) => s.getAll()),
    putFile: (file) => run('files', 'readwrite', (s) => s.put(file)),
    deleteFile: (id) => run('files', 'readwrite', (s) => s.delete(id)),
    getMeta: (key) => run('meta', 'readonly', (s) => s.get(key)).then((r) => (r ? r.value : undefined)),
    setMeta: (key, value) => run('meta', 'readwrite', (s) => s.put({ key, value })),
    async clearAll() {
      await run('items', 'readwrite', (s) => s.clear());
      await run('files', 'readwrite', (s) => s.clear());
    }
  };
})();

// ---------------------------------------------------------------------------
// Supabase (online) store: same methods as the local one.
// ---------------------------------------------------------------------------
function makeSupabaseStore({ url, key }) {
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'museum-auth' },
    // Heartbeats from a web worker: background tabs slow down ordinary timers so much that the
    // server can drop the connection (and the visitor vanishes for everyone else).
    realtime: { worker: true }
  });
  const BUCKET = 'museum-files';
  const check = ({ data, error }) => { if (error) throw error; return data; };

  const store = {
    sb,
    async ping() { check(await sb.from('museum_items').select('id').limit(1)); },
    async allItems() { return check(await sb.from('museum_items').select('data')).map((r) => r.data); },
    async putItem(item) { check(await sb.from('museum_items').upsert({ id: item.id, data: item })); },
    async deleteItem(id) { check(await sb.from('museum_items').delete().eq('id', id)); },
    publicUrl: (id) => sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl,
    async getFile(id) {
      const res = await fetch(store.publicUrl(id));
      if (!res.ok) return undefined;
      const blob = await res.blob();
      return { id, name: id, type: blob.type, blob };
    },
    async fileNames() {
      return check(await sb.storage.from(BUCKET).list('', { limit: 1000 })).filter((f) => f.id).map((f) => f.name);
    },
    async allFiles() { return (await Promise.all((await store.fileNames()).map((n) => store.getFile(n)))).filter(Boolean); },
    async putFile(f) {
      check(await sb.storage.from(BUCKET).upload(f.id, f.blob, {
        contentType: f.type || f.blob.type || 'application/octet-stream', upsert: true, cacheControl: '31536000'
      }));
    },
    async deleteFile(id) { check(await sb.storage.from(BUCKET).remove([id])); },
    async getMeta(key) {
      const rows = check(await sb.from('museum_meta').select('value').eq('key', key));
      return rows[0] ? rows[0].value : undefined;
    },
    async setMeta(key, value) { check(await sb.from('museum_meta').upsert({ key, value })); },
    // Removes all exhibits. Uploaded files are kept on purpose, so a backup can always be
    // restored (unused files can be tidied up later in Supabase -> Storage).
    async clearAll() {
      check(await sb.from('museum_items').delete().neq('id', ''));
    },
    // Live updates: every insert/update/delete on museum_items, for every visitor.
    subscribe(cb) {
      sb.channel('museum-items')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'museum_items' }, (p) => {
          if (p.eventType === 'DELETE') cb({ type: 'delete', id: p.old && p.old.id });
          else cb({ type: 'upsert', id: p.new.id, record: p.new.data });
        })
        .subscribe();
    },
    // Admin login.
    async session() { return (await sb.auth.getSession()).data.session; },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.session;
    },
    async signOut() { await sb.auth.signOut(); },
    async isAdmin() {
      const s = await store.session();
      if (!s) return false;
      return check(await sb.from('museum_admins').select('user_id').eq('user_id', s.user.id)).length > 0;
    }
  };
  return store;
}

window.MuseumStore = (() => {
  const local = window.MuseumLocalStore;
  const cfg = window.MUSEUM_SUPABASE;
  const configured = !!(cfg && cfg.url && cfg.key);
  let active = local;
  let online = null;
  const listeners = [];
  const onlineListeners = [];
  const statusListeners = [];
  let status = configured ? 'connecting' : 'local'; // 'connecting' | 'online' | 'offline' | 'local'
  let lastError = null;

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
  const setStatus = (s) => { status = s; statusListeners.slice().forEach((f) => f(s, lastError)); };

  // The Supabase library comes from a CDN. If that script was blocked or timed out,
  // try a second CDN before giving up on this attempt.
  const LIB_FALLBACK = 'https://unpkg.com/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js';
  let libLoading = null;
  function loadLibrary() {
    if (window.supabase) return Promise.resolve();
    if (!libLoading) {
      libLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIB_FALLBACK;
        s.onload = () => (window.supabase ? resolve() : reject(new Error('Supabase library did not load')));
        s.onerror = () => { s.remove(); reject(new Error('Supabase library did not load')); };
        document.head.appendChild(s);
      }).catch((err) => { libLoading = null; throw err; });
    }
    return libLoading;
  }

  // One connection attempt. Quest headsets on busy Wi-Fi can be slow while the 3D scene loads,
  // so each attempt gets a generous timeout.
  async function attempt(ms) {
    await withTimeout(loadLibrary(), ms);
    const s = makeSupabaseStore(cfg);
    await withTimeout(s.ping(), ms);
    return s;
  }

  function goOnline(s) {
    online = s;
    active = s;
    lastError = null;
    s.subscribe((ev) => listeners.forEach((f) => f(ev)));
    setStatus('online');
  }

  // First try: up to two attempts, then the museum opens from this browser's copy so nobody
  // waits forever. Retrying carries on in the background, and when it connects every part of
  // the museum switches over (exhibits, whiteboards, multiplayer, admin) without a reload.
  const ready = (async () => {
    if (!configured) return;
    for (const ms of [10000, 8000]) {
      try { goOnline(await attempt(ms)); return; } catch (err) { lastError = err; }
    }
    console.warn('Supabase not reachable or not set up yet (run supabase/setup.sql); using this browser\'s copy for now and retrying.', lastError);
    setStatus('offline');
    retryLater(0);
  })();

  const RETRY_DELAYS = [5000, 10000, 15000, 30000]; // then every 30 s
  let retryTimer = null;
  function retryLater(n) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => retryNow(n), RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)]);
  }
  let retrying = false;
  async function retryNow(n = 0) {
    if (online || retrying || !configured) return;
    retrying = true;
    clearTimeout(retryTimer);
    setStatus('connecting');
    try {
      const s = await attempt(15000);
      goOnline(s);
      onlineListeners.slice().forEach((f) => { try { f(s); } catch (err) { console.warn(err); } });
    } catch (err) {
      lastError = err;
      setStatus('offline');
      retryLater(n + 1);
    } finally {
      retrying = false;
    }
  }
  // Coming back from a dropped connection: try straight away.
  window.addEventListener('online', () => { if (!online) retryNow(0); });

  let resolveOnline;
  const whenOnline = new Promise((res) => { resolveOnline = res; });
  onlineListeners.push((s) => resolveOnline(s));
  ready.then(() => { if (online) resolveOnline(online); });

  const call = (name) => async (...args) => { await ready; return active[name](...args); };
  return {
    ready,
    get mode() { return online ? 'online' : 'local'; },
    // Connection state for the offline notice: 'connecting', 'online', 'offline', or 'local'
    // (Supabase not configured, so there's nothing to connect to).
    get status() { return status; },
    get lastError() { return lastError; },
    configured,
    local,
    online: () => online,
    whenOnline,                                         // resolves when connected (maybe never)
    onOnline: (f) => onlineListeners.push(f),           // called if it connects after starting offline
    onStatus: (f) => statusListeners.push(f),
    retryNow: () => retryNow(0),
    newId: local.newId,
    allItems: call('allItems'),
    putItem: call('putItem'),
    deleteItem: call('deleteItem'),
    getFile: call('getFile'),
    allFiles: call('allFiles'),
    putFile: call('putFile'),
    deleteFile: call('deleteFile'),
    getMeta: call('getMeta'),
    setMeta: call('setMeta'),
    clearAll: call('clearAll'),
    publicUrl: (id) => (online ? online.publicUrl(id) : null), // direct file URL when online
    onChange: (f) => listeners.push(f)
  };
})();
