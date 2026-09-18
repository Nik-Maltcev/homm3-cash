/* UI-слой «Денежного потока»: рендеринг, модальные окна, взаимодействие.
   Вся игровая логика — в engine.js. */
(function () {
  const D = window.CF_DATA;
  const E = window.CF_ENGINE;
  const NET = window.CF_NET;
  const $ = sel => document.querySelector(sel);

  let NETMODE = null;      // null (хот-сейт) | 'host' | 'client'
  let myId = 0;            // номер игрока в онлайн-режиме (хост = 0)
  let myKey = '';
  let hostName = 'Хост';
  let lastPendingKey = '';
  let lastOverSeen = 0;

  function fmt(n) { return E.fmt(n); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Имя профессии с учётом темы (в HoMM-режиме — героический класс)
  function profName(pr) {
    return document.body.dataset.theme === 'homm' && pr.hommName ? pr.hommName : pr.name;
  }
  // Тематические заголовок / описание / эмодзи карты
  const homm = () => document.body.dataset.theme === 'homm';
  function cardT(c) { return homm() ? (c.hommTitle || c.hommName || c.title || c.name) : (c.title || c.name); }
  function cardD(c) { return (homm() && c.hommDesc) ? c.hommDesc : c.desc; }
  function cardE(d) { return (homm() && d.hommEmoji) ? d.hommEmoji : d.emoji; }

  // ================= МОДАЛЬНЫЕ ОКНА =================
  function openModal(html) {
    const root = $('#modal-root');
    root.classList.remove('hidden');
    root.innerHTML = `<div class="overlay"></div><div class="modal">${html}</div>`;
    return root;
  }
  function closeModal() {
    const root = $('#modal-root');
    root.classList.add('hidden');
    root.innerHTML = '';
  }
  function ask(title, bodyHtml, buttons) {
    return new Promise(res => {
      openModal(`<h3>${title}</h3><div class="modal-body">${bodyHtml}</div><div class="modal-btns"></div>`);
      const box = $('#modal-root .modal-btns');
      for (const b of buttons) {
        const el = document.createElement('button');
        el.className = 'btn ' + (b.cls || '');
        el.textContent = b.label;
        if (b.disabled) el.disabled = true;
        el.onclick = () => { closeModal(); res(b.value); };
        box.appendChild(el);
      }
    });
  }

  // ================= ПОЛЕ =================
  const CELL = {
    payday:    { ic: '💰', lb: 'ЗАРПЛАТА', title: 'Зарплата: доход минус расходы', hLb: 'ЖАЛОВАНЬЕ', hTitle: 'Жалованье: доход минус расходы' },
    small:     { ic: '💼', lb: 'СДЕЛКА',   title: 'Малая сделка', hLb: 'КЛАД',      hTitle: 'Клад: малая сделка' },
    big:       { ic: '💎', lb: 'Б. СДЕЛКА', title: 'Большая сделка', hLb: 'АРТЕФАКТ', hTitle: 'Артефакт: большая сделка' },
    doodad:    { ic: '🍩', lb: 'ДУДАД',    title: 'Дудад — обязательная трата', hLb: 'РОСКОШЬ', hTitle: 'Роскошь — обязательная трата' },
    market:    { ic: '📊', lb: 'РЫНОК',    title: 'Рынок: возможность продать актив', hLb: 'БАЗАР', hTitle: 'Базар: возможность продать владение' },
    charity:   { ic: '❤️', lb: 'БЛАГОТВ.', title: 'Благотворительность: 10% дохода за 2 кубика', hLb: 'ХРАМ', hTitle: 'Храм: 10% дохода за 2 кубика' },
    downsized: { ic: '😴', lb: 'СОКРАЩ.',  title: 'Сокращение: расходы и пропуск 2 ходов', hLb: 'ОПАЛА', hTitle: 'Опала: расходы и пропуск 2 ходов' },
    baby:      { ic: '👶', lb: 'РЕБЁНОК',  title: 'Ребёнок: расходы растут', hLb: 'НАСЛЕДНИК', hTitle: 'Наследник: расходы растут' },
    business:  { ic: '🏢', lb: 'БИЗНЕС',   title: 'Бизнес-возможность', hLb: 'ВЛАДЕНИЯ', hTitle: 'Владения: расширить угодья' },
    dream:     { ic: '🌟', lb: 'МЕЧТА',    title: 'Мечта: выкупи свою и победи', hLb: 'МЕЧТА', hTitle: 'Мечта: выкупи свою и победи' },
    luck:      { ic: '🎲', lb: 'УДАЧА',    title: 'Удача или неудача', hLb: 'СУДЬБА', hTitle: 'Судьба: фортуна или напасть' },
  };

  const BOARD = { size: 780, ratR: 232, ftR: 342, ratSize: 54, ftSize: 60 };
  let cellCoords = { rat: [], ft: [] };

  // Вписываем круглое поле в доступное место экрана (без прокрутки страницы)
  function fitBoard() {
    const zone = $('#board-zone');
    const b = $('#board');
    if (!zone || !b || !zone.clientWidth || !zone.clientHeight) return;
    const s = Math.min(1, (zone.clientWidth - 12) / BOARD.size, (zone.clientHeight - 12) / BOARD.size);
    b.style.transform = `scale(${s})`;
  }
  window.addEventListener('resize', fitBoard);

  function buildBoard() {
    const c = BOARD.size / 2;
    const ringRat = $('#ring-rat'), ringFt = $('#ring-ft');
    ringRat.innerHTML = ''; ringFt.innerHTML = '';
    cellCoords = { rat: [], ft: [] };
    D.ratTrack.forEach((kind, i) => cellCoords.rat.push(placeCell(ringRat, kind, i, D.ratTrack.length, c, BOARD.ratR, BOARD.ratSize, 'rat')));
    D.ftTrack.forEach((kind, i) => cellCoords.ft.push(placeCell(ringFt, kind, i, D.ftTrack.length, c, BOARD.ftR, BOARD.ftSize, 'ft')));
  }

  function placeCell(parent, kind, i, n, c, r, size, cls) {
    const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x = c + r * Math.cos(ang) - size / 2;
    const y = c + r * Math.sin(ang) - size / 2;
    const info = CELL[kind];
    const isHomm = document.body.dataset.theme === 'homm';
    const el = document.createElement('div');
    el.className = `cell ${cls} cell-${kind}`;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.title = isHomm ? info.hTitle : info.title;
    el.innerHTML = `<div class="ic">${info.ic}</div><div class="lb">${isHomm ? info.hLb : info.lb}</div>`;
    parent.appendChild(el);
    return { x: x + size / 2, y: y + size / 2 };
  }

  function renderTokens() {
    const S = E.getState();
    if (!S) return;
    const c = BOARD.size / 2;
    const box = $('#tokens');
    box.innerHTML = '';
    for (const p of S.players) {
      const ring = p.fastTrack ? 'ft' : 'rat';
      const idx = p.fastTrack ? p.ftPos : p.pos;
      const cc = cellCoords[ring][idx];
      const dx = cc.x - c, dy = cc.y - c;
      const len = Math.hypot(dx, dy) || 1;
      const push = (p.fastTrack ? -1 : 1) * (7 + p.id * 9);
      const el = document.createElement('div');
      el.className = 'token' + (p.id === S.cur && !S.over ? ' cur' : '');
      el.style.background = p.color;
      el.textContent = p.name[0].toUpperCase();
      el.style.left = (cc.x + dx / len * push) + 'px';
      el.style.top = (cc.y + dy / len * push) + 'px';
      el.style.transform = 'translate(-50%, -50%)';
      box.appendChild(el);
    }
    document.querySelectorAll('#board .cell').forEach(el => el.classList.remove('active'));
    const cur = S.players[S.cur];
    if (cur && !S.over) {
      const idx = cur.fastTrack ? cur.ftPos : cur.pos;
      const ring = cur.fastTrack ? 'ft' : 'rat';
      const cells = $(`#ring-${ring}`).children;
      if (cells[idx]) cells[idx].classList.add('active');
    }
  }

  // ================= РЕНДЕР ПАНЕЛЕЙ =================
  function renderAll() {
    const S = E.getState();
    if (!S) return;
    if (NETMODE === 'client') { renderClient(); return; }
    renderStrip();
    renderStatement();
    renderLoanbox();
    renderCenter();
    renderTokens();
    if (NETMODE === 'host') NET.pushStateSoon();
  }

  // Экран онлайн-клиента: всё из состояния, никаких локальных вызовов движка
  function renderClient() {
    const S = E.getState();
    renderStrip();
    renderStatement();
    renderCenter();
    renderTokens();
    renderLogFromState(S);
    renderPending(S);
    checkOver(S);
  }

  // игрок, чей отчёт показываем: в клиентском режиме — свой
  function viewPlayer(S) {
    return NETMODE === 'client' ? S.players[myId] : S.players[S.cur];
  }

  function renderCenter() {
    const S = E.getState();
    const cur = S.players[S.cur];
    const st = E.stat(cur);
    $('#cur-name').innerHTML = `<span class="avatar" style="background:${cur.color}">${cur.name[0].toUpperCase()}</span> ${cur.name}${NETMODE === 'client' && S.cur === myId ? ' <span class="badge">(вы)</span>' : ''}`;
    const btn = $('#btn-roll');
    btn.disabled = S.busy || S.over;
    let hint = cur.fastTrack ? '🏆 Скоростная трасса' : ' Крысиные бега';
    if (cur.downTurns > 0) hint += ' · сокращение: пропустить ' + cur.downTurns;
    else if (cur.charityTurns > 0) hint += ' · ❤️ 2 кубика (' + cur.charityTurns + ')';
    if (NETMODE === 'client') {
      btn.disabled = !(S.cur === myId && !S.busy && !S.over && !S.pending);
      if (S.over) hint = 'Игра окончена';
      else if (S.pending) hint = S.pending.playerId === myId ? '⏳ Ваше решение!' : '⏳ Решает игрок ' + S.players[S.pending.playerId].name + '…';
      else hint = S.cur === myId ? 'Ваш ход — бросайте кубик!' : 'Ход игрока ' + cur.name;
    } else {
      if (S.pending) hint = '⏳ Решает игрок ' + S.players[S.pending.playerId].name + '…';
      else if (S.busy) hint = 'Ход обрабатывается…';
    }
    $('#phase-hint').textContent = hint;

    const fill = $('#progress .pfill');
    const txt = $('#progress-text');
    if (cur.fastTrack) {
      const gained = E.passiveOf(cur) - cur.passiveAtEntry;
      const pct = Math.floor(Math.min(100, gained / 50000 * 100));
      txt.textContent = `До победы доходом: +${fmt(gained)} из ${fmt(50000)} · ${pct}%`;
      fill.style.width = Math.max(2, pct) + '%';
      fill.classList.add('gold');
    } else {
      const pct = Math.floor(Math.min(100, st.passive / Math.max(1, st.expenses) * 100));
      txt.textContent = `Выход из крысиных бегов: ${pct}% · ПД ${fmt(st.passive)} / ${fmt(st.expenses)}`;
      fill.style.width = Math.max(2, pct) + '%';
      fill.classList.remove('gold');
    }
  }

  function renderStrip() {
    const S = E.getState();
    $('#players-strip').innerHTML = S.players.map(p => {
      const st = E.stat(p);
      let badges = '';
      if (p.fastTrack) badges += ' <span class="badge">🏆</span>';
      if (p.bankrupt) badges += ' <span class="badge">💸</span>';
      if (p.downTurns > 0) badges += ` <span class="badge">😴${p.downTurns}</span>`;
      if (p.charityTurns > 0) badges += ` <span class="badge">❤️${p.charityTurns}</span>`;
      const cfCls = st.cashflow >= 0 ? 'pos' : 'neg';
      let bottom, bar;
      if (p.fastTrack) {
        const gained = E.passiveOf(p) - p.passiveAtEntry;
        bottom = `<span class="pprof">🏆 Скоростная трасса · +${fmt(gained)} из ${fmt(50000)}</span>`;
        bar = Math.min(100, gained / 50000 * 100);
      } else {
        bottom = `<span class="pprof">${profName(p.prof)} · ПД <b class="plus">${fmt(st.passive)}</b> / Р ${fmt(st.expenses)}</span>`;
        bar = Math.min(100, st.passive / Math.max(1, st.expenses) * 100);
      }
      return `<div class="pcard ${p.id === S.cur && !S.over ? 'cur' : ''}">
        <div class="prow-top">
          <span class="avatar" style="background:${p.color}">${p.name[0].toUpperCase()}</span>
          <span class="pnm">${p.name}${badges}</span>
          <span class="pnum">${homm() ? 'Казна' : 'Кэш'}: <b>${fmt(p.cash)}</b><br>Поток: <span class="${cfCls}">${fmt(st.cashflow)}</span>/мес</span>
        </div>
        <div class="prow-bottom">
          ${bottom}
          <span class="pbar"><span class="pfill${p.fastTrack ? ' gold' : ''}" style="width:${bar}%"></span></span>
        </div>
      </div>`;
    }).join('');
  }

  function renderStatement() {
    const S = E.getState();
    const p = viewPlayer(S);
    const st = E.stat(p);

    let assetsHtml = '';
    for (const a of p.assets) {
      assetsHtml += `<li><span>${a.title}</span><span class="plus">+${fmt(a.flow)}/мес</span></li>`;
    }
    if (!assetsHtml) assetsHtml = '<li class="empty">активов пока нет — купите первую сделку!</li>';

    let stocksHtml = '';
    for (const s of p.stocks) {
      const price = S.stockPrices[s.ticker] || 0;
      stocksHtml += `<li><span>${s.ticker} × ${s.shares}</span><span>${fmt(price)} · ${fmt(price * s.shares)}</span></li>`;
    }

    let liabsHtml = '';
    for (const l of p.liabs) {
      liabsHtml += `<li><span>${l.name}</span><span>${fmt(l.amount)} <span class="dim">(${fmt(l.payment)}/мес)</span></span></li>`;
    }

    let dreamHtml = '';
    if (p.dreamId) {
      const d = D.dreams.find(x => x.id === p.dreamId);
      dreamHtml = `<div class="sect">🌟 Мечта</div><li><span>${cardE(d)} ${cardT(d)}</span><span>${fmt(d.cost)}</span></li>`;
      if (p.fastTrack) dreamHtml += `<li class="empty">цель: купить мечту или +${fmt(50000)} к пассивному доходу (сейчас +${fmt(E.passiveOf(p) - p.passiveAtEntry)})</li>`;
    }

    const quotes = Object.entries(S.stockPrices).map(([t, v]) => `<span class="q"><b>${t}</b> ${fmt(v)}</span>`).join('');

    $('#statement').innerHTML = `
      <h4><span class="avatar" style="background:${p.color}">${p.name[0].toUpperCase()}</span> ${p.name}${NETMODE === 'client' ? ' <span class="badge">(вы)</span>' : ''} — ${profName(p.prof)}</h4>
      <table>
        <tr><td>${homm() ? 'Жалованье' : 'Зарплата'}</td><td>${fmt(st.salary)}</td></tr>
        <tr><td>Пассивный доход</td><td class="plus">${fmt(st.passive)}</td></tr>
        <tr class="tot"><td>Доходы всего</td><td>${fmt(st.income)}</td></tr>
        <tr><td>Налоги</td><td class="minus">${fmt(p.prof.taxes)}</td></tr>
        <tr><td>Платежи по кредитам</td><td class="minus">${fmt(st.expenses - p.prof.taxes - p.prof.other - p.prof.perChild * st.children)}</td></tr>
        <tr><td>Прочие расходы</td><td class="minus">${fmt(p.prof.other)}</td></tr>
        <tr><td>Дети (${st.children})</td><td class="minus">${fmt(p.prof.perChild * st.children)}</td></tr>
        <tr class="tot"><td>Расходы всего</td><td class="minus">${fmt(st.expenses)}</td></tr>
      </table>
      <div class="cash"><span>${homm() ? '🪙' : '💵'} ${fmt(p.cash)}</span><span class="cf ${st.cashflow >= 0 ? 'pos' : 'neg'}">поток ${fmt(st.cashflow)}/мес</span></div>
      <div class="sect">Активы</div>
      <ul>${assetsHtml}</ul>
      ${stocksHtml ? `<div class="sect">Акции</div><ul>${stocksHtml}</ul>` : ''}
      ${dreamHtml}
      <div class="sect">Обязательства</div>
      <ul>${liabsHtml}</ul>
      <div id="quotes">${quotes}</div>`;
  }

  // ---- кости ----
  const PIPS = { 1: [4], 2: [1, 9], 3: [1, 4, 9], 4: [1, 3, 7, 9], 5: [1, 3, 4, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  function dieFace(v) {
    return `<div class="die">${[1,2,3,4,5,6,7,8,9].map(i => `<span class="pip${PIPS[v].includes(i) ? ' on' : ''}"></span>`).join('')}</div>`;
  }
  function showDiceStatic(dice) {
    $('#dice').innerHTML = dice.map(dieFace).join('');
  }

  function renderLoanbox() {
    const S = E.getState();
    if (NETMODE === 'client') {
      const mine = S.cur === myId;
      const p = S.players[myId];
      const room = E.loanRoom(p);
      const bank = E.bankTotal(p);
      $('#loanbox').innerHTML = mine ? `
        <b>${homm() ? '🏦 Меняла' : '🏦 Банк'}</b> <span class="dim">(кредит под 10%/мес, шаг ${fmt(1000)}; лимит: 10 зарплат)</span>
        <div class="lrow">
          <input id="loan-amt" type="number" min="1000" step="1000" value="1000">
          <button class="btn small" id="loan-take" ${room < 1000 ? 'disabled' : ''}>Взять</button>
          <button class="btn small" id="loan-repay" ${bank < 1000 ? 'disabled' : ''}>Погасить</button>
        </div>
        <div class="dim">Доступно к займу: ${fmt(room)} · Долг: ${fmt(bank)}</div>`
        : `<span class="dim">Меняла принимает ставки в ваш ход.</span>`;
      if (!mine) return;
      $('#loan-take').onclick = () => {
        const n = parseInt($('#loan-amt').value) || 0;
        NET.sendAction({ type: 'loan', take: n }, myId);
      };
      $('#loan-repay').onclick = () => {
        const n = parseInt($('#loan-amt').value) || 0;
        NET.sendAction({ type: 'loan', repay: n }, myId);
      };
      return;
    }
    const p = S.players[S.cur];
    const room = E.loanRoom(p);
    const bank = E.bankTotal(p);
    $('#loanbox').innerHTML = `
      <b>${homm() ? '🏦 Меняла' : '🏦 Банк'}</b> <span class="dim">(кредит под 10%/мес, шаг ${fmt(1000)}; лимит: 10 зарплат)</span>
      <div class="lrow">
        <input id="loan-amt" type="number" min="1000" step="1000" value="1000">
        <button class="btn small" id="loan-take" ${room < 1000 ? 'disabled' : ''}>Взять</button>
        <button class="btn small" id="loan-repay" ${bank < 1000 ? 'disabled' : ''}>Погасить</button>
      </div>
      <div class="dim">Доступно к займу: ${fmt(room)} · Долг: ${fmt(bank)}</div>`;
    $('#loan-take').onclick = () => {
      const n = parseInt($('#loan-amt').value) || 0;
      if (E.takeLoan(p, n)) E.checkEscapeNow();
    };
    $('#loan-repay').onclick = () => {
      const n = parseInt($('#loan-amt').value) || 0;
      if (E.repayLoan(p, n)) E.checkEscapeNow();
    };
  }

  // ================= ЖУРНАЛ =================
  function logLine(msg, cls) {
    // дублируем журнал в состояние — его увидят онлайн-игроки
    const st = E.getState();
    if (st) st.log = (st.log || []).concat([{ m: msg, c: cls || '' }]).slice(-60);
    const box = $('#log');
    const el = document.createElement('div');
    el.className = 'll ' + (cls || '');
    el.innerHTML = msg;
    box.prepend(el);
    while (box.children.length > 120) box.lastChild.remove();
  }

  function renderLogFromState(st) {
    const box = $('#log');
    box.innerHTML = '';
    for (const l of (st.log || []).slice().reverse()) {
      const el = document.createElement('div');
      el.className = 'll ' + (l.c || '');
      el.innerHTML = l.m;
      box.appendChild(el);
    }
  }

  // ================= ЛОКАЛЬНЫЕ ДИАЛОГИ (хот-сейт и хост за себя) =================
  async function localInfo(title, text) {
    await ask(title, `<p>${text.replace(/\n/g, '<br>')}</p>`, [{ label: 'Понятно', value: 1, cls: 'primary' }]);
  }

  async function localConfirm(title, text) {
    return await ask(title, `<p>${text}</p>`, [
      { label: 'Да', value: true, cls: 'primary' },
      { label: 'Нет', value: false },
    ]);
  }

  async function localChooseAsset(p, card, label) {
    const mort = card.cost - card.down;
    return await ask(
      `${label}: «${cardT(card)}»`,
      `<p>${cardD(card)}</p>
       <div class="fin">
         <div><span>Цена</span><span>${fmt(card.cost)}</span></div>
         <div><span>${homm() ? 'Вклад (золотом)' : 'Аванс (наличные)'}</span><span>${fmt(card.down)}</span></div>
         <div><span>${homm() ? 'Долг магистрату' : 'Закладная'}</span><span>${fmt(mort)}</span></div>
         <div><span>Денежный поток</span><span class="plus">+${fmt(card.flow)}/мес</span></div>
       </div>
       <p class="dim">Наличные: ${fmt(p.cash)} · Пассивный доход станет ${fmt(E.passiveOf(p) + card.flow)}/мес</p>`,
      [
        { label: 'Купить', value: true, cls: 'primary', disabled: p.cash < card.down },
        { label: 'Отказаться', value: false },
      ]
    );
  }

  async function localShowDoodad(card) {
    const way = card.way === 'credit' ? 'на кредитку' : card.way === 'car' ? 'в автокредит' : 'наличными';
    const hommWay = card.way === 'credit' ? 'в счёт гильдии' : card.way === 'car' ? 'под рассрочку конюха' : 'золотом';
    await ask('🍩 Дудад!', `<p><b>${cardT(card)}</b> — ${fmt(card.amount)} ${homm() ? hommWay : way}.</p><p>${cardD(card)}</p>`,
      [{ label: 'Ну всё…', value: 1, cls: 'primary' }]);
  }

  async function localChooseSale(card, matches, p) {
    const buttons = matches.map((a, i) => ({
      label: `Продать «${a.title}»\nза ${fmt(card.price)} (чистыми ${fmt(card.price - a.mortgage)})`,
      value: i, cls: 'primary',
    }));
    buttons.push({ label: 'Не продавать', value: -1 });
    return await ask(
      `📊 Рынок: «${cardT(card)}»`,
      `<p>${cardD(card)}</p><p class="dim">Выберите актив для продажи или откажитесь.</p>`,
      buttons
    );
  }

  function localStockTrade(p, ticker, price, name) {
    return new Promise(res => {
      const drawModal = (err) => {
        const held = E.sharesOf(p, ticker);
        const maxBuy = Math.floor(p.cash / price);
        openModal(`
          <h3>📈 ${name || ticker}</h3>
          <div class="modal-body">
            <p>Цена: <b>${fmt(price)}</b> · Наличные: <b>${fmt(p.cash)}</b> · В портфеле: <b>${held} акц.</b></p>
            <p class="dim">Ход торговли: <b style="color:${p.color}">${p.name}</b></p>
            <label>Сколько акций: <input id="st-n" type="number" min="1" step="1" value="1"></label>
            <div class="err">${err || ''}</div>
          </div>
          <div class="modal-btns">
            <button class="btn primary" id="st-buy" ${maxBuy < 1 ? 'disabled' : ''}>Купить</button>
            <button class="btn" id="st-sell" ${held < 1 ? 'disabled' : ''}>Продать</button>
            <button class="btn" id="st-done">Готово</button>
          </div>`);
        $('#st-buy').onclick = () => {
          const n = parseInt($('#st-n').value) || 0;
          if (n < 1) return drawModal('Введите количество');
          if (n * price > p.cash) return drawModal('Недостаточно денег');
          E.trade(p, ticker, n, price, true);
          drawModal();
        };
        $('#st-sell').onclick = () => {
          const n = parseInt($('#st-n').value) || 0;
          if (n < 1) return drawModal('Введите количество');
          if (n > E.sharesOf(p, ticker)) return drawModal('Столько акций нет');
          E.trade(p, ticker, n, price, false);
          drawModal();
        };
        $('#st-done').onclick = () => { closeModal(); res(); };
      };
      drawModal();
    });
  }

  function localChooseDream(dreams, p) {
    return new Promise(res => {
      openModal(`
        <h3>🏆 Выход из крысиных бегов!</h3>
        <div class="modal-body">
          <p><b style="color:${p.color}">${p.name}</b>, выберите мечту — её нужно будет купить на скоростной трассе:</p>
          <div class="dreams">
            ${dreams.map(d => `<button class="btn" data-d="${d.id}">${cardE(d)} ${cardT(d)}<small>${fmt(d.cost)}</small></button>`).join('')}
          </div>
        </div>`);
      document.querySelectorAll('#modal-root [data-d]').forEach(btn => {
        btn.onclick = () => {
          closeModal();
          res(dreams.find(d => d.id === btn.dataset.d));
        };
      });
    });
  }

  async function localChooseFtBusiness(card, p) {
    return await ask(
      `🏢 Бизнес-возможность: «${cardT(card)}»`,
      `<p>${cardD(card)}</p>
       <div class="fin">
         <div><span>Вложения (наличные)</span><span>${fmt(card.cost)}</span></div>
         <div><span>Денежный поток</span><span class="plus">+${fmt(card.flow)}/мес</span></div>
       </div>
       <p class="dim">Наличные: ${fmt(p.cash)}</p>`,
      [
        { label: 'Вложить', value: true, cls: 'primary', disabled: p.cash < card.cost },
        { label: 'Отказаться', value: false },
      ]
    );
  }

  async function localConfirmBuyDream(dream, p) {
    return await ask(
      `🌟 Мечта: ${cardE(dream)} ${cardT(dream)}`,
      `<p>${p.name}, денег хватает! Купить мечту за <b>${fmt(dream.cost)}</b> и победить?</p>`,
      [
        { label: 'Купить мечту!', value: true, cls: 'primary' },
        { label: 'Пока подожду', value: false },
      ]
    );
  }

  function localGameOver(p, reason) {
    openModal(`
      <h3>🏆 Победа!</h3>
      <div class="modal-body" style="text-align:center">
        <p style="font-size:64px; line-height:1; filter:drop-shadow(0 6px 14px rgba(245,197,66,.45))">🎉</p>
        <p style="font-size:19px; margin-top:12px"><span class="avatar" style="background:${p.color};width:30px;height:30px;font-size:14px">${p.name[0].toUpperCase()}</span> <b style="color:${p.color}">${p.name}</b> ${reason}!</p>
        <p class="dim" style="margin-top:8px">Пассивный доход: <b style="color:var(--green)">${fmt(E.passiveOf(p))}</b>/мес · Наличные: <b style="color:var(--gold)">${fmt(p.cash)}</b></p>
        <p class="dim" style="margin-top:6px">Вот так выходят из крысиных бегов. 💪</p>
      </div>
      <div class="modal-btns"><button class="btn primary big" onclick="location.reload()">🔄 Новая игра</button></div>`);
  }

  // ================= ХУКИ ДЛЯ ДВИЖКА =================
  const H = {
    sleep,
    log: logLine,
    render: renderAll,
    renderTokens,
    profName,
    cardT,
    cardD,

    async setDice(dice) {
      const st = E.getState();
      if (st) st.lastDice = dice.slice();
      const el = $('#dice');
      el.classList.add('rolling');
      for (let i = 0; i < 7; i++) {
        el.innerHTML = dice.map(() => dieFace(1 + Math.floor(Math.random() * 6))).join('');
        await sleep(50);
      }
      el.classList.remove('rolling');
      el.innerHTML = dice.map(dieFace).join('');
    },

    async info(title, text) {
      // удалённым игрокам достаточно журнала — не блокируем ход
      if (NETMODE === 'host' && E.cur() && E.cur().id !== 0) return;
      return localInfo(title, text);
    },

    async confirm(title, text) {
      if (NETMODE === 'host' && E.cur() && E.cur().id !== 0) {
        const v = await NET.decide(E.cur().id, 'confirm', { title, text });
        return !!v.yes;
      }
      return localConfirm(title, text);
    },

    async chooseAssetCard(p, card, label) {
      if (NETMODE === 'host' && p.id !== 0) {
        const v = await NET.decide(p.id, 'asset', { card, label });
        return !!v.buy;
      }
      return localChooseAsset(p, card, label);
    },

    async showDoodad(card) {
      if (NETMODE === 'host' && E.cur() && E.cur().id !== 0) return;
      return localShowDoodad(card);
    },

    async chooseSale(card, matches, p) {
      if (NETMODE === 'host' && p.id !== 0) {
        const v = await NET.decide(p.id, 'sale', { card, matches, price: card.price });
        return (v.index >= 0) ? v.index : -1;
      }
      return localChooseSale(card, matches, p);
    },

    stockTrade(p, ticker, price, name) {
      if (NETMODE === 'host' && p.id !== 0) {
        // цикл: клиент шлёт buy/sell, пока не нажмёт «Готово»
        return (async () => {
          for (;;) {
            const res = await NET.decide(p.id, 'stock', { ticker, price, name, held: E.sharesOf(p, ticker), cash: p.cash });
            if (res.done || res.timeout) return;
            if (res.buy) E.trade(p, ticker, res.buy, price, true);
            else if (res.sell) E.trade(p, ticker, res.sell, price, false);
          }
        })();
      }
      return localStockTrade(p, ticker, price, name);
    },

    async chooseDream(dreams, p) {
      if (NETMODE === 'host' && p.id !== 0) {
        const v = await NET.decide(p.id, 'dream', { dreams });
        return D.dreams.find(d => d.id === v.dreamId) || dreams[0];
      }
      return localChooseDream(dreams, p);
    },

    async chooseFtBusiness(card, p) {
      if (NETMODE === 'host' && p.id !== 0) {
        const v = await NET.decide(p.id, 'ftbiz', { card });
        return !!v.buy;
      }
      return localChooseFtBusiness(card, p);
    },

    async confirmBuyDream(dream, p) {
      if (NETMODE === 'host' && p.id !== 0) {
        const v = await NET.decide(p.id, 'buydream', { dream });
        return !!v.yes;
      }
      return localConfirmBuyDream(dream, p);
    },

    async gameOver(p, reason) {
      const st = E.getState();
      if (st) { st.winText = reason; st.overAt = Date.now(); }
      if (NETMODE === 'host') NET.pushStateSoon();
      localGameOver(p, reason);
    },
  };

  // ================= ТЕМЫ =================
  const THEME_KEY = 'cf-theme';

  function applyTheme(t) {
    const theme = t === 'homm' ? 'homm' : 'classic';
    document.body.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* приватный режим */ }
    document.querySelectorAll('.theme-opt').forEach(el => el.classList.toggle('sel', el.dataset.t === theme));
    D.colors = theme === 'homm' ? D.colorsHomm : D.colorsClassic;
    E.setCurrency(theme);
    if (!$('#setup').classList.contains('hidden')) buildRows();
  }

  function initTheme() {
    let saved = 'classic';
    try { saved = localStorage.getItem(THEME_KEY) || 'classic'; } catch (e) { /* приватный режим */ }
    applyTheme(saved);
    document.querySelectorAll('.theme-opt').forEach(el => {
      el.onclick = () => applyTheme(el.dataset.t);
    });
  }

  // ================= ОНЛАЙН-РЕЖИМ =================
  // Ожидающее решение (клиент): модалка для своего pending
  function renderPending(S) {
    const pd = S.pending;
    if (!pd) {
      if (pendingOpen) { closeModal(); pendingOpen = false; lastPendingKey = ''; }
      return;
    }
    const key = pd.seq + '/' + (pd.rev || 0);
    if (key === lastPendingKey) return;
    lastPendingKey = key;
    if (pd.playerId !== myId) return; // чужое решение — просто смотрим подсказку в центре
    pendingOpen = true;
    buildPendingModal(pd);
  }

  function buildPendingModal(pd) {
    const S = E.getState();
    const me = S.players[myId];
    const send = value => NET.sendAction({ seq: pd.seq, value }, myId);
    const pay = pd.payload;

    if (pd.kind === 'asset') {
      const card = pay.card, mort = card.cost - card.down;
      openModal(`
        <h3>${pay.label}: «${cardT(card)}»</h3>
        <div class="modal-body">
          <p>${cardD(card)}</p>
          <div class="fin">
            <div><span>Цена</span><span>${fmt(card.cost)}</span></div>
            <div><span>${homm() ? 'Вклад (золотом)' : 'Аванс (наличные)'}</span><span>${fmt(card.down)}</span></div>
            <div><span>${homm() ? 'Долг магистрату' : 'Закладная'}</span><span>${fmt(mort)}</span></div>
            <div><span>Денежный поток</span><span class="plus">+${fmt(card.flow)}/мес</span></div>
          </div>
          <p class="dim">Наличные: ${fmt(me.cash)}</p>
        </div>
        <div class="modal-btns">
          <button class="btn primary" id="pd-buy" ${me.cash < card.down ? 'disabled' : ''}>Купить</button>
          <button class="btn" id="pd-skip">Отказаться</button>
        </div>`);
      $('#pd-buy').onclick = () => { send({ buy: true }); pendingOpen = false; closeModal(); };
      $('#pd-skip').onclick = () => { send({ buy: false }); pendingOpen = false; closeModal(); };
      return;
    }

    if (pd.kind === 'confirm') {
      openModal(`
        <h3>${pd.payload.title}</h3>
        <div class="modal-body"><p>${pd.payload.text}</p></div>
        <div class="modal-btns">
          <button class="btn primary" id="pd-yes">Да</button>
          <button class="btn" id="pd-no">Нет</button>
        </div>`);
      $('#pd-yes').onclick = () => { send({ yes: true }); pendingOpen = false; closeModal(); };
      $('#pd-no').onclick = () => { send({ yes: false }); pendingOpen = false; closeModal(); };
      return;
    }

    if (pd.kind === 'sale') {
      const card = pd.payload.card;
      const matches = S.players[myId].assets.filter(a => a.tag === card.tag);
      const buttons = matches.map((a, i) =>
        `<button class="btn primary" data-i="${i}">Продать «${a.title}» за ${fmt(pd.payload.price)} (чистыми ${fmt(pd.payload.price - a.mortgage)})</button>`).join('');
      openModal(`
        <h3>📊 Рынок: «${cardT(card)}»</h3>
        <div class="modal-body">
          <p>${cardD(card)}</p>
          <div class="modal-btns" style="flex-direction:column">
            ${buttons}
            <button class="btn" id="pd-nope">Не продавать</button>
          </div>
        </div>`);
      document.querySelectorAll('#modal-root [data-i]').forEach(b => {
        b.onclick = () => { send({ index: parseInt(b.dataset.i) }); pendingOpen = false; closeModal(); };
      });
      $('#pd-nope').onclick = () => { send({ index: -1 }); pendingOpen = false; closeModal(); };
      return;
    }

    if (pd.kind === 'stock') {
      const maxBuy = Math.floor(me.cash / pd.payload.price);
      openModal(`
        <h3>📈 ${pd.payload.name || pd.payload.ticker}</h3>
        <div class="modal-body">
          <p>Цена: <b>${fmt(pd.payload.price)}</b> · Наличные: <b>${fmt(me.cash)}</b> · В портфеле: <b>${E.sharesOf(me, pd.payload.ticker)} акц.</b></p>
          <label>Сколько акций: <input id="pd-st-n" type="number" min="1" step="1" value="1"></label>
          <div class="err"></div>
        </div>
        <div class="modal-btns">
          <button class="btn primary" id="pd-st-buy" ${maxBuy < 1 ? 'disabled' : ''}>Купить</button>
          <button class="btn" id="pd-st-sell" ${E.sharesOf(me, pd.payload.ticker) < 1 ? 'disabled' : ''}>Продать</button>
          <button class="btn" id="pd-st-done">Готово</button>
        </div>`);
      $('#pd-st-buy').onclick = () => {
        const n = parseInt($('#pd-st-n').value) || 0;
        if (n >= 1 && n * pd.payload.price <= me.cash) { send({ buy: n }); pendingOpen = false; closeModal(); }
      };
      $('#pd-st-sell').onclick = () => {
        const n = parseInt($('#pd-st-n').value) || 0;
        if (n >= 1) { send({ sell: n }); pendingOpen = false; closeModal(); }
      };
      $('#pd-st-done').onclick = () => { send({ done: true }); pendingOpen = false; closeModal(); };
      return;
    }

    if (pd.kind === 'dream') {
      openModal(`
        <h3>🏆 Выход из крысиных бегов!</h3>
        <div class="modal-body">
          <p><b style="color:${me.color}">${me.name}</b>, выберите мечту — её нужно будет купить на скоростной трассе:</p>
          <div class="dreams">
            ${pd.payload.dreams.map(d => `<button class="btn" data-d="${d.id}">${cardE(d)} ${cardT(d)}<small>${fmt(d.cost)}</small></button>`).join('')}
          </div>
        </div>`);
      document.querySelectorAll('#modal-root [data-d]').forEach(b => {
        b.onclick = () => { send({ dreamId: b.dataset.d }); pendingOpen = false; closeModal(); };
      });
      return;
    }

    if (pd.kind === 'ftbiz') {
      const card = pd.payload.card;
      openModal(`
        <h3>🏢 Владение: «${cardT(card)}»</h3>
        <div class="modal-body">
          <p>${cardD(card)}</p>
          <div class="fin">
            <div><span>Вложения</span><span>${fmt(card.cost)}</span></div>
            <div><span>Денежный поток</span><span class="plus">+${fmt(card.flow)}/мес</span></div>
          </div>
          <p class="dim">Казна: ${fmt(me.cash)}</p>
        </div>
        <div class="modal-btns">
          <button class="btn primary" id="pd-buy" ${me.cash < card.cost ? 'disabled' : ''}>Вложить</button>
          <button class="btn" id="pd-skip">Отказаться</button>
        </div>`);
      $('#pd-buy').onclick = () => { send({ buy: true }); pendingOpen = false; closeModal(); };
      $('#pd-skip').onclick = () => { send({ buy: false }); pendingOpen = false; closeModal(); };
      return;
    }

    if (pd.kind === 'buydream') {
      const dream = pd.payload.dream;
      openModal(`
        <h3>🌟 Мечта: ${cardE(dream)} ${cardT(dream)}</h3>
        <div class="modal-body"><p>${me.name}, казны хватает! Купить мечту за <b>${fmt(dream.cost)}</b> и победить?</p></div>
        <div class="modal-btns">
          <button class="btn primary" id="pd-yes">Купить мечту!</button>
          <button class="btn" id="pd-no">Пока подожду</button>
        </div>`);
      $('#pd-yes').onclick = () => { send({ yes: true }); pendingOpen = false; closeModal(); };
      $('#pd-no').onclick = () => { send({ yes: false }); pendingOpen = false; closeModal(); };
    }
  }

  function checkOver(S) {
    if (S.over && S.overAt && lastOverSeen !== S.overAt) {
      lastOverSeen = S.overAt;
      localGameOver(S.winner, S.winText || 'одержал(а) победу');
    }
  }

  // ---- хост: приём действий от клиентов ----
  function hostOnAction(row) {
    const act = row.action;
    if (act.type === 'join') {
      // net.js уже добавил гостя в лобби и разослал состояние — обновляем список
      renderLobby();
      NET.pushLobby();
      return;
    }
    if (act.seq !== undefined && act.seq !== null) { NET.resolveAction(act); return; }
    if (act.type === 'roll') {
      E.onRoll().then(() => NET.pushStateSoon());
      return;
    }
    if (act.type === 'loan') {
      const p = E.cur();
      if (act.take) E.takeLoan(p, act.take);
      else if (act.repay) E.repayLoan(p, act.repay);
      E.checkEscapeNow().then(() => NET.pushStateSoon());
    }
  }

  // ---- клиент: приём состояния ----
  function clientOnState(st) {
    if (!st) return;
    if (!st.started) { renderClientLobby(st); return; }
    if ($('#game').classList.contains('hidden')) enterClientGame(st);
    E.loadState(st);
    renderAll();
  }

  function enterClientGame(st) {
    myId = Math.max(0, st.playerKeys.indexOf(myKey));
    $('#setup').classList.add('hidden');
    $('#game').classList.remove('hidden');
    buildBoard();
    fitBoard();
    renderAll();
  }

  function renderClientLobby(st) {
    const names = (st.lobby || []).map(j => j.name);
    const me = (st.lobby || []).find(j => j.key === myKey);
    $('#online-status').textContent = me
      ? `Вы в комнате. Игроки: ${names.join(', ') || '—'}. Ждём начала…`
      : 'Подключение к комнате…';
  }

  // ---- лобби хоста ----
  function renderLobby() {
    $('#lobby-code').textContent = NET.code;
    const names = [hostName, ...NET.getLobby().map(j => j.name)];
    $('#lobby-players').innerHTML =
      `<li class="host">👑 ${hostName} (хост)</li>` +
      NET.getLobby().map(j => `<li>🎮 ${j.name}</li>`).join('');
    $('#lobby-hint').textContent = 'Отправьте номер друзьям — они вводят его и своё имя.';
    $('#online-status').textContent = 'Комната готова.';
    $('#btn-start-online').classList.remove('hidden');
  }

  async function startOnlineGame() {
    const joined = NET.getLobby();
    const specs = [{ name: hostName }, ...joined.map(j => ({ name: j.name }))];
    NETMODE = 'host';
    E.setHooks(H);
    E.newGame(specs);
    const st = E.getState();
    st.playerKeys = ['host', ...joined.map(j => j.key)];
    st.started = true;
    $('#setup').classList.add('hidden');
    $('#game').classList.remove('hidden');
    buildBoard();
    fitBoard();
    renderAll();
    NET.pushStateSoon();
  }

  // ================= ЭКРАН НАСТРОЙКИ =================
  function initSetup() {
    initTheme();
    const sel = $('#pcount');
    for (let i = 1; i <= 6; i++) {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = i;
      sel.appendChild(o);
    }
    sel.value = 2;
    sel.onchange = buildRows;
    buildRows();

    $('#btn-start').onclick = () => { NETMODE = null; startGame(); };
    $('#btn-roll').onclick = () => {
      if (NETMODE === 'client') { NET.sendAction({ type: 'roll' }, myId); return; }
      E.onRoll();
    };
    $('#btn-rules').onclick = showRules;
    $('#btn-rules2').onclick = showRules;
    $('#btn-new').onclick = () => location.reload();
    initOnline();
  }

  // ---------- переключение режима ----------
  function setMode(m) {
    $('#mode-local').classList.toggle('sel-mode', m === 'local');
    $('#mode-online').classList.toggle('sel-mode', m === 'online');
    $('#hotseat-form').classList.toggle('hidden', m !== 'local');
    $('#online-form').classList.toggle('hidden', m !== 'online');
  }

  function onlineStatus(msg) { $('#online-status').textContent = msg; }

  function initOnline() {
    $('#mode-local').onclick = () => setMode('local');
    $('#mode-online').onclick = () => setMode('online');

    $('#btn-create-room').onclick = async () => {
      try {
        onlineStatus('Подключение к signalling-серверу…');
        hostName = ($('#host-name').value.trim() || 'Хост').replace(/[<>&"]/g, '');
        NETMODE = 'host';
        NET.onAction(hostOnAction);
        const code = await NET.createRoom();
        $('#online-entry').classList.add('hidden');
        $('#online-lobby').classList.remove('hidden');
        renderLobby();
      } catch (e) {
        NETMODE = null;
        onlineStatus('Ошибка: ' + e.message);
      }
    };

    $('#btn-join-room').onclick = async () => {
      try {
        const code = ($('#join-code').value || '').trim();
        const name = ($('#join-name').value.trim() || 'Гость').replace(/[<>&"]/g, '');
        if (!/^\d{4}$/.test(code)) { onlineStatus('Введите 4-значный номер комнаты'); return; }
        onlineStatus('Подключение…');
        NETMODE = 'client';
        myKey = localStorage.getItem('cf-key-' + code) ||
          (Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem('cf-key-' + code, myKey);
        NET.onState(clientOnState);
        await NET.joinRoom(code, name, myKey);
        $('#online-entry').classList.add('hidden');
        $('#online-lobby').classList.remove('hidden');
        $('#lobby-code').textContent = code;
        $('#lobby-hint').textContent = 'Ждём, пока хост начнёт игру…';
        $('#btn-start-online').classList.add('hidden');
        $('#lobby-players').innerHTML = '<li>Вы вошли как «' + name + '»</li>';
      } catch (e) {
        NETMODE = null;
        onlineStatus('Ошибка: ' + e.message);
      }
    };

    $('#btn-start-online').onclick = () => startOnlineGame();
    $('#btn-rules-online').onclick = showRules;
  }

  function buildRows() {
    const n = parseInt($('#pcount').value);
    const box = $('#player-rows');
    const old = [...box.querySelectorAll('.prow')].map(r => ({
      name: r.querySelector('input').value,
      prof: r.querySelector('select').value,
    }));
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const prev = old[i];
      const row = document.createElement('div');
      row.className = 'prow';
      const opts = D.professions.map(pr => `<option value="${pr.id}" ${prev && prev.prof === pr.id ? 'selected' : ''}>${profName(pr)}</option>`).join('');
      row.innerHTML = `
        <span class="idx" style="background:${D.colors[i]}">${i + 1}</span>
        <div class="pmain">
          <div class="pinputs">
            <input type="text" maxlength="16" placeholder="Игрок ${i + 1}" value="${prev ? prev.name : ''}">
            <select><option value="random">🎲 Случайно</option>${opts}</select>
          </div>
          <div class="prof-info"></div>
        </div>`;
      const sel = row.querySelector('select');
      const info = row.querySelector('.prof-info');
      const upd = () => {
        if (sel.value === 'random') {
          info.innerHTML = document.body.dataset.theme === 'homm'
            ? 'Судьба (и кубик) сами выберут класс героя'
            : 'Профессия выберется случайно при старте';
          return;
        }
        const pr = D.professions.find(x => x.id === sel.value);
        const exp = pr.taxes + pr.homeP + pr.carP + pr.creditP + pr.retailP + pr.other;
        const flow = pr.salary - exp;
        const flavor = document.body.dataset.theme === 'homm' && pr.hommDesc ? `<i>${pr.hommDesc}</i> — ` : '';
        info.innerHTML = `${flavor}${homm() ? 'Жалованье' : 'Зарплата'} <b>${fmt(pr.salary)}</b> · расходы <b>${fmt(exp)}</b> · поток <b style="color:${flow >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(flow)}/мес</b>`;
      };
      sel.addEventListener('change', upd);
      upd();
      box.appendChild(row);
    }
  }

  function startGame() {
    const rows = [...$('#player-rows').querySelectorAll('.prow')];
    const specs = rows.map((r, i) => {
      const name = (r.querySelector('input').value.trim() || ('Игрок ' + (i + 1))).replace(/[<>&"]/g, '');
      let profId = r.querySelector('select').value;
      if (profId === 'random') profId = D.professions[Math.floor(Math.random() * D.professions.length)].id;
      return { name, profId };
    });
    E.setHooks(H);
    E.newGame(specs);
    $('#setup').classList.add('hidden');
    $('#game').classList.remove('hidden');
    buildBoard();
    renderAll();
    fitBoard();
  }

  function showRules() {
    ask('📖 Правила — кратко', `
      <p><b>Крысиные бега.</b> Ходите по кругу, получая зарплату (доход − расходы). Покупайте активы через
      <b>Сделки</b> — они дают пассивный доход. <b>Дудады</b> заставляют тратить, <b>Рынок</b> позволяет
      продать актив, <b>Сокращение</b> выкидывает на 2 хода, <b>Ребёнок</b> увеличивает расходы.</p>
      <p><b>Акции.</b> Когда выпадает карточка акции, цену видят все — каждый игрок может купить или продать
      эти акции по этой цене.</p>
      <p><b>Банк.</b> Кредиты шагом ${fmt(1000)} под 10% в месяц (лимит — 10 зарплат). Гасите их, чтобы снизить расходы.</p>
      <p><b>Цель №1.</b> Пассивный доход ≥ всех расходов — вы выходите из крысиных бегов и выбираете мечту.</p>
      <p><b>Скоростная трасса.</b> Зарплата здесь — ваш пассивный доход. Побеждает тот, кто первым купит
      свою мечту или нарастит пассивный доход ещё на ${fmt(50000)}.</p>
      <p><b>Благотворительность.</b> Заплатите 10% дохода — следующие 3 хода бросайте 2 кубика.</p>
      <p class="dim">Играется за одним устройством по очереди. Это оригинальная веб-адаптация: механика вдохновлена
      классической настольной игрой, тексты карт написаны с нуля.</p>`,
      [{ label: 'Закрыть', value: 1, cls: 'primary' }]);
  }

  // ================= СТАРТ =================
  initSetup();
})();
