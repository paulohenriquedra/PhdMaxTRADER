// engine.js
// Motor de decisão: recebe candles (OHLC) e devolve um veredito PRONTO
// (COMPRA / VENDA / ESPERAR) + confluência + risco, com o detalhe de cada voto.
// O veredito nunca é inventado: é o resultado de indicadores reais concordando.

import { ema, rsi, macd, bollinger, atr, stochastic, lastValid, efficiencyRatio } from "./indicators.js";

export const VERDICT = { BUY: "COMPRA", SELL: "VENDA", WAIT: "ESPERAR" };
const UP = "alta";
const DOWN = "baixa";
const FLAT = "neutro";

/**
 * Analisa um conjunto de candles e devolve o veredito do timeframe.
 * candles: array de { t, o, h, l, c, v } em ordem cronológica.
 */
export function analyze(candles) {
  if (!candles || candles.length < 40) {
    return { ok: false, reason: "Dados insuficientes" };
  }
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const price = closes[closes.length - 1];

  const ema9 = lastValid(ema(closes, 9));
  const ema21 = lastValid(ema(closes, 21));
  const rsiVal = lastValid(rsi(closes, 14));
  const mac = macd(closes);
  const hist = lastValid(mac.hist);
  const stoch = stochastic(highs, lows, closes);
  const kVal = lastValid(stoch.k);
  const dVal = lastValid(stoch.d);
  const bb = bollinger(closes);
  const bbWidth = lastValid(bb.width);
  const atrSeries = atr(highs, lows, closes, 14);
  const atrVal = lastValid(atrSeries);
  const atrMedian = median(atrSeries.filter((v) => v != null).slice(-50));

  // ---- Os 4 votos ----
  const votes = [];

  // 1) Tendência (EMA9 x EMA21)
  votes.push({
    nome: "Tendência",
    dir: ema9 > ema21 ? UP : ema9 < ema21 ? DOWN : FLAT,
    detalhe: `EMA9 ${ema9 > ema21 ? ">" : "<"} EMA21`,
  });

  // 2) RSI (momento). Extremos NÃO invertem a direção: viram risco mais alto.
  const rsiEsticado = rsiVal >= 70 || rsiVal <= 30;
  votes.push({
    nome: "RSI",
    dir: rsiVal >= 50 ? UP : DOWN,
    detalhe: `RSI ${rsiVal.toFixed(0)}${rsiEsticado ? " (esticado)" : ""}`,
  });

  // 3) MACD (histograma)
  votes.push({
    nome: "MACD",
    dir: hist > 0 ? UP : hist < 0 ? DOWN : FLAT,
    detalhe: `Histograma ${hist > 0 ? "positivo" : hist < 0 ? "negativo" : "zero"}`,
  });

  // 4) Estocástico (%K vs %D). Extremos também entram no risco, não na direção.
  const stEsticado = kVal >= 80 || kVal <= 20;
  votes.push({
    nome: "Estocástico",
    dir: kVal > dVal ? UP : kVal < dVal ? DOWN : FLAT,
    detalhe: `%K ${kVal.toFixed(0)} / %D ${dVal.toFixed(0)}${stEsticado ? " (esticado)" : ""}`,
  });

  // ---- Apuração ----
  const ups = votes.filter((v) => v.dir === UP).length;
  const downs = votes.filter((v) => v.dir === DOWN).length;
  const total = votes.length;
  const maior = Math.max(ups, downs);

  let verdict = VERDICT.WAIT;
  let dirLabel = FLAT;
  if (ups >= 3 && ups > downs) { verdict = VERDICT.BUY; dirLabel = UP; }
  else if (downs >= 3 && downs > ups) { verdict = VERDICT.SELL; dirLabel = DOWN; }

  const concordam = dirLabel === UP ? ups : dirLabel === DOWN ? downs : maior;
  const confluence = Math.round((concordam / total) * 100);

  // Viés direcional "suave" (mesmo sem os 3/4): serve ao modelo top-down.
  const bias = ups > downs ? UP : downs > ups ? DOWN : FLAT;
  const score = ups - downs;

  // ---- Risco (volatilidade real) ----
  const atrPct = atrVal != null && price ? (atrVal / price) * 100 : 0;
  // (a) Regime: volatilidade agora vs. o normal recente da própria cripto/tempo.
  //     Normal (=mediana) -> ~50; o dobro -> 100; metade -> ~25.
  const ratio = atrMedian ? atrVal / atrMedian : 1;
  const riskRegime = clamp(ratio * 50, 0, 100);
  // (b) Nível absoluto: mercado parado lê baixo; muito volátil lê alto.
  const riskAbs = clamp((atrPct / 0.7) * 100, 0, 100);
  // (c) "Esticado" (sobrecomprado/sobrevendido) soma risco de reversão.
  const stretch = (rsiEsticado ? 12 : 0) + (stEsticado ? 10 : 0);
  const risk = Math.round(clamp(riskRegime * 0.6 + riskAbs * 0.25 + stretch, 0, 100));
  const riskLabel = risk < 25 ? "Baixo" : risk < 50 ? "Moderado" : risk < 75 ? "Alto" : "Extremo";

  const resumoVotos =
    verdict === VERDICT.WAIT
      ? "Indicadores sem acordo"
      : `${concordam} de ${total} indicadores em ${dirLabel}`;

  // ---- Condição do mercado (regime) ----
  // (a) AMPLITUDE: o mercado está se mexendo o suficiente? Mesmo com os
  //     indicadores concordando, se as últimas velas quase não andaram, é
  //     mercado PARADO — operar aqui é pura sorte no micro-ruído.
  const n = closes.length;
  // piso mínimo de movimento (% do preço), escalado pelo tempo da vela
  const durMin = n > 1 ? (candles[1].t - candles[0].t) / 60000 : 1;
  const minRangePct = 0.06 * Math.sqrt(durMin || 1);
  let paradoAmp = false;
  let movePct = 0; // amplitude típica da vela, em % do preço (força do movimento)
  if (n >= 16) {
    const rngs = [];
    for (let k = n - 15; k < n; k++) rngs.push(highs[k] - lows[k]);
    const medR = median(rngs);
    movePct = price ? (medR / price) * 100 : 0;
    const s3 = Math.max(highs[n - 1], highs[n - 2], highs[n - 3]) - Math.min(lows[n - 1], lows[n - 2], lows[n - 3]);
    // parado se: a vela típica mal anda (absoluto) OU o movimento colapsou (relativo)
    paradoAmp = movePct < minRangePct || (medR > 0 && s3 < medR);
  }
  // (b) Efficiency Ratio: progresso líquido vs. movimento total (picotado?).
  const er = efficiencyRatio(closes, 10);
  let regime = "tendencia"; // ✅ movimento com direção
  let regimeLabel = "Com tendência";
  if (paradoAmp) {
    regime = "parado"; regimeLabel = "Parado (sem movimento)";
  } else if (er != null && er < 0.4) {
    if (risk < 25) { regime = "parado"; regimeLabel = "Parado"; }
    else { regime = "instavel"; regimeLabel = "Instável (vai-e-volta)"; }
  }

  return {
    ok: true,
    price,
    verdict,
    dirLabel,
    bias,
    score,
    confluence,
    risk,
    riskLabel,
    atr: atrVal,
    atrPct,
    er,
    movePct,
    minMove: minRangePct,
    regime,
    regimeLabel,
    resumoVotos,
    votes,
  };
}

