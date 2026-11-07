// app.js — Lista inteligente: para cada cripto, a ação do momento + checklist
// em mini-barras. Tempo real (WebSocket) com fallback de polling. Apoio à
// decisão; o usuário confere e opera.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, VERDICT } from "./engine.js";
import { runBinaryBacktest, evalPayout } from "./backtest.js";

const BROKER = "https://assettbroker.com/app/traderoom";
const REFRESH_MS = 10000;       // re-busca os dados
const BT_EVERY_MS = 60000;      // recalcula o histórico no máx. a cada 60s
const BT_DEPTH = 300;
const NOTIF_THROTTLE = 5 * 60 * 1000;
const ENTRY_WINDOW_S = 8;       // "AGORA" nos últimos N segundos da vela
const LOW_VOL = 35;
const DUR = { "1m": 60000, "5m": 300000, "15m": 900000 };
const SYMBOL_LABEL = Object.fromEntries(SYMBOLS.map((s) => [s.v, s.label]));

const $ = (s) => document.querySelector(s);
let ovTf = localStorage.getItem("sc_ovtf") || "5m";
let payout = clampPayout(+localStorage.getItem("sc_payout") || 90);
let timer = null, lastBtAt = 0;
let candlesSym = {};   // { SYM: candles[] }
let aCache = {};       // { SYM: resultado do analyze }
let btCacheSym = {};   // { SYM: {n, winRate} }
let prevAlert = {}, lastNotifAt = {}, swReg = null;
let ws = null, wsFails = 0, wsRenderPending = false;

function clampPayout(v) { return Math.max(10, Math.min(100, v || 90)); }
const regIcon = (r) => (r === "tendencia" ? "✅" : r === "parado" ? "😴" : "🌀");
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
const scoreColor = (s) => (s >= 70 ? "var(--buy)" : s >= 40 ? "var(--risk-mid)" : "var(--sell)");

// ---- Ação e pontuações de cada cripto ----
function rowAction(a, remMs) {
  if (!a || !a.ok) return { key: 0, txt: "…", cls: "wait", hot: false };
  if (a.regime !== "tendencia") {
    return { key: 1, txt: `NÃO OPERAR ${regIcon(a.regime)}`, cls: "no", hot: false };
  }
  if (a.verdict === VERDICT.WAIT) return { key: 2, txt: "AGUARDE", cls: "wait", hot: false };
  const dir = a.verdict; // COMPRA / VENDA
  const hot = remMs <= ENTRY_WINDOW_S * 1000;
  const cls = dir === VERDICT.BUY ? "buy" : "sell";
  return { key: hot ? 4 : 3, txt: hot ? `⚡ ${dir} AGORA` : dir, cls, hot, dir };
}

function scores(a) {
  const conf = a.confluence;
  const tend = a.regime === "tendencia" ? 100 : a.regime === "instavel" ? 40 : 15;
  const vol = a.risk < 35 ? 90 : a.risk < 65 ? 55 : 20;
  const bt = btCacheSym[a.sym];
  let hist = 50, histVal = "—";
  if (bt) {
    const ev = evalPayout(bt.winRate, bt.n, payout / 100);
    const m = (bt.winRate - ev.breakeven) * 100;
    hist = m >= 1.5 ? 90 : m >= -1.5 ? 50 : 20;
    histVal = `${m >= 0 ? "+" : "−"}${Math.abs(m).toFixed(0)}%`;
  }
  return { conf, tend, vol, hist, histVal };
}

function miniBar(label, score, val) {
  return `<div class="mbar"><span class="mbl">${label}</span>` +
    `<span class="mbt"><i style="width:${score}%;background:${scoreColor(score)}"></i></span>` +
    `<span class="mbv">${val}</span></div>`;
}

