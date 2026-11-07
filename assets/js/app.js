// app.js — orquestra dados, motor, top-down, plano de entrada e backtest.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, topDown, VERDICT } from "./engine.js";
import { runBinaryBacktest, evalPayout } from "./backtest.js";

const TIMEFRAMES = ["1m", "5m", "15m"];
const REFRESH_MS = 5000;
const OV_REFRESH_MS = 12000;        // atualiza o ranking do mercado
const NOTIF_THROTTLE = 5 * 60 * 1000; // no máx. 1 alerta por cripto a cada 5 min
const BT_DEPTH = 300; // velas para o backtest
const BT_EVERY_MS = 60000; // recalcula o histórico no máx. a cada 60s
const SYMBOL_LABEL = Object.fromEntries(SYMBOLS.map((s) => [s.v, s.label]));
const DUR = { "1m": 60000, "5m": 300000, "15m": 900000 }; // duração de cada vela

const $ = (s) => document.querySelector(s);
let symbol = localStorage.getItem("sc_symbol") || "BTCUSDT";
let payout = clampPayout(+localStorage.getItem("sc_payout") || 85);
let ovTf = localStorage.getItem("sc_ovtf") || "5m";
let timer = null;
let ovTimer = null;
let lastBtAt = 0;
let btCache = {}; // { tf: {n, winRate} }
let lastDirByTf = {}; // direção atual por tf, para a recomendação
let prevConf = {};    // confluência anterior por cripto (p/ detectar 100%)
let lastNotifAt = {}; // última notificação por cripto
let swReg = null;
const ENTRY_WINDOW_S = 8; // "entrar agora" nos últimos N segundos da vela
let lastDetail = null;    // { byTf, price } do detalhe atual
let liveCandles = {};     // { tf: candles[] } da cripto do detalhe (tempo real)
let ws = null, wsSymbol = null, wsRenderPending = false, wsFails = 0;

function clampPayout(v) { return Math.max(10, Math.min(100, v || 85)); }

const vClass = (v) => (v === VERDICT.BUY ? "buy" : v === VERDICT.SELL ? "sell" : "wait");
const vArrow = (v) => (v === VERDICT.BUY ? "▲" : v === VERDICT.SELL ? "▼" : "■");

