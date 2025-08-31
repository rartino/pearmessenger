import { db } from './db.js';
import { cryptoUtils } from './crypto.js';
import { rtc } from './webrtc.js';

function qrURL(data, size=256){ const base = 'https://api.qrserver.com/v1/create-qr-code/'; return base + '?size=' + size + 'x' + size + '&data=' + encodeURIComponent(data); }

const state = {
  me: null,
  friends: new Map(),
  conns: new Map(),
  selectedFriend: null,
};

const ui = {
  myId: document.getElementById('my-id'),
  friendList: document.getElementById('friend-list'),
  messages: document.getElementById('messages'),
  input: document.getElementById('message-input'),
  send: document.getElementById('send-btn'),

  inviteModal: document.getElementById('invite-modal'),
  inviteCode: document.getElementById('invite-code'),
  invitePeerFp: document.getElementById('invite-peer-fp'),
  copyInvite: document.getElementById('copy-invite'),
  completeInviteBtn: document.getElementById('complete-invite'),
  answerInput: document.getElementById('answer-input'),
  btnCreateInvite: document.getElementById('btn-create-invite'),

  // QR + toggles + fingerprints
  btnJoinCode: document.getElementById('btn-join-code'),
  openJoinFromInvite: document.getElementById('open-join-from-invite'),
  inviteQR: document.getElementById('invite-qr'),
  inviteQRWrap: document.getElementById('invite-qr-wrap'),
  inviteCodeWrap: document.getElementById('invite-code-wrap'),
  toggleInviteCode: document.getElementById('toggle-invite-code'),
  inviteEmojiFp: document.getElementById('invite-emoji-fp'),
  inviteWordFp: document.getElementById('invite-word-fp'),
  toggleInviteQR: document.getElementById('toggle-invite-qr'),

  joinModal: document.getElementById('join-modal'),
  joinInviteInput: document.getElementById('join-invite-input'),
  joinAnswerOutput: document.getElementById('join-answer-output'),
  copyJoinAnswer: document.getElementById('copy-join-answer'),
  joinQRWrap: document.getElementById('join-qr-wrap'),
  joinCodeWrap: document.getElementById('join-code-wrap'),
  joinAnswerQR: document.getElementById('join-answer-qr'),
  toggleJoinCode: document.getElementById('toggle-join-code'),
  toggleJoinQR: document.getElementById('toggle-join-qr'),
  joinInviterEmojiFp: document.getElementById('join-inviter-emoji-fp'),
  joinInviterWordFp: document.getElementById('join-inviter-word-fp'),
  joinMyEmojiFp: document.getElementById('join-my-emoji-fp'),
  joinMyWordFp: document.getElementById('join-my-word-fp'),
};

function shortFp(fp){ return fp.split(' ').slice(0,6).join(' '); }
function initials(name){ return (name||'F').trim().slice(0,2).toUpperCase(); }

async function ensureIdentity() {
  let me = await db.getKV('identity');
  if (!me) { me = await cryptoUtils.generateIdentity(); await db.setKV('identity', me); }
  state.me = me;
  ui.myId.textContent = `Your fingerprint: ${shortFp(me.fingerprint)}`;
  // Precompute emoji/word fingerprints
  cryptoUtils.emojiFingerprintFromPubRaw(me.publicKeyRaw).then(v => { if (ui.inviteEmojiFp) ui.inviteEmojiFp.textContent = v; if (ui.joinMyEmojiFp) ui.joinMyEmojiFp.textContent = v; });
  cryptoUtils.wordFingerprintFromPubRaw(me.publicKeyRaw).then(v => { if (ui.inviteWordFp) ui.inviteWordFp.textContent = v; if (ui.joinMyWordFp) ui.joinMyWordFp.textContent = v; });
}

async function loadFriends() {
  const list = await db.allFriends();
  list.forEach(f => state.friends.set(f.fingerprint, f));
  renderFriendList();
}

