/* Сетевой слой онлайн-режима.
   Архитектура: хост-игрок авторитетен — у него крутится движок (engine.js),
   состояние комнаты хранится в Supabase (cf_rooms.state) и рассылается через
   Realtime. Остальные игроки — клиенты: отправляют действия (бросок, ответы на
   решения) в cf_actions, хост применяет их движком и публикует новое состояние.
   Для локальной разработки двух вкладок вместо Supabase используется мок
   (js/supabase-mock.js) — включается url: 'mock' в js/config.js. */
window.CF_NET = (function () {
  let sb = null;
  let role = 'none';            // 'none' | 'host' | 'client'
  let code = null;
  let ver = 0;
  let channel = null;
  let onStateCb = null;
  let onActionCb = null;
  const resolvers = {};         // seq -> fn(value) — ожидающие решения хоста
  let lastActionId = 0;
  let pushPending = false;
  let queue = Promise.resolve();
  let lobby = [];               // [{name, key}] — гости в лобби (на хосте)

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => fail(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  }

  async function init() {
    if (sb) return;
    const c = window.CF_CONFIG || {};
    if (!c.supabaseUrl || !c.supabaseKey) throw new Error('Заполните js/config.js (URL и anon-ключ Supabase)');
    if (c.supabaseUrl === 'mock') {
      await loadScript('js/supabase-mock.js');
      window.supabase = window.supabaseMock();
    } else {
      if (!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
    }
    sb = window.supabase.createClient(c.supabaseUrl, c.supabaseKey);
  }

  // ---------- хост ----------
  async function createRoom(myCode) {
    code = myCode;
    role = 'host';
    lobby = [];
    const res = await sb.from('cf_rooms').upsert({ code, state: { lobby: [], started: false }, version: 0 });
    if (res.error) throw res.error;
    subscribeHost();
    return code;
  }

  function subscribeHost() {
    channel = sb.channel('cf-' + code + '-host');
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cf_actions', filter: 'code=eq.' + code },
      msg => onIncomingAction(msg.new));
    channel.subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        // подтянуть действия, пришедшие до подписки
        const res = await sb.from('cf_actions').select('*').eq('code', code).order('id');
        if (res.data) for (const row of res.data) onIncomingAction(row);
      }
    });
  }

  function onIncomingAction(row) {
    if (!row || row.id <= lastActionId) return;
    lastActionId = row.id;
    // действия обрабатываются строго по одному, в порядке поступления
    queue = queue.then(() => onActionCb(row)).catch(e => console.error('Ошибка обработки действия:', e));
  }

  // ---------- клиент ----------
  async function joinRoom(myCode, name, key) {
    code = myCode;
    role = 'client';
    const check = await sb.from('cf_rooms').select('state').eq('code', code).maybeSingle();
    if (check.error || !check.data) throw new Error('Комната ' + code + ' не найдена');
    subscribeClient();
    await sb.from('cf_actions').insert({ code, player_id: -1, action: { type: 'join', name, key } });
    if (onStateCb) onStateCb(check.data.state);
  }

  function subscribeClient() {
    channel = sb.channel('cf-' + code + '-client');
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cf_rooms', filter: 'code=eq.' + code },
      msg => { if (onStateCb) onStateCb(msg.new.state); });
    channel.subscribe();
  }

  // ---------- действия и решения ----------
  async function sendAction(action, playerId) {
    const res = await sb.from('cf_actions').insert({ code, player_id: playerId ?? -1, action });
    if (res.error) throw res.error;
  }

  function pushStateSoon() {
    if (role !== 'host' || pushPending) return;
    pushPending = true;
    setTimeout(async () => {
      pushPending = false;
      const st = window.CF_ENGINE.getState();
      if (!st || !code) return;
      const clean = JSON.parse(JSON.stringify({ ...st, busy: false }));
      const res = await sb.from('cf_rooms').update({ state: clean, version: ++ver, updated_at: new Date().toISOString() }).eq('code', code);
      if (res.error) console.error('Ошибка публикации состояния:', res.error);
    }, 250);
  }

  async function pushLobby() {
    await sb.from('cf_rooms').update({ state: { lobby, started: false } }).eq('code', code);
  }

  /* Решение удалённого игрока: публикуем pending в состояние и ждём ответ
     {seq, value} из cf_actions. */
  function decide(playerId, kind, payload) {
    return new Promise(resolve => {
      const st = window.CF_ENGINE.getState();
      const seq = (st.pendingSeq || 0) + 1;
      st.pendingSeq = seq;
      st.pending = { playerId, kind, payload, seq };
      resolvers[seq] = resolve;
      pushStateSoon();
      // страховка: если игрок ушёл — решение отменяется через 3 минуты
      setTimeout(() => {
        if (resolvers[seq]) {
          delete resolvers[seq];
          if (window.CF_ENGINE.getState()) window.CF_ENGINE.getState().pending = null;
          pushStateSoon();
          resolve({ timeout: true });
        }
      }, 180000);
    });
  }

  function resolveAction(act) {
    if (act.seq && resolvers[act.seq]) {
      const r = resolvers[act.seq];
      delete resolvers[act.seq];
      const st = window.CF_ENGINE.getState();
      if (st) st.pending = null;
      pushStateSoon();
      r(act.value);
      return true;
    }
    return false;
  }

  return {
    init,
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