function fmtPrice(p) {
  if (p == null) return "—";
  const d = p >= 1000 ? 2 : p >= 1 ? 3 : 6;
  return "$" + p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function buildSymbolSelect() {
  const sel = $("#symbol");
  sel.innerHTML = SYMBOLS.map((s) => `<option value="${s.v}">${s.label}</option>`).join("");
  sel.value = symbol;
  sel.addEventListener("change", () => selectSymbol(sel.value));
}

// Seleciona a cripto do detalhe (pela lista de mercado, pelo seletor ou por link).
function selectSymbol(sym, scroll = false) {
  if (!SYMBOL_LABEL[sym]) return;
  symbol = sym;
  localStorage.setItem("sc_symbol", symbol);
  const sel = $("#symbol");
  if (sel) sel.value = symbol;
  btCache = {};
  lastBtAt = 0;
  liveCandles = {};
  lastDetail = null;
  buildCards();
  run(true);
  if (scroll) $("#topdown")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildCards() {
  $("#cards").innerHTML = TIMEFRAMES.map(
    (tf) => `
    <article class="card wait" id="card-${tf}">
      <div class="tf"><span>${tf} · <span class="clk" data-dur="${DUR[tf]}">—</span></span><span class="price" data-price>—</span></div>
      <div class="verdict wait"><span class="arrow">■</span><span data-verdict>ESPERAR</span></div>
      <div class="votes-line" data-votes>analisando…</div>
      <div class="inds" data-inds></div>
      <div class="bar-block">
        <div class="bar-head"><span class="name">Confluência</span><span class="val" data-conf-val>—</span></div>
        <div class="bar conf"><span class="wait" data-conf-bar></span></div>
      </div>
      <div class="bar-block">
        <div class="bar-head"><span class="name">Volatilidade</span><span class="val" data-risk-val>—</span></div>
        <div class="bar"><span data-risk-bar></span></div>
        <div class="risk-label" data-risk-label></div>
      </div>
      <div class="bt-row" data-bt>histórico: —</div>
    </article>`
  ).join("");
}

function riskColor(r) {
  return r < 35 ? "var(--risk-lo)" : r < 65 ? "var(--risk-mid)" : "var(--risk-hi)";
}

function renderCard(tf, r, bt) {
  const card = $(`#card-${tf}`);
  if (!card) return;
  if (!r || !r.ok) {
    card.querySelector("[data-votes]").textContent = r?.reason || "sem dados";
    return;
  }
  const cls = vClass(r.verdict);
  card.className = `card ${cls}`;
  card.querySelector("[data-price]").textContent = fmtPrice(r.price);
  const vEl = card.querySelector(".verdict");
  vEl.className = `verdict ${cls}`;
  vEl.querySelector(".arrow").textContent = vArrow(r.verdict);
  vEl.querySelector("[data-verdict]").textContent = r.verdict;
  card.querySelector("[data-votes]").textContent = r.resumoVotos;

  const dirArrow = (d) => (d === "alta" ? "▲" : d === "baixa" ? "▼" : "■");
  card.querySelector("[data-inds]").innerHTML = r.votes
    .map((v) => `<div class="ind ${v.dir}" title="${v.detalhe}"><span>${v.nome}</span><i>${dirArrow(v.dir)}</i></div>`)
    .join("");

  card.querySelector("[data-conf-val]").textContent = r.confluence + "%";
  const cb = card.querySelector("[data-conf-bar]");
  cb.className = cls;
  cb.style.width = r.confluence + "%";

  card.querySelector("[data-risk-val]").textContent = r.risk + "%";
  const rb = card.querySelector("[data-risk-bar]");
  rb.style.width = r.risk + "%";
  rb.style.background = riskColor(r.risk);
  card.querySelector("[data-risk-label]").textContent = r.riskLabel;

  const btEl = card.querySelector("[data-bt]");
  if (bt) {
    const ev = evalPayout(bt.winRate, bt.n, payout / 100);
    const margem = (bt.winRate - ev.breakeven) * 100; // acerto − equilíbrio, em pontos %
    const poucos = bt.n < 25;
    const cor = poucos ? "var(--muted)" : margem >= 1.5 ? "var(--buy)" : margem <= -1.5 ? "var(--sell)" : "var(--muted)";
    const sinal = margem >= 0 ? "+" : "−";
    const margLabel = poucos
      ? `<span class="bt-sub">amostra pequena</span>`
      : `margem <b style="color:${cor}">${sinal}${Math.abs(margem).toFixed(0)}%</b>`;
    btEl.innerHTML =
      `expiração ${tf}: <b>${(bt.winRate * 100).toFixed(0)}%</b> de acerto · ` +
      `precisa ${(ev.breakeven * 100).toFixed(0)}% · ` +
      `${margLabel} <span class="bt-sub">(${bt.n} ops)</span>`;
  } else {
    btEl.textContent = "histórico: calculando…";
  }
}

function renderTopDown(price, td) {
  const dsym = $("#detail-sym");
  if (dsym) dsym.textContent = SYMBOL_LABEL[symbol] || symbol;
  $("#td-price").textContent = fmtPrice(price);
  const vEl = $("#td-verdict");
  vEl.className = "td-verdict " + vClass(td.verdict);
  vEl.textContent = (td.verdict === VERDICT.WAIT ? "" : vArrow(td.verdict) + " ") + td.verdict;
  $("#td-text").textContent = td.texto || "";
  renderBinary(td);
}

// Equilíbrio + recomendação honesta a partir do pagamento e do histórico.
function renderBinary(td) {
  const p = payout / 100;
  const breakeven = 1 / (1 + p);
  $("#breakeven").textContent = (breakeven * 100).toFixed(1) + "%";

  const recoEl = $("#reco");
  // Candidatos: tempos cujo acerto medido passa do equilíbrio E a direção
  // atual bate com o veredito top-down.
  let melhor = null;
  if (td && td.verdict !== VERDICT.WAIT) {
    for (const tf of TIMEFRAMES) {
      const bt = btCache[tf];
      if (!bt || bt.n < 25) continue;
      if (lastDirByTf[tf] !== td.verdict) continue;
      const margem = bt.winRate - breakeven;
      if (margem > 0.02 && (!melhor || margem > melhor.margem)) {
        melhor = { tf, winRate: bt.winRate, margem };
      }
    }
  }
  if (melhor) {
    recoEl.textContent = `${td.verdict} · expiração ${melhor.tf} (acerto ${(melhor.winRate * 100).toFixed(0)}%)`;
    recoEl.style.color = "var(--buy)";
  } else if (td && td.verdict === VERDICT.WAIT) {
    recoEl.textContent = "Não operar — sem alinhamento";
    recoEl.style.color = "var(--wait)";
  } else {
    recoEl.textContent = "Não operar — nenhuma expiração passa do equilíbrio";
    recoEl.style.color = "var(--sell)";
  }
}

function setStatus(state, text) {
  $("#status").className = "status" + (state ? " " + state : "");
  $("#status-text").textContent = text;
}

// Calcula o histórico em segundo plano (não trava o render), reusando as
// velas JÁ buscadas. Atualiza só as linhas de margem e a recomendação.
function scheduleBacktest(results, byTf, price) {
  if (Date.now() - lastBtAt < BT_EVERY_MS && Object.keys(btCache).length) return;
  setTimeout(() => {
    try {
      for (const [tf, candles] of results) {
        const b = runBinaryBacktest(candles, { expiryBars: 1, payout: payout / 100 });
        btCache[tf] = { n: b.n, winRate: b.winRate };
        renderCard(tf, byTf[tf], btCache[tf]);
      }
      lastBtAt = Date.now();
      renderTopDown(price, topDown(byTf["15m"], byTf["5m"], byTf["1m"]));
    } catch (_) { /* mantém cache anterior */ }
  }, 0);
}

// Recalcula e redesenha o detalhe a partir das velas em memória (tempo real).
function renderDetailFromLive(realtime) {
  const byTf = {};
  let price = null;
  for (const tf of TIMEFRAMES) {
    const arr = liveCandles[tf];
    if (!arr || !arr.length) continue;
    const r = analyze(arr);
    byTf[tf] = r;
    lastDirByTf[tf] = r.ok ? r.verdict : VERDICT.WAIT;
    if (r.ok) price = r.price;
    renderCard(tf, r, btCache[tf]);
  }
  lastDetail = { byTf, price };
  renderTopDown(price, topDown(byTf["15m"], byTf["5m"], byTf["1m"]));
  tickEntry();
  if (realtime) setStatus("live", `tempo real · ${new Date().toLocaleTimeString("pt-BR")}`);
}

// ---- WebSocket (tempo real) da cripto do detalhe. Falha em silêncio; o
// polling de REFRESH_MS continua como rede de segurança. ----
function closeWS() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
}
function connectWS(sym) {
  if (typeof WebSocket === "undefined") return;
  closeWS();
  wsSymbol = sym;
  const streams = TIMEFRAMES.map((tf) => sym.toLowerCase() + "@kline_" + tf).join("/");
  let sock;
  try { sock = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); }
  catch (_) { return; }
  ws = sock;
  sock.onopen = () => { wsFails = 0; };
  sock.onmessage = (ev) => {
    try {
      const k = JSON.parse(ev.data).data.k;
      const arr = liveCandles[k.i];
      if (!arr || !arr.length) return;
      const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const last = arr[arr.length - 1];
      if (c.t === last.t) arr[arr.length - 1] = c;
      else if (c.t > last.t) { arr.push(c); if (arr.length > BT_DEPTH) arr.shift(); }
      else return;
      scheduleWsRender();
    } catch (_) {}
  };
  sock.onerror = () => { try { sock.close(); } catch (_) {} };
  sock.onclose = () => {
    if (wsSymbol !== sym) return;
    wsFails++;
    // Desiste do tempo real após algumas falhas (ex.: rede bloqueia WS);
    // o polling de REFRESH_MS continua mantendo tudo atualizado.
    if (wsFails <= 3) setTimeout(() => { if (wsSymbol === sym) connectWS(sym); }, 3000);
  };
}
function scheduleWsRender() {
  if (wsRenderPending) return;
  wsRenderPending = true;
  setTimeout(() => { wsRenderPending = false; try { renderDetailFromLive(true); } catch (_) {} }, 250);
}

