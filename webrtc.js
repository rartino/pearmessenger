// WebRTC with optional signaling (for auto-reconnect) and encrypted DataChannel transport
import { cryptoUtils } from './crypto.js';
import { db } from './db.js';
import { CONFIG } from './config.js';
import { createSignaling, deriveRoomId, deriveSignalKey } from './signaling.js';

export const rtc = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const CODE_PREFIX = 'pm1:'; // manual pairing

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  async function iceGatheringComplete(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function encodeCode(obj) { return CODE_PREFIX + cryptoUtils.b64url.enc(new TextEncoder().encode(JSON.stringify(obj))); }
  function decodeCode(code) { if (!code.startsWith(CODE_PREFIX)) throw new Error('Invalid code prefix'); const json = new TextDecoder().decode(cryptoUtils.b64url.dec(code.slice(CODE_PREFIX.length))); return JSON.parse(json); }

  // Manual invite (offer/answer) for first-time pairing
  async function createInvite(myIdentity, displayName='') {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('pm', { ordered:true });
    const state = { pc, dc, aesKey: null };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await iceGatheringComplete(pc);

    const invite = { type: 'offer', sdp: pc.localDescription.sdp, me: { pub: myIdentity.publicKeyRaw, fp: myIdentity.fingerprint, name: displayName || '' } };
    return { state, code: encodeCode(invite) };
  }

  async function acceptInviteAndCreateAnswer(myIdentity, inviteCode) {
    const invite = decodeCode(inviteCode);
    if (invite.type !== 'offer') throw new Error('Expected offer code');

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const state = { pc, dc: null, aesKey: null };
    pc.ondatachannel = (ev) => { state.dc = ev.channel; };

    await pc.setRemoteDescription({ type:'offer', sdp: invite.sdp });
    const answerDesc = await pc.createAnswer();
    await pc.setLocalDescription(answerDesc);
    await iceGatheringComplete(pc);

    const friend = { fingerprint: invite.me.fp, name: invite.me.name || 'Friend', pub: invite.me.pub, lastSeen: Date.now(), connected: false };
    await db.addFriend(friend);

    const answer = { type: 'answer', sdp: pc.localDescription.sdp, you: { pub: myIdentity.publicKeyRaw, fp: myIdentity.fingerprint } };
    return { state, friend, code: encodeCode(answer) };
  }

  async function completeInvite(myIdentity, state, answerCode) {
    const ans = decodeCode(answerCode);
    if (ans.type !== 'answer') throw new Error('Expected answer code');
    await state.pc.setRemoteDescription({ type:'answer', sdp: ans.sdp });

    const friend = { fingerprint: ans.you.fp, name: 'Friend', pub: ans.you.pub, lastSeen: Date.now(), connected: false };
    await db.addFriend(friend);
    return friend;
  }

  async function setupEncryption(myId, friend, state) {
    const keys = await cryptoUtils.importIdentity(myId.publicKeyRaw, myId.privateKeyPkcs8);
    const theirPub = await cryptoUtils.importPublic(friend.pub);
    const aesKey = await cryptoUtils.deriveAesKey(keys.privateKey, theirPub);
    state.aesKey = aesKey;
  }

  // --- Auto reconnect with signaling (optional) ---
  async function connectWithSignaling(me, friend, handlers) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const state = { pc, dc: null, aesKey: null, signaling: null, reconnectBackoff: CONFIG.RECONNECT_MIN_MS };

    const sigKey = await deriveSignalKey(me.privateKeyPkcs8, friend.pub, me.publicKeyRaw);
    const roomId = await deriveRoomId(me.publicKeyRaw, friend.pub);
    const signaling = createSignaling(roomId, async (msg) => {
      if (!msg || msg.fp === me.fingerprint) return; // ignore own echoes
      if (msg.t === 'offer') {
        await pc.setRemoteDescription({ type:'offer', sdp: msg.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        signaling.send({ t:'answer', sdp: pc.localDescription.sdp, fp: me.fingerprint });
      } else if (msg.t === 'answer') {
        await pc.setRemoteDescription({ type:'answer', sdp: msg.sdp });
      } else if (msg.t === 'ice' && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      } else if (msg.t === 'hello') {
        // other side came online; try to negotiate
        negotiate(true);
      }
    }, { encryptWithKey: sigKey });
    state.signaling = signaling;

    function resetBackoff() { state.reconnectBackoff = CONFIG.RECONNECT_MIN_MS; }
    function bumpBackoff() { state.reconnectBackoff = Math.min(CONFIG.RECONNECT_MAX_MS, Math.floor(state.reconnectBackoff * 1.8)); }

    function negotiate(iceRestart=false) {
      (async () => {
        try {
          const offer = await pc.createOffer({ iceRestart });
          await pc.setLocalDescription(offer);
          await iceGatheringComplete(pc);
          signaling.send({ t:'offer', sdp: pc.localDescription.sdp, fp: me.fingerprint });
        } catch (e) {}
      })();
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) signaling.send({ t:'ice', candidate: ev.candidate, fp: me.fingerprint });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      handlers.onConnState?.(s);
      if (s === 'connected') { resetBackoff(); }
      if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        // attempt reconnection
        setTimeout(() => negotiate(true), state.reconnectBackoff);
        bumpBackoff();
      }
    };
    pc.ondatachannel = (ev) => {
      state.dc = ev.channel;
      handlers.onDataChannel?.(state.dc);
    };

    // Create our datachannel up-front; remote may also create theirs
    const dc = pc.createDataChannel('pm', { ordered:true });
    state.dc = dc;
    handlers.onDataChannel?.(dc);

    // Kick off initial negotiation
    negotiate(false);
    // Announce presence (peer may reply with an offer)
    signaling.send({ t:'hello', fp: me.fingerprint });

    return state;
  }

  return {
    createInvite, acceptInviteAndCreateAnswer, completeInvite, setupEncryption,
    connectWithSignaling,
    encodeCode, decodeCode
  };
})();