function renderFriendList() {
  ui.friendList.innerHTML = '';
  if (state.friends.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty'; empty.textContent = 'No friends yet. Click "Add friend" or "Join with code" to pair.';
    ui.friendList.appendChild(empty);
    return;
  }
  for (const f of state.friends.values()) {
    const row = document.createElement('div');
    row.className = 'friend'; row.dataset.fp = f.fingerprint;
    row.innerHTML = `<div class="avatar">${initials(f.name)}</div>
      <div class="meta"><div class="name">${f.name || 'Friend'}</div>
      <div class="fp">${shortFp(f.fingerprint)}</div></div>
      <div class="status"><span class="badge">${state.conns.get(f.fingerprint)?.dc?.readyState === 'open' ? 'online' : 'offline'}</span></div>`;
    row.addEventListener('click', () => selectFriend(f.fingerprint));
    ui.friendList.appendChild(row);
  }
}

async function selectFriend(fp) { state.selectedFriend = fp; renderMessages(); }

async function renderMessages() {
  const msgs = await db.recentMessages(300);
  ui.messages.innerHTML = '';
  if (!msgs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty'; empty.textContent = 'No messages yet.';
    ui.messages.appendChild(empty);
    return;
  }
  for (const m of msgs) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.from === state.me.fingerprint ? ' me' : '');
    bubble.innerHTML = `<div class="text"></div><div class="meta">${new Date(m.ts).toLocaleString()} • ${m.from === state.me.fingerprint ? 'you' : 'friend'}</div>`;
    bubble.querySelector('.text').textContent = m.text;
    ui.messages.appendChild(bubble);
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function newMessage(text) {
  return { id: crypto.randomUUID(), ts: Date.now(), from: state.me.fingerprint, text, deliveredTo: [], seenBy: [state.me.fingerprint] };
}

async function handleIncoming(friendFp, payload) {
  const conn = state.conns.get(friendFp);
  if (!conn?.aesKey) return;
  try {
    const msg = await cryptoUtils.decryptJson(conn.aesKey, payload);
    if (msg.type === 'chat') {
      const m = msg.data;
      const exists = await db.getMessage(m.id);
      if (!exists) {
        await db.putMessage(m);
        renderMessages();
        // gossip to others
        for (const [fp, c] of state.conns.entries()) {
          if (fp === friendFp) continue;
          if (m.seenBy?.includes(fp)) continue;
          sendEncrypted(fp, { type:'chat', data: { ...m, seenBy: Array.from(new Set([...(m.seenBy||[]), fp])) } });
        }
      }
      // mark delivered to sender
      const updated = exists || m;
      updated.deliveredTo = Array.from(new Set([...(updated.deliveredTo||[]), friendFp]));
      await db.putMessage(updated);
    } else if (msg.type === 'have') {
      const ids = msg.data.ids || [];
      const recent = await db.recentMessages(200);
      const missing = recent.filter(m => !ids.includes(m.id));
      for (const m of missing) await sendEncrypted(friendFp, { type:'chat', data: m });
    }
  } catch (e) {
    console.warn('Failed to decrypt/process incoming', e);
  }
}

async function sendEncrypted(friendFp, obj) {
  const conn = state.conns.get(friendFp);
  if (!conn?.dc || conn.dc.readyState !== 'open' || !conn.aesKey) return;
  const payload = await cryptoUtils.encryptJson(conn.aesKey, obj);
  conn.dc.send(JSON.stringify(payload));
}

async function sendToAll(obj) { for (const [fp] of state.conns.entries()) await sendEncrypted(fp, obj); }

async function onDataChannelMessage(friendFp, ev) {
  const data = JSON.parse(ev.data);
  await handleIncoming(friendFp, data);
}

function wireDataChannel(friend, conn) {
  const { dc } = conn;
  dc.addEventListener('open', async () => {
    renderFriendList();
    const recent = await db.recentMessages(200);
    await sendEncrypted(friend.fingerprint, { type:'have', data: { ids: recent.map(m => m.id) } });
  });
  dc.addEventListener('close', () => renderFriendList());
  dc.addEventListener('message', (ev) => onDataChannelMessage(friend.fingerprint, ev));
}

// UI events
ui.send.addEventListener('click', async () => {
  const text = ui.input.value.trim();
  if (!text) return;
  const m = newMessage(text);
  await db.putMessage(m);
  ui.input.value='';
  renderMessages();
  await sendToAll({ type:'chat', data: m });
});
ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.send.click(); });