async function run(reset = false) {
  if (reset) {
    renderTopDown(null, { verdict: VERDICT.WAIT, texto: "carregando…" });
    buildCards();
  }
  try {
    let source = null;
    // Uma busca só por tempo (300 velas), reusada pro ao vivo E pro histórico.
    const results = await Promise.all(
      TIMEFRAMES.map(async (tf) => {
        const candles = await fetchCandles(symbol, tf, BT_DEPTH);
        if (candles.source) source = candles.source;
        return [tf, candles];
      })
    );
    const byTf = {};
    let price = null;
    // Render AO VIVO imediato (não espera o backtest).
    for (const [tf, candles] of results) {
      liveCandles[tf] = candles; // semeia o tempo real
      const r = analyze(candles);
      byTf[tf] = r;
      lastDirByTf[tf] = r.ok ? r.verdict : VERDICT.WAIT;
      if (r.ok) price = r.price;
      renderCard(tf, r, btCache[tf]);
    }
    lastDetail = { byTf, price };
    renderTopDown(price, topDown(byTf["15m"], byTf["5m"], byTf["1m"]));
    tickEntry();
    setStatus("live", `${source || "ao vivo"} · ${new Date().toLocaleTimeString("pt-BR")}`);

    // Conecta o tempo real (se ainda não for desta cripto).
    if (wsSymbol !== symbol) { wsFails = 0; connectWS(symbol); }

    // Histórico depois, em segundo plano.
    scheduleBacktest(results, byTf, price);
  } catch (err) {
    const msg = err?.message || "falha desconhecida";
    const dica = /failed to fetch|load failed|networkerror/i.test(msg)
      ? "rede ou ambiente bloqueando o acesso"
      : msg;
    setStatus("err", "sem dados: " + dica);
    $("#td-text").textContent = "Nenhuma corretora respondeu (" + msg + "). Tentando de novo…";
    console.error(err);
  }
}

