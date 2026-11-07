// app.js — orquestra dados, motor e interface.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, combine, VERDICT } from "./engine.js";

const TIMEFRAMES = ["1m", "5m", "15m"];
const REFRESH_MS = 5000;

const $ = (sel) => document.querySelector(sel);
let symbol = localStorage.getItem("sc_symbol") || "BTCUSDT";
let timer = null;

const verdictClass = (v) =>
  v === VERDICT.BUY ? "buy" : v === VERDICT.SELL ? "sell" : "wait";
const verdictArrow = (v) =>
  v === VERDICT.BUY ? "▲" : v === VERDICT.SELL ? "▼" : "■";

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

      <div class="chips" data-chips></div>
    </article>`
  ).join("");
}

function riskColor(r) {
  if (r < 35) return "var(--risk-lo)";
  if (r < 65) return "var(--risk-mid)";
  return "var(--risk-hi)";
}

function renderCard(tf, r) {
  const card = $(`#card-${tf}`);
  if (!card) return;
  if (!r || !r.ok) {
    card.querySelector("[data-votes]").textContent = r?.reason || "sem dados";
    return;
  }
  const cls = verdictClass(r.verdict);
  card.className = `card ${cls}`;
  card.querySelector("[data-price]").textContent = fmtPrice(r.price);
  const vEl = card.querySelector(".verdict");
  vEl.className = `verdict ${cls}`;
  vEl.querySelector(".arrow").textContent = verdictArrow(r.verdict);
  vEl.querySelector("[data-verdict]").textContent = r.verdict;
  card.querySelector("[data-votes]").textContent = r.resumoVotos;

  card.querySelector("[data-conf-val]").textContent = r.confluence + "%";
  const confBar = card.querySelector("[data-conf-bar]");
  confBar.className = cls;
  confBar.style.width = r.confluence + "%";

  card.querySelector("[data-risk-val]").textContent = r.risk + "%";
  const riskBar = card.querySelector("[data-risk-bar]");
  riskBar.style.width = r.risk + "%";
  riskBar.style.background = riskColor(r.risk);
  card.querySelector("[data-risk-label]").textContent = r.riskLabel;

  card.querySelector("[data-chips]").innerHTML = r.votes
    .map((v) => `<span class="chip"><span class="d ${v.dir}"></span>${v.nome}: ${v.detalhe}</span>`)
    .join("");
}

function renderOverview(price, comb) {
  $("#ov-price-val").textContent = fmtPrice(price);
  const vEl = $("#ov-verdict-val");
  vEl.textContent = comb.verdict;
  vEl.style.color =
    comb.verdict === VERDICT.BUY ? "var(--buy)" :
    comb.verdict === VERDICT.SELL ? "var(--sell)" : "var(--wait)";
  $("#ov-verdict-note").textContent =
    comb.texto + (comb.avgRisk != null ? ` · risco médio ${comb.avgRisk}%` : "");
}

function setStatus(state, text) {
  const el = $("#status");
  el.className = "status" + (state ? " " + state : "");
  $("#status-text").textContent = text;
}

async function run(reset = false) {
  if (reset) renderOverview(null, { verdict: VERDICT.WAIT, texto: "carregando…" });
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
      renderCard(tf, r);
      if (r.ok) price = r.price;
    }
    renderOverview(price, combine(byTf));
    const now = new Date().toLocaleTimeString("pt-BR");
    setStatus("live", `${source || "ao vivo"} · ${now}`);
  } catch (err) {
    const msg = err?.message || "falha desconhecida";
    // "Failed to fetch" = bloqueio de rede/CORS/ambiente; "HTTP 4xx" = recusa da corretora.
    const dica = /failed to fetch|load failed|networkerror/i.test(msg)
      ? "rede ou ambiente bloqueando o acesso"
      : msg;
    setStatus("err", "sem dados: " + dica);
    $("#ov-verdict-note").textContent = "Nenhuma corretora respondeu (" + msg + "). Tentando de novo…";
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
