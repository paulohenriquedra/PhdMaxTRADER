// app.js — Lista inteligente: para cada cripto, a ação do momento + checklist
// em mini-barras. Tempo real (WebSocket) com fallback de polling. Apoio à
// decisão; o usuário confere e opera.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, VERDICT } from "./engine.js";
import { runBinaryBacktest, evalPayout } from "./backtest.js";
import { ema } from "./indicators.js";

const BROKER = "https://assettbroker.com/app/traderoom";
const REFRESH_MS = 10000;       // re-busca os dados
const BT_EVERY_MS = 60000;      // recalcula o histórico no máx. a cada 60s
const BT_DEPTH = 300;
const NOTIF_THROTTLE = 5 * 60 * 1000;
const ENTRY_LEAD_S = 30;        // avisa "PREPARAR" com N segundos de antecedência
let armedDir = {};              // direção travada perto da virada, por cripto
let day = { date: "", wins: 0, losses: 0, limit: 3 };
let dayLocked = false;
let lastLeadBoundary = 0;       // dedup da notificação de 30s por vela
let pending = [];               // operações aguardando resultado
let streak = 0;                 // perdas seguidas
let pauseStreak = +localStorage.getItem("sc_pausestreak") || 2;
let paused = false;             // pausa temporária após sequência de perdas
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
// remMs = quanto falta pra vela fechar; dur = duração da vela.
// O clique certo é NA VIRADA da vela (contador em 0), pra operar a próxima.
function rowAction(a, sym, remMs, dur) {
  if (!a || !a.ok) { armedDir[sym] = null; return { key: 0, txt: "…", cls: "wait", hot: false }; }
  if (a.regime !== "tendencia") { armedDir[sym] = null; return { key: 1, txt: `NÃO OPERAR ${regIcon(a.regime)}`, cls: "no", hot: false }; }
  if (a.verdict === VERDICT.WAIT) { armedDir[sym] = null; return { key: 2, txt: "AGUARDE", cls: "wait", hot: false }; }
  const dir = a.verdict, cls = dir === VERDICT.BUY ? "buy" : "sell";
  const strong = a.confluence >= 75;

  // Trava a direção nos segundos finais (pra não mudar bem na hora do clique).
  if (remMs <= 12000 && strong) armedDir[sym] = dir;
  // Zona de clique: últimos 5s da vela atual OU primeiros 3s da próxima (a virada).
  const clickZone = remMs <= 5000 || remMs >= dur - 3000;
  if (clickZone && armedDir[sym]) {
    const d = armedDir[sym], c = d === VERDICT.BUY ? "buy" : "sell";
    return { key: 5, txt: `⚡ CLIQUE ${d}`, cls: c, hot: true, dir: d };
  }
  // Longe da virada: libera a trava.
  if (remMs < dur - 3000 && remMs > 12000) armedDir[sym] = null;

  if (!strong) return { key: 2, txt: "AGUARDE", cls: "wait", hot: false };
  if (dayLocked) return { key: 1, txt: "🛑 limite do dia", cls: "no", hot: false };
  if (paused) return { key: 1, txt: "⏸️ em pausa", cls: "no", hot: false };
  if (remMs <= ENTRY_LEAD_S * 1000) return { key: 4, txt: `PREPARAR ${dir} · ${fmtCountdown(remMs)}`, cls, hot: false, dir };
  return { key: 3, txt: dir, cls, hot: false, dir };
}