// Invite (offerer)
ui.btnCreateInvite.addEventListener('click', async () => {
  const { state: rstate, code } = await rtc.createInvite(state.me, '');
  ui.inviteCode.value = code;
  ui.invitePeerFp.textContent = shortFp(state.me.fingerprint);
  if (ui.inviteQR) ui.inviteQR.src = qrURL(code, 256);
  if (ui.inviteQRWrap && ui.inviteCodeWrap) { ui.inviteQRWrap.style.display='block'; ui.inviteCodeWrap.style.display='none'; }
  ui.inviteModal.showModal();
  window.__pendingInviteState = rstate;
});
ui.copyInvite.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ui.inviteCode.value); } catch {} });
ui.toggleInviteCode?.addEventListener('click', () => { ui.inviteQRWrap.style.display='none'; ui.inviteCodeWrap.style.display='block'; });
ui.toggleInviteQR?.addEventListener('click', () => { ui.inviteQRWrap.style.display='block'; ui.inviteCodeWrap.style.display='none'; });

ui.completeInviteBtn.addEventListener('click', async () => {
  const ans = ui.answerInput.value.trim();
  if (!ans) return;
  try {
    const friend = await rtc.completeInvite(state.me, window.__pendingInviteState, ans);
    const conn = window.__pendingInviteState;
    // encryption and wiring
    await rtc.setupEncryption(state.me, friend, conn);
    state.conns.set(friend.fingerprint, conn);
    conn.dc.addEventListener('message', (ev) => onDataChannelMessage(friend.fingerprint, ev));
    conn.dc.addEventListener('open', () => renderFriendList());
    conn.dc.addEventListener('close', () => renderFriendList());
    ui.inviteModal.close();
    renderFriendList();
  } catch (e) {
    alert('Failed to complete pairing: ' + e.message);
  }
});

// Join (answerer)
ui.btnJoinCode.addEventListener('click', () => ui.joinModal.showModal());
ui.openJoinFromInvite?.addEventListener('click', (e) => { e.preventDefault(); ui.inviteModal.close(); ui.joinModal.showModal(); });

ui.joinInviteInput.addEventListener('input', async () => {
  const code = ui.joinInviteInput.value.trim();
  if (!code) return;
  try {
    // update inviter fingerprints immediately for verification
    try { const inv = rtc.decodeCode(code); if (inv?.me?.pub) {
      cryptoUtils.emojiFingerprintFromPubRaw(inv.me.pub).then(v => { if (ui.joinInviterEmojiFp) ui.joinInviterEmojiFp.textContent = v; });
      cryptoUtils.wordFingerprintFromPubRaw(inv.me.pub).then(v => { if (ui.joinInviterWordFp) ui.joinInviterWordFp.textContent = v; });
    }} catch {}
    const { state: rstate, friend, code: answer } = await rtc.acceptInviteAndCreateAnswer(state.me, code);
    window.__pendingJoinState = { rstate, friend };
    ui.joinAnswerOutput.value = answer;
    ui.copyJoinAnswer.disabled = false;
    if (ui.joinAnswerQR) ui.joinAnswerQR.src = qrURL(answer, 256);

    rstate.pc.addEventListener('connectionstatechange', async () => {
      if (rstate.pc.connectionState === 'connected') {
        await rtc.setupEncryption(state.me, friend, rstate);
        state.conns.set(friend.fingerprint, rstate);
        wireDataChannel(friend, rstate);
        renderFriendList();
        ui.joinModal.close();
      }
    });
    rstate.pc.ondatachannel = (ev) => { rstate.dc = ev.channel; wireDataChannel(friend, rstate); };
  } catch (e) {
    // ignore parse/setup errors while typing
  }
});
ui.copyJoinAnswer.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ui.joinAnswerOutput.value); } catch {} });
ui.toggleJoinCode?.addEventListener('click', () => { ui.joinQRWrap.style.display='none'; ui.joinCodeWrap.style.display='block'; });
ui.toggleJoinQR?.addEventListener('click', () => { ui.joinQRWrap.style.display='block'; ui.joinCodeWrap.style.display='none'; });

// Boot
(async function boot(){ await ensureIdentity(); await loadFriends(); renderMessages(); })();
