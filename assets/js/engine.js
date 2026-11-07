// engine.js
// Motor de decisão: recebe candles (OHLC) e devolve um veredito PRONTO
// (COMPRA / VENDA / ESPERAR) + confluência + risco, com o detalhe de cada voto.
// O veredito nunca é inventado: é o resultado de indicadores reais concordando.

import { ema, rsi, macd, bollinger, atr, stochastic, lastValid } from "./indicators.js";

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

  return {
    ok: true,
    price,
    verdict,
    dirLabel,
    confluence,
    risk,
    riskLabel,
    atrPct,
    resumoVotos,
    votes,
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