// ---- Controle do dia (gestão de perdas) ----
function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadDay() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem("sc_day") || "null"); } catch (_) {}
  const t = todayStr();
  if (!d || d.date !== t) d = { date: t, wins: 0, losses: 0, limit: (d && d.limit) || +localStorage.getItem("sc_losslimit") || 3 };
  day = d;
  saveDay();
}
function saveDay() { try { localStorage.setItem("sc_day", JSON.stringify(day)); } catch (_) {} }
function renderDay() {
  const dw = $("#dw"), dl = $("#dl"), lock = $("#daylock");
  if (dw) dw.textContent = day.wins;
  if (dl) dl.textContent = day.losses;
  const ds = $("#dstreak"); if (ds) ds.textContent = streak;
  dayLocked = day.losses >= day.limit;
  if (lock) lock.hidden = !dayLocked;
  const pb = $("#daypause"), pm = $("#pausemsg");
  if (pb) pb.hidden = !paused;
  if (pm && paused) pm.textContent = `${streak} perdas seguidas. Dê um tempo, espere o mercado mudar.`;
  const lim = $("#dayLimit"); if (lim && document.activeElement !== lim) lim.value = day.limit;
  const ps = $("#pauseStreak"); if (ps && document.activeElement !== ps) ps.value = pauseStreak;
}
function bindDay() {
  loadDay();
  $("#dayWin")?.addEventListener("click", () => { day.wins++; saveDay(); renderDay(); renderList(); });
  $("#dayLoss")?.addEventListener("click", () => { day.losses++; saveDay(); renderDay(); renderList(); });
  $("#dayReset")?.addEventListener("click", () => { day.wins = 0; day.losses = 0; saveDay(); renderDay(); renderList(); });
  $("#dayLimit")?.addEventListener("change", (e) => {
    day.limit = Math.max(1, Math.min(30, +e.target.value || 3));
    localStorage.setItem("sc_losslimit", day.limit);
    saveDay(); renderDay(); renderList();
  });
  $("#pauseStreak")?.addEventListener("change", (e) => {
    pauseStreak = Math.max(1, Math.min(10, +e.target.value || 2));
    localStorage.setItem("sc_pausestreak", pauseStreak);
    renderDay();
  });
  $("#pauseResume")?.addEventListener("click", resumeTrading);
  renderDay();
}

// ---- Registro automático de resultado (Green/Loss) ----
function flashToast(msg, good) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = "toast show" + (good === true ? " good" : good === false ? " bad" : "");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => { t.className = "toast"; }, 3800);
}
// Ao clicar em Operar: registra a operação (direção do sinal, preço e a vela de resultado).
function registerTrade(sym) {
  if (paused || dayLocked) return;
  const a = aCache[sym];
  if (!a || !a.ok || (a.verdict !== VERDICT.BUY && a.verdict !== VERDICT.SELL)) return;
  const dur = DUR[ovTf] || 300000, now = Date.now();
  const open = Math.round(now / dur) * dur; // vela que a operação cobre
  pending.push({ sym, dir: a.verdict, entry: a.price, open, at: open + dur, tf: ovTf });
  flashToast(`Registrado: ${SYMBOL_LABEL[sym]} ${a.verdict} · aguardando resultado`);
}
function recordOutcome(sym, win) {
  if (win) { day.wins++; streak = 0; }
  else { day.losses++; streak++; }
  saveDay();
  flashToast(`${SYMBOL_LABEL[sym] || sym}: ${win ? "GREEN ✓" : "LOSS ✗"}`, win);
  fireNotif(`${SYMBOL_LABEL[sym] || sym}: ${win ? "GREEN ✓" : "LOSS ✗"}`, win ? "Operação registrada." : "Faz parte. Respeite seu limite.", sym);
  if (!win && streak >= pauseStreak) enterPause();
  renderDay();
}
function resolvePending() {
  const now = Date.now();
  let changed = false;
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i], dur = DUR[p.tf] || 300000;
    if (now < p.open + dur) continue; // a vela de resultado ainda não fechou
    const arr = candlesSym[p.sym];
    if (!arr) continue;
    const cndl = arr.find((c) => c.t === p.open);
    if (!cndl) {
      if (now > p.at + dur * 3) pending.splice(i, 1); // velho demais: descarta
      continue;
    }
    const win = p.dir === VERDICT.BUY ? cndl.c > p.entry : cndl.c < p.entry;
    pending.splice(i, 1);
    recordOutcome(p.sym, win);
    changed = true;
  }
  if (changed) renderList();
}
function enterPause() {
  paused = true;
  renderDay();
  flashToast(`⏸️ Pausa: ${streak} perdas seguidas. Respire antes de voltar.`, false);
  fireNotif("⏸️ Pausa recomendada", `${streak} perdas seguidas. Pare um pouco antes de voltar.`, null);
}
function resumeTrading() { paused = false; streak = 0; renderDay(); renderList(); }