function renderList() {
  const box = $("#mlist");
  if (!box) return;
  const now = Date.now();
  const rem = (DUR[ovTf] || 300000) - (now % (DUR[ovTf] || 300000));
  const remTxt = fmtCountdown(rem);

  const rows = SYMBOLS.map((s) => {
    const a = aCache[s.v];
    return { v: s.v, label: s.label, a, act: rowAction(a, rem) };
  }).filter((r) => r.a && r.a.ok);

  if (!rows.length) { box.innerHTML = `<div class="ovempty">carregando mercado…</div>`; return; }

  // ordena: AGORA > direção pronta > aguarde > não operar; depois por qualidade
  rows.forEach((r) => {
    const sc = scores(r.a);
    r.sc = sc;
    r.q = (sc.conf + sc.tend + sc.vol + sc.hist) / 4;
  });
  rows.sort((x, y) => y.act.key - x.act.key || y.q - x.q);

  box.innerHTML = rows.map((r) => {
    const a = r.a, sc = r.sc, act = r.act;
    const operar = `<a class="mgo${act.hot ? " hot" : ""}" href="${BROKER}" target="_blank" rel="noopener noreferrer">Operar ↗</a>`;
    return `<div class="mrow ${act.cls}${act.hot ? " hot" : ""}">
      <div class="mrow-top">
        <span class="msym">${r.label}</span>
        <span class="maction ${act.cls}">${act.txt} <span class="mclk">${remTxt}</span></span>
        ${operar}
      </div>
      <div class="mbars">
        ${miniBar("Conf", sc.conf, a.confluence + "%")}
        ${miniBar("Tend", sc.tend, regIcon(a.regime))}
        ${miniBar("Vol", sc.vol, a.risk + "%")}
        ${miniBar("Hist", sc.hist, sc.histVal)}
      </div>
    </div>`;
  }).join("");
}

function setStatus(state, text) {
  $("#status").className = "status" + (state ? " " + state : "");
  $("#status-text").textContent = text;
}

function tickClocks() {
  const now = Date.now();
  const ov = $("[data-ovclock]");
  if (ov) {
    const d = DUR[ovTf] || 300000;
    const r = d - (now % d);
    ov.textContent = "vela fecha em " + fmtCountdown(r);
    ov.classList.toggle("soon", r <= 10000);
  }
  renderList(); // re-renderiza (8 linhas) p/ atualizar contador e estado "AGORA"
}

// ---- Dados ----
async function refresh() {
  try {
    let source = null;
    await Promise.all(
      SYMBOLS.map(async (s) => {
        try {
          const candles = await fetchCandles(s.v, ovTf, BT_DEPTH);
          if (candles.source) source = candles.source;
          candlesSym[s.v] = candles;
          const a = analyze(candles);
          a.sym = s.v;
          aCache[s.v] = a;
        } catch (_) { /* mantém cache anterior desta cripto */ }
      })
    );
    maybeBacktest();
    renderList();
    checkNotifications();
    setStatus("live", `${source || "ao vivo"} · ${new Date().toLocaleTimeString("pt-BR")}`);
    if (!ws) connectWS();
  } catch (err) {
    setStatus("err", "sem dados — tentando de novo");
  }
}

function maybeBacktest() {
  if (Date.now() - lastBtAt < BT_EVERY_MS && Object.keys(btCacheSym).length) return;
  for (const s of SYMBOLS) {
    const c = candlesSym[s.v];
    if (!c) continue;
    try {
      const b = runBinaryBacktest(c, { expiryBars: 1, payout: payout / 100 });
      btCacheSym[s.v] = { n: b.n, winRate: b.winRate };
    } catch (_) {}
  }
  lastBtAt = Date.now();
}

