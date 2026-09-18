/* Локальный мок Supabase для разработки: две вкладки одного браузера
   общаются через localStorage + BroadcastChannel.
   Активируется, когда в js/config.js указано supabaseUrl: 'mock'.
   Реализует только ту поверхность SDK, которую использует net.js. */
window.supabaseMock = function () {
  const KEY = 'cf-mock-db';
  const BC = 'BroadcastChannel' in window ? new BroadcastChannel('cf-mock-db') : null;
  let db = load();
  const subs = [];

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { cf_rooms: {}, cf_actions: { maxId: 0, rows: [] } }; }
    catch (e) { return { cf_rooms: {}, cf_actions: { maxId: 0, rows: [] } }; }
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* переполнение — не критично */ } }
  function localDispatch(table, event, row, old) {
    for (const s of subs) {
      if (s.table === table && (s.event === '*' || s.event === event)) {
        try { s.cb({ new: row, old: old || null }); } catch (e) { console.error(e); }
      }
    }
  }
  function broadcast(table, event, row, old) {
    persist();
    if (BC) BC.postMessage({ table, event, row, old: old || null, db });
    localDispatch(table, event, row, old);
  }
  if (BC) BC.onmessage = e => { db = e.data.db; persist(); localDispatch(e.data.table, e.data.event, e.data.row, e.data.old); };

  function rowsOf(table) {
    if (!db[table]) db[table] = table === 'cf_rooms' ? {} : { maxId: 0, rows: [] };
    return db[table];
  }
  function matchFilters(row, filters) {
    return filters.every(f => {
      if (Array.isArray(f)) return String(row[f[0]]) === String(f[1]); // фильтр запроса [колонка, значение]
      const p = f.split('=');                                          // фильтр Realtime 'col=eq.val'
      return String(row[p[0]]) === String(p[2]);
    });
  }

  class Q {
    constructor(table) { this.t = table; this.filters = []; this.patch = null; }
    select() { return this; }
    order() { return this; }
    eq(c, v) { this.filters.push([c, String(v)]); return this; }
    single() { return this.exec('single'); }
    maybeSingle() { return this.exec('maybe'); }
    upsert(row) { return this.exec(() => {
      const t = rowsOf(this.t);
      const old = t[row.code] || null;
      t[row.code] = { ...old, ...row };
      broadcast(this.t, old ? 'UPDATE' : 'INSERT', t[row.code], old);
      return t[row.code];
    }); }
    insert(row) { return this.exec(() => {
      const t = rowsOf(this.t);
      const rec = { id: ++t.maxId, ...row };
      t.rows.push(rec);
      broadcast(this.t, 'INSERT', rec);
      return rec;
    }); }
    update(patch) { this.patch = patch; return this; }
    // Q — thenable: любой await по цепочке (например, .update().eq()) выполняет запрос
    then(onOk, onErr) { return this.exec('list').then(onOk, onErr); }
    exec(modeOrOp) {
      const self = this;
      return new Promise(res => {
        let data = null, error = null;
        try {
          if (typeof modeOrOp === 'function') data = modeOrOp();
          else {
            const t = db[self.t];
            const rows = self.t === 'cf_rooms' ? Object.values(t || {}) : ((t && t.rows) || []);
            const filtered = rows.filter(r => matchFilters(r, self.filters));
            if (self.patch) {
              data = [];
              for (const r of filtered) {
                const old = { ...r };
                Object.assign(r, self.patch);
                broadcast(self.t, 'UPDATE', r, old);
                data.push(r);
              }
            } else {
              data = filtered;
              if (modeOrOp === 'single' || modeOrOp === 'maybe') data = filtered[0] || null;
            }
          }
        } catch (e) { error = e; }
        res({ data, error });
      });
    }
  }

  return {
    createClient() {
      return {
        from: t => new Q(t),
        channel(name) {
          const ch = { id: name };
          ch.on = (event, opts, cb) => { subs.push({ table: opts.table, event: opts.event, cb }); return ch; };
          ch.subscribe = () => ({ unsubscribe() {} });
          return ch;
        },
      };
    },
  };
};
window.supabaseMockReset = () => localStorage.removeItem('cf-mock-db');
