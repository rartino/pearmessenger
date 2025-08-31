// Minimal encrypted signaling over WebSocket
import { cryptoUtils } from './crypto.js';
import { CONFIG } from './config.js';

export function deriveRoomId(pubA, pubB) {
  // Stable room from both pubkeys (sorted), base64url(SHA-256)
  const enc = new TextEncoder();
  const sorted = [pubA, pubB].sort().join('|');
  const buf = enc.encode('pm-room:' + sorted);
  return crypto.subtle.digest('SHA-256', buf).then(arr => {
    const b = new Uint8Array(arr);
    return cryptoUtils.b64url.enc(b);
  });
}

export async function deriveSignalKey(myPrivPkcs8_b64u, friendPub_b64u, myPub_b64u) {
  // Import keys and derive AES-GCM key for signaling channel (same static ECDH as for datachannel)
  const my = await cryptoUtils.importIdentity(myPub_b64u, myPrivPkcs8_b64u);
  const theirPub = await cryptoUtils.importPublic(friendPub_b64u);
  return cryptoUtils.deriveAesKey(my.privateKey, theirPub);
}

export function createSignaling(roomId, onMessage, { encryptWithKey=null } = {}) {
  const url = CONFIG.SIGNALING_URL;
  if (!url) return null;

  let ws = null;
  let pending = [];
  let open = false;

  async function enc(obj) {
    if (!encryptWithKey) return JSON.stringify(obj);
    const payload = await cryptoUtils.encryptJson(encryptWithKey, obj);
    return JSON.stringify({ __enc: true, payload });
  }
  async function dec(text) {
    const obj = JSON.parse(text);
    if (obj && obj.__enc && encryptWithKey) {
      return await cryptoUtils.decryptJson(encryptWithKey, obj.payload);
    }
    return obj;
  }

  const api = {
    connect() {
      ws = new WebSocket(url + '?room=' + encodeURIComponent(roomId));
      ws.onopen = async () => {
        open = true;
        const toSend = pending.slice(); pending.length = 0;
        for (const msg of toSend) ws.send(await enc(msg));
      };
      ws.onmessage = async (ev) => { onMessage(await dec(ev.data)); };
      ws.onclose = () => { open = false; };
      ws.onerror = () => { /* ignore, onclose will follow */ };
      return api;
    },
    async send(msg) {
      const wire = await enc(msg);
      if (!open) { pending.push(msg); return; }
      try { ws.send(wire); } catch { pending.push(msg); }
    },
    close() { try { ws && ws.close(); } catch {} open = false; }
  };

  return api.connect();
}
