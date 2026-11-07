// app.js — orquestra dados, motor, top-down, plano de entrada e backtest.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, topDown, VERDICT } from "./engine.js";
import { runBinaryBacktest, evalPayout } from "./backtest.js";

const TIMEFRAMES = ["1m", "5m", "15m"];
const REFRESH_MS = 5000;
const BT_DEPTH = 300; // velas para o backtest
const BT_EVERY_MS = 60000; // recalcula o histórico no máx. a cada 60s

const $ = (s) => document.querySelector(s);
let symbol = localStorage.getItem("sc_symbol") || "BTCUSDT";
let payout = clampPayout(+localStorage.getItem("sc_payout") || 85);
let timer = null;
let lastBtAt = 0;
let btCache = {}; // { tf: {n, winRate} }
let lastDirByTf = {}; // direção atual por tf, para a recomendação

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
      <div class="inds" data-inds></div>
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

async function maybeBacktest() {
  if (Date.now() - lastBtAt < BT_EVERY_MS && Object.keys(btCache).length) return;
  try {
    await Promise.all(
      TIMEFRAMES.map(async (tf) => {
        const candles = await fetchCandles(symbol, tf, BT_DEPTH);
        const b = runBinaryBacktest(candles, { expiryBars: 1, payout: payout / 100 });
        btCache[tf] = { n: b.n, winRate: b.winRate };
      })
    );
    lastBtAt = Date.now();
  } catch (_) {
    /* mantém cache anterior se falhar */
  }
}

async function run(reset = false) {
  if (reset) {
    renderTopDown(null, { verdict: VERDICT.WAIT, texto: "carregando…" });
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
      lastDirByTf[tf] = r.ok ? r.verdict : VERDICT.WAIT;
      if (r.ok) price = r.price;
    }

    // Histórico (não precisa recalcular a cada ciclo)
    await maybeBacktest();

    for (const [tf, r] of results) renderCard(tf, r, btCache[tf]);

    const td = topDown(byTf["15m"], byTf["5m"], byTf["1m"]);
    renderTopDown(price, td);

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

function start() {
  buildSymbolSelect();
  bindPayout();
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
