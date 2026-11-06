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
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'museum-auth' }
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
    async clearAll() {
      check(await sb.from('museum_items').delete().neq('id', ''));
      const names = await store.fileNames();
      if (names.length) check(await sb.storage.from(BUCKET).remove(names));
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
  let active = local;
  let online = null;
  const listeners = [];

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

  const ready = (async () => {
    if (!cfg || !cfg.url || !cfg.key) return;
    if (!window.supabase) { console.warn('Supabase library did not load; using this browser\'s copy of the museum.'); return; }
    try {
      const s = makeSupabaseStore(cfg);
      await withTimeout(s.ping(), 8000);
      online = s;
      active = s;
      s.subscribe((ev) => listeners.forEach((f) => f(ev)));
    } catch (err) {
      console.warn('Supabase not reachable or not set up yet (run supabase/setup.sql); using this browser\'s copy.', err);
    }
  })();

  const call = (name) => async (...args) => { await ready; return active[name](...args); };
  return {
    ready,
    get mode() { return online ? 'online' : 'local'; },
    local,
    online: () => online,
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