export const DIR = { UP, DOWN, FLAT };

/**
 * Modelo top-down: o 15m define a direção (tendência), o 5m confirma,
 * o 1m cronometra a entrada. Devolve UM veredito, não três soltos.
 */
export function topDown(r15, r5, r1) {
  if (!r15?.ok || !r5?.ok || !r1?.ok) {
    return { ok: false, verdict: VERDICT.WAIT, texto: "Aguardando dados dos três tempos" };
  }
  const dir = r15.bias;
  if (dir === FLAT) {
    return {
      ok: true, verdict: VERDICT.WAIT, forca: 0,
      texto: "15m sem tendência clara (lateral) — melhor não operar agora",
    };
  }
  const lado = dir === UP ? "alta" : "baixa";
  const confirma = r5.bias === dir;
  const gatilho = r1.bias === dir;

  if (confirma && gatilho) {
    return {
      ok: true,
      verdict: dir === UP ? VERDICT.BUY : VERDICT.SELL,
      forca: 100,
      texto: `Tendência de ${lado} no 15m, confirmada no 5m e disparada no 1m — a favor da tendência`,
    };
  }
  if (confirma && !gatilho) {
    return {
      ok: true, verdict: VERDICT.WAIT, forca: 60,
      texto: `Tendência de ${lado} no 15m e 5m — aguarde o 1m confirmar antes de entrar`,
    };
  }
  return {
    ok: true, verdict: VERDICT.WAIT, forca: 30,
    texto: `15m aponta ${lado}, mas o 5m não confirma — sem alinhamento, espere`,
  };
}

/**
 * Plano de entrada a partir de um veredito direcional.
 * Stop baseado em ATR; alvo pela relação risco/retorno (rr).
 */
export function entryPlan(r, { atrMult = 1.5, rr = 2 } = {}) {
  if (!r?.ok || r.verdict === VERDICT.WAIT || !r.atr) return null;
  const long = r.verdict === VERDICT.BUY;
  const entry = r.price;
  const dist = atrMult * r.atr;
  const stop = long ? entry - dist : entry + dist;
  const target = long ? entry + rr * dist : entry - rr * dist;
  return {
    lado: long ? "compra" : "venda",
    entry,
    stop,
    target,
    riscoPct: (dist / entry) * 100,
    ganhoPct: (rr * dist / entry) * 100,
    rr,
  };
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Combina os vereditos dos vários timeframes em um resumo geral honesto. */
export function combine(byTf) {
  const entries = Object.values(byTf).filter((r) => r && r.ok);
  if (!entries.length) return { verdict: VERDICT.WAIT, texto: "Aguardando dados" };
  const buys = entries.filter((r) => r.verdict === VERDICT.BUY).length;
  const sells = entries.filter((r) => r.verdict === VERDICT.SELL).length;
  let verdict = VERDICT.WAIT;
  if (buys >= 2 && buys > sells) verdict = VERDICT.BUY;
  else if (sells >= 2 && sells > buys) verdict = VERDICT.SELL;
  const avgRisk = Math.round(entries.reduce((s, r) => s + r.risk, 0) / entries.length);
  let texto;
  if (verdict === VERDICT.WAIT) {
    texto = "Tempos gráficos divergentes — melhor aguardar";
  } else {
    const n = verdict === VERDICT.BUY ? buys : sells;
    texto = `${n} de ${entries.length} tempos alinhados em ${verdict.toLowerCase()}`;
  }
  return { verdict, texto, avgRisk };
}