function bindPayout() {
  const inp = $("#payout");
  inp.value = payout;
  inp.addEventListener("change", () => {
    payout = clampPayout(+inp.value);
    inp.value = payout;
    localStorage.setItem("sc_payout", payout);
    run(); // acerto não muda com o payout; só a avaliação/recomendação
  });
  inp.addEventListener("input", () => {
    $("#breakeven").textContent = (100 / (1 + clampPayout(+inp.value) / 100)).toFixed(1) + "%";
  });
}

// ---- Visão geral: todas as criptos por confluência e volatilidade ----
function bindOvTf() {
  const box = $("#ovtf");
  if (!box) return;
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tf === ovTf);
    b.addEventListener("click", () => {
      ovTf = b.dataset.tf;
      localStorage.setItem("sc_ovtf", ovTf);
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.tf === ovTf));
      runOverview();
    });
  });
}

async function runOverview() {
  try {
    const list = await Promise.all(
      SYMBOLS.map(async (s) => {
        try {
          const candles = await fetchCandles(s.v, ovTf, 150);
          const r = analyze(candles);
          return { v: s.v, label: s.label, ok: r.ok, verdict: r.verdict, confluence: r.confluence, risk: r.risk };
        } catch {
          return { v: s.v, label: s.label, ok: false };
        }
      })
    );
    const ok = list.filter((x) => x.ok);
    ok.sort((a, b) => b.confluence - a.confluence || b.risk - a.risk);
    renderOverview(ok);
    checkNotifications(ok);
  } catch (_) { /* ignora este ciclo */ }
}

