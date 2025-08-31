import { db } from './db.js';
import { cryptoUtils } from './crypto.js';
import { rtc } from './webrtc.js';

const state = {
  me: null,               // {publicKeyRaw, privateKeyPkcs8, fingerprint}
  friends: new Map(),     // fp -> friend
  conns: new Map(),       // fp -> { pc, dc, aesKey }
  selectedFriend: null,   // fp
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
  joinModal: document.getElementById('join-modal'),
  joinInviteInput: document.getElementById('join-invite-input'),
  joinAnswerOutput: document.getElementById('join-answer-output'),
  copyJoinAnswer: document.getElementById('copy-join-answer'),
  btnJoinCode: document.getElementById('btn-join-code'),
  openJoinFromInvite: document.getElementById('open-join-from-invite'),   
};

function shortFp(fp){ return fp.split(' ').slice(0,6).join(' '); }
function initials(name){ return (name||'F').trim().slice(0,2).toUpperCase(); }

async function ensureIdentity() {
  let me = await db.getKV('identity');
  if (!me) {
    me = await cryptoUtils.generateIdentity();
    await db.setKV('identity', me);
  }
  state.me = me;
  ui.myId.textContent = `Your fingerprint: ${shortFp(me.fingerprint)}`;
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
    empty.className = 'empty'; empty.textContent = 'No friends yet. Click "Add friend" to pair.';
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

async function selectFriend(fp) {
  state.selectedFriend = fp;
  renderMessages();
}

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

// Messaging model
function newMessage(text) {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: state.me.fingerprint,
    text,
    deliveredTo: [], // fingerprints
    seenBy: [state.me.fingerprint]
  };
}

async function handleIncoming(friendFp, payload) {
  // payload is encrypted { iv, ct } of an object like {type, data}
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
        // forward to others (gossip), except sender and those who already saw it
        for (const [fp, c] of state.conns.entries()) {
          if (fp === friendFp) continue;
          if (m.seenBy?.includes(fp)) continue;
          sendEncrypted(fp, { type:'chat', data: { ...m, seenBy: Array.from(new Set([...(m.seenBy||[]), fp])) } });
        }
      }
      // mark delivered to friend
      if (!exists || !(exists.deliveredTo||[]).includes(friendFp)) {
        const updated = exists || m;
        updated.deliveredTo = Array.from(new Set([...(updated.deliveredTo||[]), friendFp]));
        await db.putMessage(updated);
      }
    } else if (msg.type === 'have') {
      // friend tells us which messages they have (ids). Send missing ones.
      const ids = msg.data.ids || [];
      const recent = await db.recentMessages(200);
      const missing = recent.filter(m => !ids.includes(m.id));
      for (const m of missing) {
        await sendEncrypted(friendFp, { type:'chat', data: m });
      }
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

async function sendToAll(obj) {
  for (const [fp, conn] of state.conns.entries()) {
    await sendEncrypted(fp, obj);
  }
}

async function onDataChannelMessage(friendFp, ev) {
  const data = JSON.parse(ev.data);
  await handleIncoming(friendFp, data);
}

function wireDataChannel(friend, conn) {
  const { dc } = conn;
  dc.addEventListener('open', async () => {
    renderFriendList();
    // on connect, exchange "have" lists to sync
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
  // send to all connected friends
  await sendToAll({ type:'chat', data: m });
});

ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.send.click(); });

// Pairing flow: Create invite (as offerer)
ui.btnCreateInvite.addEventListener('click', async () => {
  const { state: rstate, code } = await rtc.createInvite(state.me, '');
  ui.inviteCode.value = code;
  ui.invitePeerFp.textContent = shortFp(state.me.fingerprint);
  ui.inviteModal.showModal();
  // Temporarily hold the state in window to finish pairing
  window.__pendingInviteState = rstate;
});

ui.copyInvite.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ui.inviteCode.value); } catch {}
});

ui.completeInviteBtn.addEventListener('click', async () => {
  const ans = ui.answerInput.value.trim();
  if (!ans) return;
  try {
    const friend = await rtc.completeInvite(state.me, window.__pendingInviteState, ans);
    // set up encryption and connection bookkeeping
    const conn = window.__pendingInviteState;
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

// Pairing flow: Join with invite (as answerer)
// ui.friendList.addEventListener('dblclick', () => ui.joinModal.showModal()); // shortcut: double click empty area (now made more explict)
document.addEventListener('keydown', (e)=>{ if(e.key==='J' && (e.metaKey||e.ctrlKey)) ui.joinModal.showModal(); });

ui.joinInviteInput.addEventListener('input', async () => {
  const code = ui.joinInviteInput.value.trim();
  if (!code) return;
  try {
    const { state: rstate, friend, code: answer } = await rtc.acceptInviteAndCreateAnswer(state.me, code);
    window.__pendingJoinState = { rstate, friend };
    ui.joinAnswerOutput.value = answer;
    ui.copyJoinAnswer.disabled = false;

    // once the inviter pastes our answer, the connection should establish
    rstate.pc.addEventListener('connectionstatechange', async () => {
      if (rstate.pc.connectionState === 'connected') {
        await rtc.setupEncryption(state.me, friend, rstate);
        state.conns.set(friend.fingerprint, rstate);
        wireDataChannel(friend, rstate);
        renderFriendList();
        ui.joinModal.close();
      }
    });

    rstate.pc.ondatachannel = (ev) => {
      rstate.dc = ev.channel;
      wireDataChannel(friend, rstate);
    };
  } catch (e) {
    // ignore parsing errors while typing
  }
});

ui.copyJoinAnswer.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ui.joinAnswerOutput.value); } catch {}
});

// Open the "Join with code" modal directly
ui.btnJoinCode.addEventListener('click', () => ui.joinModal.showModal());

// Link inside the invite modal to switch to the join modal
ui.openJoinFromInvite?.addEventListener('click', (e) => {
  e.preventDefault();
  ui.inviteModal.close();
  ui.joinModal.showModal();
});

// Auto-restore existing friends is not possible without a signaling server.
// You will need to re-pair (exchange codes) to connect after reloads.
// However, all your messages stay in IndexedDB and will sync when reconnected.

// Boot
(async function boot(){
  await ensureIdentity();
  await loadFriends();
  renderMessages();
})();
