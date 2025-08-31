// WebCrypto helpers for E2E encryption using ECDH (P-256) + AES-GCM
export const cryptoUtils = (() => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const b64url = {
    enc: (arr) => btoa(String.fromCharCode(...new Uint8Array(arr))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,''),
    dec: (str) => { str = str.replace(/-/g, '+').replace(/_/g, '/'); const pad = str.length % 4 ? '===='.slice(str.length % 4) : ''; const bin = atob(str + pad); const bytes = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i); return bytes.buffer; }
  };

  async function sha256(buf) { const hash = await crypto.subtle.digest('SHA-256', buf); return new Uint8Array(hash); }
  function hex(arr) { return Array.from(new Uint8Array(arr)).map(b => b.toString(16).padStart(2,'0')).join(''); }

  async function generateIdentity() {
    const keyPair = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits','deriveKey']);
    const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const prvPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const fp = hex(await sha256(pubRaw)).match(/.{1,4}/g).join(' ');
    return { publicKeyRaw: b64url.enc(pubRaw), privateKeyPkcs8: b64url.enc(prvPkcs8), fingerprint: fp };
  }

  async function importIdentity(pubRaw_b64u, prvPkcs8_b64u) {
    const pubKey = await crypto.subtle.importKey('raw', b64url.dec(pubRaw_b64u), {name:'ECDH', namedCurve:'P-256'}, true, []);
    const prvKey = await crypto.subtle.importKey('pkcs8', b64url.dec(prvPkcs8_b64u), {name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits','deriveKey']);
    return { publicKey: pubKey, privateKey: prvKey };
  }
  async function importPublic(pubRaw_b64u) { return crypto.subtle.importKey('raw', b64url.dec(pubRaw_b64u), {name:'ECDH', namedCurve:'P-256'}, true, []); }
  async function deriveAesKey(myPrivateKey, theirPublicKey) {
    return crypto.subtle.deriveKey({ name:'ECDH', public: theirPublicKey }, myPrivateKey, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
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

  // Emoji + word fingerprints (friendly verification)
  const EMOJI = ["😀","😁","😂","🤣","😃","😄","😅","😆","😉","😊","🙂","🙃","😋","😎","😍","😘","🤗","🤩","🤔","🤨","😐","😑","😶","🙄","😏","😣","😥","😮","🤐","😯","😪","😫","🥱","😴","😌","😛","😜","🤤","😒","😓","😔","😕","🙁","☹️","😖","😤","😢","😭","🤯","😳","🥵","🥶","😱","😨","😰","😥","😇","🤠","🤡","👻","💀","🤖","🎃","👾"];
  const WORDS_A = ["brisk","amber","calm","dizzy","eager","fuzzy","glossy","hollow","icy","jolly","keen","lively","mellow","nimble","oaky","peppy","quirky","rosy","snug","tidy","upbeat","vivid","witty","xenial","young","zesty","bold","crisp","dusky","earthy","fluent"];
  const WORDS_N = ["panda","rocket","violet","harbor","meadow","acorn","pixel","galaxy","raven","canyon","ember","thunder","lotus","marble","pebble","tunnel","comet","cactus","orchid","reef","maple","lagoon","aurora","bison","cinder","dolphin","echo","fjord","geyser","harp","igloo","jasper"];

  async function emojiFingerprintFromPubRaw(pubRaw_b64u) {
    const hash = await sha256(b64url.dec(pubRaw_b64u));
    const out = []; for (let i = 0; i < 8; i++) out.push(EMOJI[hash[i] & 63]);
    return out.join(' ');
  }
  async function wordFingerprintFromPubRaw(pubRaw_b64u) {
    const hash = await sha256(b64url.dec(pubRaw_b64u));
    const a1 = WORDS_A[hash[0] % WORDS_A.length];
    const n1 = WORDS_N[hash[1] % WORDS_N.length];
    const a2 = WORDS_A[hash[2] % WORDS_A.length];
    const n2 = WORDS_N[hash[3] % WORDS_N.length];
    return `${a1}-${n1}-${a2}-${n2}`;
  }

  return {
    b64url, sha256, hex,
    generateIdentity, importIdentity, importPublic, deriveAesKey,
    encryptJson, decryptJson,
    emojiFingerprintFromPubRaw, wordFingerprintFromPubRaw
  };
})();