function renderOverview(list) {
  const box = $("#ovlist");
  if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="ovempty">sem dados do mercado</div>`; return; }
  box.innerHTML = list
    .map((x) => {
      const cls = vClass(x.verdict);
      const hot = x.confluence >= 100 ? " hot" : "";
      const sel = x.v === symbol ? " sel" : "";
      return `<button type="button" class="ovrow ${cls}${hot}${sel}" data-sym="${x.v}">
        <span class="ovsym">${x.label}</span>
        <span class="ovdir ${cls}">${vArrow(x.verdict)} ${x.verdict}</span>
        <span class="ovm">conf <b>${x.confluence}%</b></span>
        <span class="ovm">vol <b>${x.risk}%</b></span>
      </button>`;
    })
    .join("");
  box.querySelectorAll(".ovrow").forEach((b) =>
    b.addEventListener("click", () => selectSymbol(b.dataset.sym, true))
  );
}

// ---- Notificações (100% de confluência) ----
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").then((reg) => { swReg = reg; }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "select" && e.data.sym) selectSymbol(e.data.sym, true);
  });
}

function alertsOn() {
  return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("sc_alerts") === "1";
}

function updateAlertsBtn() {
  const btn = $("#alerts");
  if (!btn) return;
  const on = alertsOn();
  btn.classList.toggle("on", on);
  btn.textContent = on ? "🔔 Alertas ativos" : "🔔 Ativar alertas";
}

function bindAlerts() {
  const btn = $("#alerts");
  if (!btn) return;
  if (typeof Notification === "undefined") { btn.disabled = true; btn.textContent = "🔔 Sem suporte"; return; }
  btn.addEventListener("click", async () => {
    if (alertsOn()) { localStorage.setItem("sc_alerts", "0"); updateAlertsBtn(); return; }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem("sc_alerts", "1");
      fireNotif("Alertas ativados", "Você será avisado quando uma cripto atingir 100% de confluência.", null);
    }
    updateAlertsBtn();
  });
  updateAlertsBtn();
}

function fireNotif(title, body, sym) {
  try {
    const opts = { body, tag: sym || "sc", renotify: true, data: { sym } };
    if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
    else if (typeof Notification !== "undefined") new Notification(title, opts);
  } catch (_) {}
}

function checkNotifications(list) {
  const now = Date.now();
  for (const x of list) {
    const was = prevConf[x.v] || 0;
    prevConf[x.v] = x.confluence;
    if (!alertsOn()) continue;
    if (x.confluence >= 100 && was < 100 && now - (lastNotifAt[x.v] || 0) > NOTIF_THROTTLE) {
      lastNotifAt[x.v] = now;
      fireNotif(`${x.label} · 100% de confluência`, `${x.verdict} no ${ovTf} — toque para abrir`, x.v);
    }
  }
}

// Contador regressivo até a vela fechar (local, 1x por segundo, sem rede).
// As velas da Binance são alinhadas ao relógio UTC, então o tempo restante é
// a duração menos o quanto já passou no período atual.
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

function tickClocks() {
  const now = Date.now();
  document.querySelectorAll(".clk[data-dur]").forEach((el) => {
    const d = +el.dataset.dur;
    const rem = d - (now % d);
    el.textContent = "fecha " + fmtCountdown(rem);
    el.classList.toggle("soon", rem <= 10000);
  });
  const ov = $("[data-ovclock]");
  if (ov) {
    const d = DUR[ovTf] || 300000;
    const rem = d - (now % d);
    ov.textContent = "vela fecha em " + fmtCountdown(rem);
    ov.classList.toggle("soon", rem <= 10000);
  }
  tickEntry();
}

// Aviso grande da hora certa de entrar, para o tempo escolhido (ovTf).
function tickEntry() {
  const el = $("#entry");
  if (!el) return;
  const main = $("#entry-main");
  const sub = $("#entry-sub");
  const dur = DUR[ovTf] || 300000;
  const rem = dur - (Date.now() % dur);
  const remTxt = fmtCountdown(rem);
  const r = lastDetail && lastDetail.byTf ? lastDetail.byTf[ovTf] : null;
  const lbl = SYMBOL_LABEL[symbol] || symbol;

  if (!r || !r.ok) {
    el.className = "entry wait";
    main.textContent = "AGUARDE";
    sub.textContent = `carregando ${lbl}…`;
    return;
  }
  const strong = r.confluence >= 75 && r.verdict !== VERDICT.WAIT;
  const cls = r.verdict === VERDICT.BUY ? "buy" : r.verdict === VERDICT.SELL ? "sell" : "wait";
  if (!strong) {
    el.className = "entry wait";
    main.textContent = "AGUARDE";
    sub.textContent = `${lbl} · ${ovTf} · sinal fraco — vela fecha em ${remTxt}`;
  } else if (rem <= ENTRY_WINDOW_S * 1000) {
    el.className = "entry go " + cls;
    main.textContent = `⚡ ENTRAR AGORA · ${r.verdict}`;
    sub.textContent = `${lbl} · ${ovTf} · confluência ${r.confluence}% · fecha em ${remTxt}`;
  } else {
    el.className = "entry ready " + cls;
    main.textContent = `PREPARAR · ${r.verdict}`;
    sub.textContent = `${lbl} · ${ovTf} · entre faltando ${ENTRY_WINDOW_S}s — fecha em ${remTxt}`;
  }
}

function start() {
  const urlSym = new URLSearchParams(location.search).get("sym");
  if (urlSym && SYMBOL_LABEL[urlSym]) symbol = urlSym;
  buildSymbolSelect();
  bindPayout();
  bindOvTf();
  bindAlerts();
  registerSW();
  buildCards();
  run(true);
  runOverview();
  tickClocks();
  clearInterval(timer); timer = setInterval(run, REFRESH_MS);
  clearInterval(ovTimer); ovTimer = setInterval(runOverview, OV_REFRESH_MS);
  setInterval(tickClocks, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(timer); clearInterval(ovTimer); closeWS(); wsSymbol = null; }
    else {
      run(); runOverview();
      timer = setInterval(run, REFRESH_MS);
      ovTimer = setInterval(runOverview, OV_REFRESH_MS);
    }
  });
}

start();
