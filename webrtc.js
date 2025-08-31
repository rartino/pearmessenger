// WebRTC pairing (manual code exchange) and encrypted DataChannel transport
import { cryptoUtils } from './crypto.js';
import { db } from './db.js';

export const rtc = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const CODE_PREFIX = 'pm1:'; // versioned

  async function iceGatheringComplete(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function encodeCode(obj) { return CODE_PREFIX + cryptoUtils.b64url.enc(new TextEncoder().encode(JSON.stringify(obj))); }
  function decodeCode(code) { if (!code.startsWith(CODE_PREFIX)) throw new Error('Invalid code prefix'); const json = new TextDecoder().decode(cryptoUtils.b64url.dec(code.slice(CODE_PREFIX.length))); return JSON.parse(json); }

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

  return { createInvite, acceptInviteAndCreateAnswer, completeInvite, setupEncryption, encodeCode, decodeCode };
})();
