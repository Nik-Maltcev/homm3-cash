/* Сетевой слой онлайн-режима — P2P через PeerJS.
   Хост-игрок авторитетен: у него крутится движок, он рассылает состояние партии
   всем подключённым игрокам. Клиенты шлют действия (бросок, ответы на решения).
   Сигналинг — бесплатный облачный сервер PeerJS, регистрация и ключи не нужны.
   Номер комнаты — это часть идентификатора хоста в сети PeerJS. */
window.CF_NET = (function () {
  const ID_PREFIX = 'homm3-cash-room-';
  const SDK = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';

  let role = 'none';            // 'none' | 'host' | 'client'
  let code = null;
  let peer = null;
  let hostConn = null;          // у клиента: соединение с хостом
  const conns = new Map();      // у хоста: key -> соединение
  let onStateCb = null;
  let onActionCb = null;
  const resolvers = {};         // seq -> fn(value) — ожидающие решения хоста
  let lobby = [];               // [{name, key}] — гости в лобби (на хосте)
  let pushPending = false;
  let queue = Promise.resolve();

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => fail(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  }

  function genCode() { return String(1000 + Math.floor(Math.random() * 9000)); }
  const peerIdFor = c => ID_PREFIX + c;

  // ---------- хост ----------
  async function createRoom() {
    if (role === 'host') return code;
    await loadScript(SDK);
    for (let attempt = 0; attempt < 6; attempt++) {
      const c = genCode();
      const taken = await new Promise(resolve => {
        let settled = false;
        peer = new Peer(peerIdFor(c));
        peer.on('open', () => { if (!settled) { settled = true; resolve(false); } });
        peer.on('error', err => {
          if (!settled) { settled = true; try { peer.destroy(); } catch (e) {} resolve(err.type === 'unavailable-id'); }
        });
      });
      if (!taken) {
        role = 'host';
        code = c;
        lobby = [];
        wireHost();
        return c;
      }
    }
    throw new Error('Не удалось занять свободный номер, попробуйте ещё раз');
  }

  function wireHost() {
    peer.on('connection', conn => {
      conn.on('data', msg => {
        queue = queue.then(() => onHostMessage(conn, msg)).catch(e => console.error('Ошибка действия:', e));
      });
      conn.on('close', () => onClientLeft(conn));
    });
  }

  function onHostMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'join') {
      conn._key = msg.key;
      conn._name = msg.name;
      conns.set(msg.key, conn);
      if (!lobby.some(j => j.key === msg.key)) lobby.push({ name: (msg.name || 'Гость').replace(/[<>&"]/g, ''), key: msg.key });
      if (onActionCb) onActionCb({ action: { type: 'join', name: msg.name, key: msg.key } });
      pushStateNow();
      return;
    }
    if (msg.seq !== undefined && msg.seq !== null) { resolveAction(msg); return; }
    if (onActionCb) onActionCb({ action: msg });
  }

  function onClientLeft(conn) {
    if (conn._key && conns.get(conn._key) === conn) conns.delete(conn._key);
    // если у отключившегося игрока было ожидающее решение — отменяем его
    const st = window.CF_ENGINE.getState();
    if (st && st.pending) {
      const key = (st.playerKeys || [])[st.pending.playerId];
      if (key === conn._key) {
        const seq = st.pending.seq;
        st.pending = null;
        pushStateNow();
        resolveDirect(seq, { timeout: true });
      }
    }
  }
  function resolveDirect(seq, value) {
    const r = resolvers[seq];
    if (r) { delete resolvers[seq]; r(value); }
  }

  function broadcast(clean) {
    for (const conn of conns.values()) {
      try { conn.send(clean); } catch (e) { /* соединение могло умереть */ }
    }
  }

  function pushStateNow() {
    if (role !== 'host') return;
    const st = window.CF_ENGINE.getState();
    if (!st) { broadcast({ lobby, started: false }); return; }
    const clean = JSON.parse(JSON.stringify({ ...st, busy: false }));
    broadcast(clean);
  }

  function pushStateSoon() {
    if (role !== 'host' || pushPending) return;
    pushPending = true;
    setTimeout(() => { pushPending = false; pushStateNow(); }, 250);
  }

  async function pushLobby() { pushStateNow(); }

  // ---------- клиент ----------
  async function joinRoom(myCode, name, key) {
    if (role === 'client' && hostConn) return true;
    await loadScript(SDK);
    role = 'client';
    code = myCode;
    const connected = await new Promise(resolve => {
      let settled = false;
      const fail = () => { if (!settled) { settled = true; try { peer && peer.destroy(); } catch (e) {} resolve(false); } };
      try {
        peer = new Peer();
        peer.on('open', () => {
          const conn = peer.connect(peerIdFor(myCode), { reliable: true });
          conn.on('open', () => {
            if (!settled) { settled = true; hostConn = conn; resolve(true); }
          });
          conn.on('data', msg => { if (onStateCb) onStateCb(msg); });
          conn.on('close', () => { if (hostConn === conn) hostConn = null; });
          setTimeout(fail, 12000);
        });
        peer.on('error', () => fail());
      } catch (e) { fail(); }
    });
    if (!connected) throw new Error('Комната ' + myCode + ' не найдена или хост офлайн');
    hostConn.send({ type: 'join', name, key });
    return true;
  }

  function sendAction(action, playerId) {
    if (role === 'client' && hostConn) { try { hostConn.send(action); } catch (e) {} }
    // хост действует напрямую через движок — сетевая отправка не нужна
  }

  // ---------- решения ----------
  function decide(playerId, kind, payload) {
    return new Promise(resolve => {
      const st = window.CF_ENGINE.getState();
      const seq = (st.pendingSeq || 0) + 1;
      st.pendingSeq = seq;
      st.pending = { playerId, kind, payload, seq };
      resolvers[seq] = resolve;
      pushStateNow();
      const key = (st.playerKeys || [])[playerId];
      const conn = key ? conns.get(key) : null;
      if (conn) { try { conn.send({ seq, kind, payload }); } catch (e) {} }
      setTimeout(() => {
        if (resolvers[seq]) {
          delete resolvers[seq];
          const cur = window.CF_ENGINE.getState();
          if (cur) cur.pending = null;
          pushStateNow();
          resolve({ timeout: true });
        }
      }, 180000);
    });
  }

  function resolveAction(msg) {
    if (msg.seq && resolvers[msg.seq]) {
      const r = resolvers[msg.seq];
      delete resolvers[msg.seq];
      const st = window.CF_ENGINE.getState();
      if (st) st.pending = null;
      pushStateNow();
      r(msg.value);
      return true;
    }
    return false;
  }

  return {
    createRoom,
    joinRoom,
    sendAction,
    pushStateSoon,
    pushLobby,
    decide,
    resolveAction,
    addLobby(j) { lobby.push(j); },
    getLobby: () => lobby,
    onState(cb) { onStateCb = cb; },
    onAction(cb) { onActionCb = cb; },
    get role() { return role; },
    get code() { return code; },
    get active() { return role !== 'none'; },
  };
})();
