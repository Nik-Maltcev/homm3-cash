/* Движок игры «Денежный поток». Содержит только правила и состояние —
   ни одного обращения к DOM. UI передаёт хуки через setHooks():
   render, renderTokens, log, sleep, setDice, info, confirm, chooseAssetCard,
   showDoodad, chooseSale, stockTrade, chooseDream, chooseFtBusiness,
   confirmBuyDream, gameOver.
   Такая изоляция позволит на втором этапе вынести движок на сервер
   (Node.js + WebSocket) для онлайн-мультиплеера. */
window.CF_ENGINE = (function () {
  const D = window.CF_DATA;

  let S = null;    // состояние игры
  let H = null;    // хуки UI
  const decks = {};

  // ---------- утилиты ----------
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function draw(name) {
    if (!decks[name] || !decks[name].length) decks[name] = shuffle(D[name].slice());
    return decks[name].pop();
  }
  function die() { return 1 + Math.floor(Math.random() * 6); }
  // Валюта зависит от темы: классика — доллары, HoMM — золото
  let currency = 'classic';
  function setCurrency(mode) { currency = mode === 'homm' ? 'homm' : 'classic'; }
  function fmt(n) {
    const v = Math.round(n);
    const num = Math.abs(v).toLocaleString('ru-RU');
    if (currency === 'homm') return (v < 0 ? '-' : '') + num + ' зол';
    return (v < 0 ? '-$' : '$') + num;
  }
  // Тематические заголовок/описание карты (в HoMM-режиме — средневековые)
  const ct = c => H.cardT ? H.cardT(c) : (c.title || c.name);
  const cd = c => H.cardD ? H.cardD(c) : c.desc;

  // ---------- характеристики игрока ----------
  function passiveOf(p) { return p.assets.reduce((s, a) => s + a.flow, 0); }
  function paymentsOf(p) { return p.liabs.reduce((s, l) => s + l.payment, 0); }
  function expensesOf(p) { return p.prof.taxes + paymentsOf(p) + p.prof.other + p.prof.perChild * p.children; }
  function incomeOf(p) { return p.prof.salary + passiveOf(p); }
  function cashflowOf(p) { return incomeOf(p) - expensesOf(p); }
  function bankTotal(p) { return p.liabs.filter(l => l.kind === 'bank').reduce((s, l) => s + l.amount, 0); }
  function loanRoom(p) { return 10 * p.prof.salary - bankTotal(p); }
  function sharesOf(p, t) { const s = p.stocks.find(x => x.ticker === t); return s ? s.shares : 0; }
  function addShares(p, t, n) {
    let s = p.stocks.find(x => x.ticker === t);
    if (!s) { s = { ticker: t, shares: 0 }; p.stocks.push(s); }
    s.shares += n;
  }
  function removeShares(p, t, n) {
    const s = p.stocks.find(x => x.ticker === t);
    if (!s) return;
    s.shares -= n;
    if (s.shares <= 0) p.stocks = p.stocks.filter(x => x !== s);
  }

  function stat(p) {
    return {
      salary: p.prof.salary, passive: passiveOf(p), income: incomeOf(p),
      expenses: expensesOf(p), cashflow: cashflowOf(p),
      bankTotal: bankTotal(p), loanRoom: loanRoom(p),
      children: p.children, charityTurns: p.charityTurns, downTurns: p.downTurns,
    };
  }

  // ---------- создание игры ----------
  function makePlayer(spec, i) {
    const prof = D.professions.find(x => x.id === spec.profId) || D.professions[i % D.professions.length];
    const p = {
      id: i,
      name: spec.name || ('Игрок ' + (i + 1)),
      color: D.colors[i % D.colors.length],
      prof,
      cash: 0,
      pos: 0,
      stocks: [],
      assets: [],
      liabs: [
        { kind: 'home',   name: 'Ипотека за жильё',  amount: prof.homeA,   payment: prof.homeP },
        { kind: 'car',    name: 'Автокредит',        amount: prof.carA,    payment: prof.carP },
        { kind: 'credit', name: 'Кредитная карта',   amount: prof.creditA, payment: prof.creditP },
        { kind: 'retail', name: 'Потребкредиты',     amount: prof.retailA, payment: prof.retailP },
      ],
      children: 0, charityTurns: 0, downTurns: 0,
      fastTrack: false, ftPos: 0, dreamId: null, passiveAtEntry: 0,
      bankrupt: false,
    };
    p.cash = incomeOf(p) - expensesOf(p);
    return p;
  }

  function newGame(specs) {
    for (const k in decks) delete decks[k];
    S = {
      players: specs.map(makePlayer),
      cur: 0,
      busy: false,
      over: false,
      winner: null,
      winReason: null,
      winText: '',
      overAt: 0,
      stockPrices: { MYT4U: 10, ON2U: 10, OK4U: 20, GRO4US: 20 },
      pending: null,       // ожидающее решение игрока (для онлайн-режима)
      pendingSeq: 0,
      log: [],             // журнал дублируется в состоянии — для онлайн-игроков
      lastDice: null,
      started: false,      // выставляется хостом при старте онлайн-игры
      playerKeys: [],
    };
    const first = S.players[0];
    const profTitle = H.profName ? H.profName(first.prof) : first.prof.name;
    H.log(`🎮 Игра началась! Первым ходит ${first.name} (${profTitle}).`);
    return S;
  }

  // ---------- кредиты ----------
  function takeLoanInternal(p, amt) {
    p.liabs.push({ kind: 'bank', name: 'Банковский кредит', amount: amt, payment: Math.round(amt * 0.1) });
    p.cash += amt;
  }
  function takeLoan(p, amt) {
    amt = Math.max(0, Math.floor(amt / 1000) * 1000);
    if (amt <= 0 || amt > loanRoom(p)) return false;
    takeLoanInternal(p, amt);
    H.log(`🏦 ${p.name} берёт кредит ${fmt(amt)} (платёж ${fmt(amt * 0.1)}/мес).`, 'bad');
    H.render();
    return true;
  }
  function repayLoan(p, amt) {
    amt = Math.max(0, Math.floor(amt / 1000) * 1000);
    const can = Math.min(amt, bankTotal(p), p.cash);
    if (can <= 0) return false;
    let left = can;
    for (const l of p.liabs) {
      if (l.kind !== 'bank' || left <= 0) continue;
      const part = Math.min(left, l.amount);
      l.amount -= part;
      left -= part;
    }
    for (const l of p.liabs) if (l.kind === 'bank') l.payment = Math.round(l.amount * 0.1);
    p.liabs = p.liabs.filter(l => l.amount > 0);
    p.cash -= can;
    H.log(`💳 ${p.name} гасит ${fmt(can)} банковских кредитов.`, 'good');
    H.render();
    return true;
  }

  // ---------- платёжеспособность ----------
  function spend(p, amt) { p.cash -= amt; fixSolvency(p); }
  function fixSolvency(p) {
    if (p.cash >= 0 || S.over) return;
    const need = Math.ceil(-p.cash / 1000) * 1000;
    const room = loanRoom(p);
    if (room > 0) {
      const take = Math.min(need, room);
      takeLoanInternal(p, take);
      H.log(`🏦 ${p.name}: экстренный кредит ${fmt(take)}, чтобы покрыть долги.`, 'bad');
    }
    if (p.cash >= 0) return;
    for (const s of p.stocks.slice()) {
      const price = S.stockPrices[s.ticker] || 0;
      if (price > 0 && s.shares > 0) {
        p.cash += s.shares * price;
        H.log(`📉 ${p.name} вынужденно продаёт ${s.shares} акц. ${s.ticker} по ${fmt(price)}.`, 'bad');
      }
    }
    p.stocks = [];
    if (p.cash >= 0) return;
    H.log(`💸 ${p.name} объявляет банкротство: активы и долги обнулены.`, 'bad');
    p.assets = []; p.stocks = []; p.liabs = [];
    p.cash = 0; p.fastTrack = false; p.passiveAtEntry = 0;
    p.bankrupt = true;
  }

  // ---------- ход ----------
  async function onRoll() {
    if (!S || S.busy || S.over) return;
    const p = S.players[S.cur];
    S.busy = true;
    H.render();
    try {
      if (p.downTurns > 0) {
        p.downTurns--;
        H.log(`😴 ${p.name} пропускает ход (сокращение, осталось пропустить: ${p.downTurns}).`, 'bad');
      } else {
        const nDice = p.charityTurns > 0 ? 2 : 1;
        if (p.charityTurns > 0) p.charityTurns--;
        const dice = nDice === 2 ? [die(), die()] : [die()];
        const roll = dice.reduce((a, b) => a + b, 0);
        await H.setDice(dice);
        H.log(`🎲 ${p.name} выбрасывает ${roll}${nDice === 2 ? ` (${dice[0]} + ${dice[1]})` : ''}.`);
        await move(p, roll);
        if (!S.over) await resolveSpace(p);
      }
      if (!S.over) {
        await maybeEscape(p);
        checkIncomeWin(p);
      }
    } finally {
      S.busy = false;
    }
    if (!S.over) nextPlayer();
    H.render();
  }

  function nextPlayer() {
    S.cur = (S.cur + 1) % S.players.length;
  }

  async function move(p, roll) {
    if (p.fastTrack) {
      for (let i = 0; i < roll; i++) {
        p.ftPos = (p.ftPos + 1) % D.ftTrack.length;
        H.renderTokens();
        await H.sleep(150);
        if (D.ftTrack[p.ftPos] === 'payday') { await ftPayday(p); }
        if (S.over) return;
      }
    } else {
      for (let i = 0; i < roll; i++) {
        p.pos = (p.pos + 1) % D.ratTrack.length;
        H.renderTokens();
        await H.sleep(150);
        if (p.pos === 0) await payday(p);
        if (S.over) return;
      }
    }
  }

  async function payday(p) {
    const net = cashflowOf(p);
    p.cash += net;
    if (net >= 0) H.log(`💰 ${p.name} прошёл «Зарплату»: +${fmt(net)}.`, 'good');
    else { H.log(`💰 ${p.name} прошёл «Зарплату»: ${fmt(net)} (расходы больше доходов).`, 'bad'); fixSolvency(p); }
    H.render();
    await H.sleep(200);
  }

  async function ftPayday(p) {
    const net = passiveOf(p);
    p.cash += net;
    H.log(`💰 ${p.name} получает пассивный доход: +${fmt(net)}.`, 'good');
    H.render();
    await H.sleep(200);
  }

  async function resolveSpace(p) {
    const track = p.fastTrack ? D.ftTrack : D.ratTrack;
    const cell = track[p.fastTrack ? p.ftPos : p.pos];
    if (p.fastTrack) {
      if (cell === 'business') await ftBusiness(p);
      else if (cell === 'dream') await ftDream(p);
      else if (cell === 'luck') await ftLuck(p);
      return;
    }
    if (cell === 'small') await dealSpace(p, 'smallDeals', 'Малая сделка');
    else if (cell === 'big') await dealSpace(p, 'bigDeals', 'Большая сделка');
    else if (cell === 'doodad') await doodadSpace(p);
    else if (cell === 'market') await marketSpace(p);
    else if (cell === 'charity') await charitySpace(p);
    else if (cell === 'downsized') await downsizedSpace(p);
    else if (cell === 'baby') await babySpace(p);
  }

  // ---------- сделки ----------
  async function dealSpace(p, deck, label) {
    const card = draw(deck);
    H.log(`${p.name}: ${label} — «${ct(card)}».`, 'deal');
    if (card.type === 'stock') { await stockCard(card); return; }
    if (card.type === 'cash') {
      await H.info(ct(card), cd(card));
      if (card.amount >= 0) { p.cash += card.amount; H.log(`${p.name}: ${card.amount >= 0 ? '+' : ''}${fmt(card.amount)}.`, card.amount >= 0 ? 'good' : 'bad'); }
      else { spend(p, -card.amount); H.log(`${p.name}: ${fmt(card.amount)}.`, 'bad'); }
      H.render();
      return;
    }
    const buy = await H.chooseAssetCard(p, card, label);
    if (buy) {
      p.cash -= card.down;
      p.assets.push({ title: ct(card), tag: card.tag, cost: card.cost, mortgage: card.cost - card.down, flow: card.flow });
      fixSolvency(p);
      H.log(`✅ ${p.name} покупает «${ct(card)}» (аванс ${fmt(card.down)}). Пассивный доход +${fmt(card.flow)}/мес.`, 'good');
      H.render();
    } else {
      H.log(`${p.name} отказывается от «${ct(card)}».`, 'dim');
    }
  }

  async function stockCard(card) {
    S.stockPrices[card.ticker] = card.price;
    H.log(`📈 ${ct(card)}: ${card.ticker} по ${fmt(card.price)}.`, 'deal');
    H.render();
    const order = [...S.players.slice(S.cur), ...S.players.slice(0, S.cur)];
    for (const pl of order) {
      if (pl.bankrupt && !pl.assets.length && !pl.stocks.length) continue;
      await H.stockTrade(pl, card.ticker, card.price, ct(card));
    }
    H.render();
  }

  function trade(p, ticker, n, price, isBuy) {
    n = Math.floor(n);
    if (!n || n <= 0) return false;
    if (isBuy) {
      if (n * price > p.cash) return false;
      p.cash -= n * price;
      addShares(p, ticker, n);
      H.log(`${p.name} покупает ${n} акц. ${ticker} за ${fmt(n * price)}.`);
    } else {
      if (n > sharesOf(p, ticker)) return false;
      removeShares(p, ticker, n);
      p.cash += n * price;
      H.log(`${p.name} продаёт ${n} акц. ${ticker} за ${fmt(n * price)}.`, 'good');
    }
    H.render();
    return true;
  }

  function sellAsset(p, a, price) {
    const net = price - a.mortgage;
    p.assets.splice(p.assets.indexOf(a), 1);
    p.cash += net;
    H.log(`✅ ${p.name} продаёт «${a.title}» за ${fmt(price)} (чистыми ${fmt(net)}).`, 'good');
  }

  async function doodadSpace(p) {
    const card = draw('doodads');
    await H.showDoodad(card);
    if (card.way === 'credit') {
      const l = p.liabs.find(x => x.kind === 'credit');
      l.amount += card.amount;
      l.payment += Math.round(card.amount * 0.05);
      H.log(`🍩 ${p.name}: «${ct(card)}» — ${fmt(card.amount)} на кредитку.`, 'bad');
    } else if (card.way === 'car') {
      const l = p.liabs.find(x => x.kind === 'car');
      l.amount += card.amount;
      l.payment += Math.round(card.amount * 0.03);
      H.log(`🍩 ${p.name}: «${ct(card)}» — автокредит +${fmt(card.amount)}.`, 'bad');
    } else {
      if (p.cash >= card.amount) {
        p.cash -= card.amount;
        H.log(`🍩 ${p.name}: «${ct(card)}» — −${fmt(card.amount)} наличными.`, 'bad');
      } else {
        H.log(`🍩 ${p.name}: на «${ct(card)}» (${fmt(card.amount)}) нет денег — пропуск.`, 'dim');
      }
    }
    H.render();
  }

  async function marketSpace(p) {
    const card = draw('marketCards');
    H.log(`📊 ${p.name}: Рынок — «${ct(card)}».`, 'deal');
    if (card.type === 'stock') { await stockCard(card); return; }
    const matches = p.assets.filter(a => a.tag === card.tag);
    if (!matches.length) {
      H.log(`${p.name}: подходящих активов нет.`, 'dim');
      await H.info(ct(card), `${cd(card)}\n\nУ вас нет актива этого типа — предложение мимо.`);
      return;
    }
    const idx = await H.chooseSale(card, matches, p);
    if (idx >= 0) { sellAsset(p, matches[idx], card.price); H.render(); }
    else H.log(`${p.name} не продаёт.`, 'dim');
  }

  async function charitySpace(p) {
    if (p.charityTurns > 0) { H.log(`${p.name}: благотворительность ещё активна.`, 'dim'); return; }
    const cost = Math.round(incomeOf(p) * 0.1);
    const yes = await H.confirm(
      '❤️ Благотворительность',
      `${p.name}, пожертвовать 10% дохода — ${fmt(cost)}?<br><br>Взамен: следующие 3 хода вы бросаете <b>2 кубика</b>.`
    );
    if (yes) {
      if (p.cash >= cost) {
        spend(p, cost);
        p.charityTurns = 3;
        H.log(`❤️ ${p.name} жертвует ${fmt(cost)}. Теперь бросает 2 кубика (3 хода).`, 'good');
      } else {
        H.log(`${p.name}: не хватает денег на взнос.`, 'bad');
      }
    }
    H.render();
  }

  async function downsizedSpace(p) {
    const exp = expensesOf(p);
    spend(p, exp);
    p.downTurns = 2;
    H.log(`😴 ${p.name} СОКРАЩЁН! Платит все расходы (${fmt(exp)}) и пропускает 2 хода.`, 'bad');
    H.render();
    await H.info('Сокращение!', `${p.name} теряет работу на два хода и платит полный комплект расходов: ${fmt(exp)}.<br><br>Так бывает, когда живёшь на одну зарплату.`);
  }

  async function babySpace(p) {
    if (p.children < 3) {
      p.children++;
      H.log(`👶 ${p.name}: родился ребёнок! Расходы +${fmt(p.prof.perChild)}/мес.`, 'bad');
      await H.info('Поздравляем!', `${p.name} стал(а) родителем. Счастье бесценно, но расходы выросли на ${fmt(p.prof.perChild)}/мес.`);
    } else {
      H.log(`${p.name}: детей уже трое — больше не будет.`, 'dim');
    }
    H.render();
  }

  // ---------- скоростная трасса ----------
  async function ftBusiness(p) {
    const card = draw('ftBusiness');
    const yes = await H.chooseFtBusiness(card, p);
    if (yes) {
      p.cash -= card.cost;
      p.assets.push({ title: ct(card), tag: 'ft', cost: card.cost, mortgage: 0, flow: card.flow, ft: true });
      H.log(`🏢 ${p.name} покупает «${ct(card)}»: +${fmt(card.flow)}/мес.`, 'good');
      H.render();
      checkIncomeWin(p);
    } else {
      H.log(`${p.name} отказывается от «${ct(card)}».`, 'dim');
    }
  }

  async function ftDream(p) {
    const dream = D.dreams.find(d => d.id === p.dreamId);
    if (!dream) return;
    if (p.cash >= dream.cost) {
      const yes = await H.confirmBuyDream(dream, p);
      if (yes) {
        S.over = true;
        S.winner = p;
        S.winReason = 'dream';
        H.log(`🌟 ${p.name} покупает мечту «${ct(dream)}» и ПОБЕЖДАЕТ!`, 'win');
        H.render();
        await H.gameOver(p, `купил(а) мечту «${ct(dream)}» за ${fmt(dream.cost)}`);
      }
    } else {
      await H.info('Мечта близко!', `«${ct(dream)}» стоит ${fmt(dream.cost)}.<br>У ${p.name} наличными: ${fmt(p.cash)}.<br><br>Нужен ещё ${fmt(dream.cost - p.cash)} — копите или наращивайте доход.`);
    }
  }

  async function ftLuck(p) {
    const e = D.luck[Math.floor(Math.random() * D.luck.length)];
    await H.info('🎲 Удача!', `${ct(e)}.<br><br>${e.amount >= 0 ? 'Получите' : 'Заплатите'} <b>${fmt(Math.abs(e.amount))}</b>.`);
    if (e.amount >= 0) { p.cash += e.amount; H.log(`${p.name}: ${ct(e)} (+${fmt(e.amount)}).`, 'good'); }
    else { spend(p, -e.amount); H.log(`${p.name}: ${ct(e)} (${fmt(e.amount)}).`, 'bad'); }
    H.render();
  }

  // ---------- победа ----------
  async function maybeEscape(p) {
    if (!p || p.fastTrack) return;
    if (passiveOf(p) >= expensesOf(p) && passiveOf(p) > 0) {
      H.log(`🏆 ${p.name} ВЫХОДИТ ИЗ КРЫСИНЫХ БЕГОВ! Пассивный доход ${fmt(passiveOf(p))} ≥ расходы ${fmt(expensesOf(p))}.`, 'win');
      const dream = await H.chooseDream(D.dreams, p);
      p.dreamId = dream.id;
      p.fastTrack = true;
      p.ftPos = 0;
      p.passiveAtEntry = passiveOf(p);
      H.log(`${p.name} выбирает мечту: «${ct(dream)}» (${fmt(dream.cost)}). Цель — купить её или нарастить пассивный доход ещё на ${fmt(50000)}.`, 'win');
      H.render();
      await H.info('Скоростная трасса!', `${p.name} вырвался(ась) из крысиных бегов! 🏆<br><br>Теперь жалованье — это ваш пассивный доход (${fmt(passiveOf(p))}/мес). Побеждает тот, кто первым купит свою мечту или нарастит пассивный доход ещё на ${fmt(50000)}.`);
    }
  }

  function checkIncomeWin(p) {
    if (S.over || !p.fastTrack) return;
    if (passiveOf(p) - p.passiveAtEntry >= 50000) {
      S.over = true;
      S.winner = p;
      S.winReason = 'income';
      H.log(`🏆 ${p.name} нарастил(а) пассивный доход на ${fmt(50000)} и ПОБЕЖДАЕТ!`, 'win');
      H.gameOver(p, 'нарастил(а) пассивный доход на ' + fmt(50000));
    }
  }

  // Проверка выхода из крысиных бегов вне хода (например, после погашения кредитов)
  async function checkEscapeNow() {
    if (!S || S.over || S.busy) return;
    const p = S.players[S.cur];
    await maybeEscape(p);
    H.render();
  }

  return {
    setHooks(hooks) { H = hooks; },
    setCurrency,
    newGame,
    loadState(st) { S = st; return S; },
    onRoll,
    takeLoan,
    repayLoan,
    trade,
    stat,
    fmt,
    sharesOf,
    checkEscapeNow,
    getState: () => S,
    cur: () => S ? S.players[S.cur] : null,
    passiveOf, expensesOf, incomeOf, cashflowOf, loanRoom, bankTotal,
  };
})();
