// WebCrypto helpers for E2E encryption using ECDH (P-256) + AES-GCM
export const cryptoUtils = (() => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const b64url = {
    enc: (arr) => btoa(String.fromCharCode(...new Uint8Array(arr)))
                  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,''),
    dec: (str) => {
      str = str.replace(/-/g, '+').replace(/_/g, '/');
      const pad = str.length % 4 ? '===='.slice(str.length % 4) : '';
      const bin = atob(str + pad);
      const bytes = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }
  };

  async function sha256(buf) {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(hash);
  }

  function hex(arr) {
    return Array.from(new Uint8Array(arr)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function generateIdentity() {
    const keyPair = await crypto.subtle.generateKey(
      { name:'ECDH', namedCurve:'P-256' },
      true,
      ['deriveBits','deriveKey']
    );
    const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const prvPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const fp = hex(await sha256(pubRaw)).match(/.{1,4}/g).join(' ');
    return { 
      publicKeyRaw: b64url.enc(pubRaw), 
      privateKeyPkcs8: b64url.enc(prvPkcs8),
      fingerprint: fp
    };
  }

  async function importIdentity(pubRaw_b64u, prvPkcs8_b64u) {
    const pubKey = await crypto.subtle.importKey('raw', b64url.dec(pubRaw_b64u), {name:'ECDH', namedCurve:'P-256'}, true, []);
    const prvKey = await crypto.subtle.importKey('pkcs8', b64url.dec(prvPkcs8_b64u), {name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits','deriveKey']);
    return { publicKey: pubKey, privateKey: prvKey };
  }

  async function importPublic(pubRaw_b64u) {
    return crypto.subtle.importKey('raw', b64url.dec(pubRaw_b64u), {name:'ECDH', namedCurve:'P-256'}, true, []);
  }

  async function deriveAesKey(myPrivateKey, theirPublicKey) {
    // Directly derive AES-GCM key (256-bit) from ECDH shared secret
    return crypto.subtle.deriveKey(
      { name:'ECDH', public: theirPublicKey },
      myPrivateKey,
      { name:'AES-GCM', length:256 },
      false,
      ['encrypt','decrypt']
    );
  }

  async function encryptJson(aesKey, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = textEncoder.encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, aesKey, plaintext);
    return { iv: b64url.enc(iv), ct: b64url.enc(ct) };
  }

  async function decryptJson(aesKey, payload) {
    const iv = new Uint8Array(b64url.dec(payload.iv));
    const ct = b64url.dec(payload.ct);
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, aesKey, ct);
    return JSON.parse(textDecoder.decode(pt));
  }

  return {
    b64url, sha256, hex,
    generateIdentity, importIdentity, importPublic, deriveAesKey,
    encryptJson, decryptJson
  };
})();
