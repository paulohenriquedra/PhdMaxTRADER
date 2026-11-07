// app.js — orquestra dados, motor, top-down, plano de entrada e backtest.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, topDown, entryPlan, VERDICT } from "./engine.js";
import { runBacktest } from "./backtest.js";

const TIMEFRAMES = ["1m", "5m", "15m"];
const REFRESH_MS = 5000;
const BT_DEPTH = 300; // velas para o backtest
const BT_EVERY_MS = 60000; // recalcula o histórico no máx. a cada 60s

const $ = (s) => document.querySelector(s);
let symbol = localStorage.getItem("sc_symbol") || "BTCUSDT";
let timer = null;
let lastBtAt = 0;
let btCache = {};

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
  sel.addEventListener("change", () => {
    symbol = sel.value;
    localStorage.setItem("sc_symbol", symbol);
    btCache = {};
    lastBtAt = 0;
    buildCards();
    run(true);
  });
}

function buildCards() {
  $("#cards").innerHTML = TIMEFRAMES.map(
    (tf) => `
    <article class="card wait" id="card-${tf}">
      <div class="tf"><span>${tf}</span><span class="price" data-price>—</span></div>
      <div class="verdict wait"><span class="arrow">■</span><span data-verdict>ESPERAR</span></div>
      <div class="votes-line" data-votes>analisando…</div>
      <div class="bar-block">
        <div class="bar-head"><span class="name">Confluência</span><span class="val" data-conf-val>—</span></div>
        <div class="bar conf"><span class="wait" data-conf-bar></span></div>
      </div>
      <div class="bar-block">
        <div class="bar-head"><span class="name">Risco</span><span class="val" data-risk-val>—</span></div>
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
    const net = bt.expectancyNet;
    const cor = net > 0.02 ? "var(--buy)" : net < -0.02 ? "var(--sell)" : "var(--muted)";
    btEl.innerHTML =
      `histórico ${bt.n} ops · acerto ${bt.winRate.toFixed(0)}% · ` +
      `líq <b style="color:${cor}">${net >= 0 ? "+" : ""}${net.toFixed(2)}R</b> · ${bt.edge}`;
  } else {
    btEl.textContent = "histórico: calculando…";
  }
}

function renderTopDown(price, td, plan) {
  $("#td-price").textContent = fmtPrice(price);
  const vEl = $("#td-verdict");
  vEl.className = "td-verdict " + vClass(td.verdict);
  vEl.textContent = (td.verdict === VERDICT.WAIT ? "" : vArrow(td.verdict) + " ") + td.verdict;
  $("#td-text").textContent = td.texto || "";

  const planEl = $("#plan");
  if (plan) {
    planEl.hidden = false;
    planEl.querySelector("[data-entry]").textContent = fmtPrice(plan.entry);
    planEl.querySelector("[data-stop]").textContent =
      fmtPrice(plan.stop) + ` (−${plan.riscoPct.toFixed(2)}%)`;
    planEl.querySelector("[data-target]").textContent =
      fmtPrice(plan.target) + ` (+${plan.ganhoPct.toFixed(2)}%)`;
    planEl.querySelector("[data-rr]").textContent = "1:" + plan.rr;
  } else {
    planEl.hidden = true;
  }
}

function setStatus(state, text) {
  $("#status").className = "status" + (state ? " " + state : "");
  $("#status-text").textContent = text;
}

async function maybeBacktest() {
  if (Date.now() - lastBtAt < BT_EVERY_MS && Object.keys(btCache).length) return;
  try {
    await Promise.all(
      TIMEFRAMES.map(async (tf) => {
        const candles = await fetchCandles(symbol, tf, BT_DEPTH);
        btCache[tf] = runBacktest(candles);
      })
    );
    lastBtAt = Date.now();
  } catch (_) {
    /* mantém cache anterior se falhar */
  }
}

async function run(reset = false) {
  if (reset) {
    renderTopDown(null, { verdict: VERDICT.WAIT, texto: "carregando…" }, null);
    buildCards();
  }
  try {
    let source = null;
    const results = await Promise.all(
      TIMEFRAMES.map(async (tf) => {
        const candles = await fetchCandles(symbol, tf, 150);
        if (candles.source) source = candles.source;
        return [tf, analyze(candles)];
      })
    );
    const byTf = {};
    let price = null;
    for (const [tf, r] of results) {
      byTf[tf] = r;
      if (r.ok) price = r.price;
    }

    // Histórico (não precisa recalcular a cada ciclo)
    await maybeBacktest();

    for (const [tf, r] of results) renderCard(tf, r, btCache[tf]);

    const td = topDown(byTf["15m"], byTf["5m"], byTf["1m"]);
    const base =
      td.verdict !== VERDICT.WAIT
        ? byTf["5m"].verdict === td.verdict
          ? byTf["5m"]
          : byTf["15m"]
        : null;
    const plan = base ? entryPlan(base) : null;
    renderTopDown(price, td, plan);

    setStatus("live", `${source || "ao vivo"} · ${new Date().toLocaleTimeString("pt-BR")}`);
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

function start() {
  buildSymbolSelect();
  buildCards();
  run(true);
  clearInterval(timer);
  timer = setInterval(run, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(timer);
    else { run(); timer = setInterval(run, REFRESH_MS); }
  });
}

start();
