// Minimal IndexedDB wrapper for PearMessenger
export const db = (() => {
  const DB_NAME = 'peermsg-db';
  const DB_VERSION = 1;
  let ready = null;

  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); // for identity etc.
        if (!d.objectStoreNames.contains('friends')) {
          const store = d.createObjectStore('friends', { keyPath: 'fingerprint' });
          store.createIndex('name', 'name', { unique: false });
        }
        if (!d.objectStoreNames.contains('messages')) {
          const store = d.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('ts', 'ts', { unique: false });
          store.createIndex('from', 'from', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return ready;
  }

  async function tx(store, mode='readonly') {
    const d = await open();
    return d.transaction(store, mode).objectStore(store);
  }

  return {
    async getKV(key) {
      const store = await tx('kv');
      return new Promise((res, rej) => {
        const r = store.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async setKV(key, value) {
      const store = await tx('kv', 'readwrite');
      return new Promise((res, rej) => {
        const r = store.put(value, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      });
    },
    async addFriend(friend) {
      const store = await tx('friends', 'readwrite');
      return new Promise((res, rej) => {
        const r = store.put(friend); r.onsuccess = () => res(friend); r.onerror = () => rej(r.error);
      });
    },
    async getFriend(fp) {
      const store = await tx('friends');
      return new Promise((res, rej) => {
        const r = store.get(fp); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async allFriends() {
      const store = await tx('friends');
      return new Promise((res, rej) => {
        const r = store.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      });
    },
    async putMessage(msg) {
      const store = await tx('messages', 'readwrite');
      return new Promise((res, rej) => {
        const r = store.put(msg); r.onsuccess = () => res(msg); r.onerror = () => rej(r.error);
      });
    },
    async getMessage(id) {
      const store = await tx('messages');
      return new Promise((res, rej) => {
        const r = store.get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async recentMessages(limit=200) {
      const store = await tx('messages');
      return new Promise((res, rej) => {
        const r = store.index('ts').openCursor(null, 'prev');
        const items = [];
        r.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && items.length < limit) {
            items.push(cursor.value);
            cursor.continue();
          } else {
            res(items.reverse());
          }
        };
        r.onerror = () => rej(r.error);
      });
    },
    async clear() {
      const d = await open();
      const tx = d.transaction(['kv','friends','messages'], 'readwrite');
      await Promise.all(['kv','friends','messages'].map(name => new Promise((res, rej) => {
        const r = tx.objectStore(name).clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })));
    }
  };
})();