// ---- Notificação 30s antes da virada da vela ----
function checkLeadNotification() {
  if (!alertsOn() || dayLocked) return;
  const dur = DUR[ovTf] || 300000;
  const now = Date.now();
  const rem = dur - (now % dur);
  const boundary = Math.round((now + rem) / 1000); // próximo fechamento (s)
  if (rem <= ENTRY_LEAD_S * 1000 && rem > (ENTRY_LEAD_S - 3) * 1000 && boundary !== lastLeadBoundary) {
    lastLeadBoundary = boundary;
    const elig = SYMBOLS.map((s) => aCache[s.v])
      .filter((a) => a && a.ok && a.confluence >= 100 && a.risk < LOW_VOL && a.regime === "tendencia")
      .sort((x, y) => x.risk - y.risk);
    if (elig.length) {
      const a = elig[0];
      fireNotif(`⏰ 30s · ${SYMBOL_LABEL[a.sym]} ${a.verdict}`, `Prepare e clique na virada (${ovTf}, expiração ${ovTf})`, a.sym);
    }
  }
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
  const dur = DUR[ovTf] || 300000;
  const rem = dur - (now % dur);
  const remTxt = fmtCountdown(rem);

  const rows = SYMBOLS.map((s) => {
    const a = aCache[s.v];
    return { v: s.v, label: s.label, a, act: rowAction(a, s.v, rem, dur) };
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
    return `<div class="mrow ${act.cls}${act.hot ? " hot" : ""}" data-sym="${r.v}">
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
  checkLeadNotification();
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
    resolvePending();
    renderList();
    updateOpenChart();
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
    try { resolvePending(); renderList(); updateOpenChart(); checkNotifications(); setStatus("live", `tempo real · ${new Date().toLocaleTimeString("pt-BR")}`); } catch (_) {}
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
      closeWS(); wsFails = 0; closeChart();
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

// ---- Gráfico de velas (Lightweight Charts) ----
let chart = null, candleSeries = null, ema9S = null, ema21S = null, openChartSym = null;
const toBar = (x) => ({ time: Math.floor(x.t / 1000), open: x.o, high: x.h, low: x.l, close: x.c });
function emaBars(c, p) {
  const e = ema(c.map((x) => x.c), p);
  const out = [];
  for (let i = 0; i < c.length; i++) if (e[i] != null) out.push({ time: Math.floor(c[i].t / 1000), value: e[i] });
  return out;
}
function openChart(sym) {
  const modal = $("#chartModal"), el = $("#chart");
  openChartSym = sym;
  $("#chart-title").textContent = `${SYMBOL_LABEL[sym] || sym} · ${ovTf}`;
  const op = $("#chart-op"); if (op) op.href = BROKER;
  modal.hidden = false;
  if (typeof LightweightCharts === "undefined") {
    $("#chart-foot").textContent = "gráfico indisponível (biblioteca não carregou)";
    return;
  }
  if (chart) { try { chart.remove(); } catch (_) {} chart = null; }
  el.innerHTML = "";
  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: "#141b26" }, textColor: "#8a9bb0", fontFamily: "Inter, sans-serif" },
    grid: { vertLines: { color: "#1a2230" }, horzLines: { color: "#1a2230" } },
    rightPriceScale: { borderColor: "#223042" },
    timeScale: { borderColor: "#223042", timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false });
  ema9S = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ema21S = chart.addLineSeries({ color: "#f0b429", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const c = candlesSym[sym] || [];
  candleSeries.setData(c.map(toBar));
  ema9S.setData(emaBars(c, 9));
  ema21S.setData(emaBars(c, 21));
  chart.timeScale().fitContent();
}
function updateOpenChart() {
  if (!chart || !openChartSym || !candleSeries) return;
  const c = candlesSym[openChartSym];
  if (!c || !c.length) return;
  try {
    candleSeries.update(toBar(c[c.length - 1]));
    const cl = c.map((x) => x.c), t = Math.floor(c[c.length - 1].t / 1000);
    const e9 = ema(cl, 9).at(-1), e21 = ema(cl, 21).at(-1);
    if (e9 != null) ema9S.update({ time: t, value: e9 });
    if (e21 != null) ema21S.update({ time: t, value: e21 });
  } catch (_) {}
}
function closeChart() {
  const modal = $("#chartModal"); if (modal) modal.hidden = true;
  openChartSym = null;
  if (chart) { try { chart.remove(); } catch (_) {} chart = null; candleSeries = ema9S = ema21S = null; }
}
function bindChart() {
  $("#chart-close")?.addEventListener("click", closeChart);
  $("#chartModal")?.addEventListener("click", (e) => { if (e.target.id === "chartModal") closeChart(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeChart(); });
  $("#mlist")?.addEventListener("click", (e) => {
    const row = e.target.closest(".mrow");
    if (e.target.closest(".mgo")) { if (row) registerTrade(row.dataset.sym); return; } // Operar: registra e abre o link
    if (row && row.dataset.sym) openChart(row.dataset.sym);
  });
  window.addEventListener("resize", () => {
    if (chart) { const el = $("#chart"); chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); }
  });
}

function start() {
  bindOvTf();
  bindPayout();
  bindAlerts();
  bindChart();
  bindDay();
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