// ---- WebSocket (tempo real) de todas as criptos no tempo escolhido ----
function closeWS() { if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; } }
function connectWS() {
  if (typeof WebSocket === "undefined") return;
  closeWS();
  const tf = ovTf;
  const streams = SYMBOLS.map((s) => s.v.toLowerCase() + "@kline_" + tf).join("/");
  let sock;
  try { sock = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); }
  catch (_) { return; }
  ws = sock;
  sock.onopen = () => { wsFails = 0; };
  sock.onmessage = (ev) => {
    if (tf !== ovTf) return;
    try {
      const msg = JSON.parse(ev.data).data;
      const sym = msg.s, k = msg.k;
      const arr = candlesSym[sym];
      if (!arr || !arr.length) return;
      const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const last = arr[arr.length - 1];
      if (c.t === last.t) arr[arr.length - 1] = c;
      else if (c.t > last.t) { arr.push(c); if (arr.length > BT_DEPTH) arr.shift(); }
      else return;
      const a = analyze(arr); a.sym = sym; aCache[sym] = a;
      scheduleWsRender();
    } catch (_) {}
  };
  sock.onerror = () => { try { sock.close(); } catch (_) {} };
  sock.onclose = () => {
    if (tf !== ovTf) return;
    wsFails++;
    if (wsFails <= 3) setTimeout(() => { if (tf === ovTf) connectWS(); }, 3000);
  };
}
function scheduleWsRender() {
  if (wsRenderPending) return;
  wsRenderPending = true;
  setTimeout(() => {
    wsRenderPending = false;
    try { renderList(); checkNotifications(); setStatus("live", `tempo real · ${new Date().toLocaleTimeString("pt-BR")}`); } catch (_) {}
  }, 300);
}

// ---- Notificações: 100% confluência + vol baixa + mercado com tendência ----
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").then((reg) => { swReg = reg; }).catch(() => {});
}
function alertsOn() {
  return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("sc_alerts") === "1";
}
function updateAlertsBtn() {
  const btn = $("#alerts"); if (!btn) return;
  const on = alertsOn();
  btn.classList.toggle("on", on);
  btn.textContent = on ? "🔔 Alertas ativos" : "🔔 Ativar alertas";
}
function bindAlerts() {
  const btn = $("#alerts"); if (!btn) return;
  if (typeof Notification === "undefined") { btn.disabled = true; btn.textContent = "🔔 Sem suporte"; return; }
  btn.addEventListener("click", async () => {
    if (alertsOn()) { localStorage.setItem("sc_alerts", "0"); updateAlertsBtn(); return; }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem("sc_alerts", "1");
      fireNotif("Alertas ativados", "Aviso quando uma cripto tiver 100% de confluência, volatilidade baixa e tendência.", null);
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
function checkNotifications() {
  const now = Date.now();
  for (const s of SYMBOLS) {
    const a = aCache[s.v];
    if (!a || !a.ok) continue;
    const eligible = a.confluence >= 100 && a.risk < LOW_VOL && a.regime === "tendencia";
    const was = prevAlert[s.v] || false;
    prevAlert[s.v] = eligible;
    if (!alertsOn()) continue;
    if (eligible && !was && now - (lastNotifAt[s.v] || 0) > NOTIF_THROTTLE) {
      lastNotifAt[s.v] = now;
      fireNotif(`${s.label} · 100% + vol baixa`, `${a.verdict} no ${ovTf} (vol ${a.risk}%) — toque para abrir`, s.v);
    }
  }
}

// ---- Controles ----
function bindOvTf() {
  const box = $("#ovtf"); if (!box) return;
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tf === ovTf);
    b.addEventListener("click", () => {
      ovTf = b.dataset.tf;
      localStorage.setItem("sc_ovtf", ovTf);
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.tf === ovTf));
      candlesSym = {}; aCache = {}; btCacheSym = {}; lastBtAt = 0;
      closeWS(); wsFails = 0;
      $("#mlist").innerHTML = `<div class="ovempty">carregando ${ovTf}…</div>`;
      refresh();
    });
  });
}
function bindPayout() {
  const inp = $("#payout"); if (!inp) return;
  inp.value = payout;
  inp.addEventListener("change", () => {
    payout = clampPayout(+inp.value);
    inp.value = payout;
    localStorage.setItem("sc_payout", payout);
    renderList(); // histórico/margem dependem do payout
  });
}

function start() {
  bindOvTf();
  bindPayout();
  bindAlerts();
  registerSW();
  refresh();
  tickClocks();
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  setInterval(tickClocks, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(timer); closeWS(); }
    else { refresh(); timer = setInterval(refresh, REFRESH_MS); }
  });
}

start();
