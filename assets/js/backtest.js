// backtest.js
// Mede o desempenho REAL do sinal no histórico, sem "espiar o futuro".
// Em cada vela fechada, calcula o sinal usando SÓ o passado até ali; se for
// COMPRA/VENDA, simula a operação para frente (stop e alvo por ATR) e registra
// o resultado em múltiplos de risco (R). No fim, dá acerto %, expectativa e
// se existe vantagem (edge) de verdade.

import { analyze, VERDICT } from "./engine.js";
import { ema, rsi as rsiSeries, macd as macdSeries, stochastic } from "./indicators.js";

/**
 * Backtest para OPÇÃO BINÁRIA (compra/venda com expiração fixa).
 * Não há alvo nem stop: ganha se, na expiração, o preço fechou do lado do sinal.
 * Otimizado O(n): os indicadores são calculados UMA vez (cada um só usa o
 * passado, então ler a série no índice i equivale a analisar a fatia até i —
 * sem "espiar o futuro"), e as velas são percorridas em seguida.
 */
export function runBinaryBacktest(candles, { expiryBars = 1, payout = 0.85 } = {}) {
  const warmup = 40;
  const close = candles.map((c) => c.c);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const e9 = ema(close, 9), e21 = ema(close, 21);
  const rs = rsiSeries(close, 14);
  const hist = macdSeries(close).hist;
  const st = stochastic(high, low, close);

  let wins = 0, losses = 0, pushes = 0;
  let wins4 = 0, losses4 = 0; // subconjunto 4/4
  let i = warmup;
  while (i < candles.length - expiryBars) {
    if (e9[i] == null || e21[i] == null || rs[i] == null || hist[i] == null || st.k[i] == null || st.d[i] == null) { i++; continue; }
    let up = 0, down = 0;
    if (e9[i] > e21[i]) up++; else if (e9[i] < e21[i]) down++;
    if (rs[i] >= 50) up++; else down++;
    if (hist[i] > 0) up++; else if (hist[i] < 0) down++;
    if (st.k[i] > st.d[i]) up++; else if (st.k[i] < st.d[i]) down++;
    let long;
    if (up >= 3 && up > down) long = true;
    else if (down >= 3 && down > up) long = false;
    else { i++; continue; }
    const entry = close[i];
    const exp = close[i + expiryBars];
    const forte = up === 4 || down === 4; // 4/4
    if (exp === entry) pushes++;
    else {
      const ganhou = long ? exp > entry : exp < entry;
      if (ganhou) { wins++; if (forte) wins4++; }
      else { losses++; if (forte) losses4++; }
    }
    i += expiryBars; // próxima operação após a expiração (sem sobrepor)
  }
  const n = wins + losses;
  const winRate = n ? wins / n : 0; // fração 0..1 (empates fora)
  const n4 = wins4 + losses4;
  const winRate4 = n4 ? wins4 / n4 : 0;
  return { n, wins, losses, pushes, winRate, n4, winRate4, expiryBars, ...evalPayout(winRate, n, payout) };
}

/**
 * Dado o acerto medido, avalia contra um pagamento específico.
 * Separado para recalcular na hora quando o usuário muda o payout,
 * sem precisar rodar o backtest de novo (o acerto não depende do payout).
 */
export function evalPayout(winRate, n, payout) {
  const breakeven = 1 / (1 + payout); // acerto mínimo pra empatar
  const expectancy = n ? winRate * payout - (1 - winRate) : 0; // por operação
  let edge;
  if (n < 25) edge = "poucos dados";
  else if (winRate > breakeven + 0.02) edge = "acima do equilíbrio";
  else if (winRate >= breakeven - 0.01) edge = "no equilíbrio";
  else edge = "abaixo do equilíbrio";
  return { breakeven, expectancy, payout, edge };
}

/**
 * candles: array cronológico de { t,o,h,l,c,v }.
 * opts: atrMult (stop), rr (alvo = rr×risco), maxHold (velas máx. na operação),
 *       custoPct (custo de ida+volta por operação, em % do preço).
 */
export function runBacktest(candles, opts = {}) {
  const atrMult = opts.atrMult ?? 1.5;
  const rr = opts.rr ?? 2;
  const maxHold = opts.maxHold ?? 20;
  const custoPct = opts.custoPct ?? 0.04; // ida+volta por operação (ajustável)
  const warmup = 40; // velas mínimas para os indicadores

  const trades = [];
  let i = warmup;
  while (i < candles.length - 2) {
    // Sinal calculado SÓ com o passado até a vela i (sem lookahead).
    const r = analyze(candles.slice(0, i + 1));
    if (!r.ok || r.verdict === VERDICT.WAIT || !r.atr) {
      i++;
      continue;
    }
    const long = r.verdict === VERDICT.BUY;
    const entry = candles[i].c;
    const dist = atrMult * r.atr;
    if (dist <= 0) { i++; continue; }
    const stop = long ? entry - dist : entry + dist;
    const target = long ? entry + rr * dist : entry - rr * dist;
    const custoR = ((custoPct / 100) * entry) / dist; // custo convertido em R

    let grossR = null; // resultado da operação ANTES do custo
    let exit = i;
    for (let j = i + 1; j <= Math.min(i + maxHold, candles.length - 1); j++) {
      const { h, l } = candles[j];
      if (long) {
        if (l <= stop) { grossR = -1; exit = j; break; }
        if (h >= target) { grossR = rr; exit = j; break; }
      } else {
        if (h >= stop) { grossR = -1; exit = j; break; }
        if (l <= target) { grossR = rr; exit = j; break; }
      }
    }
    if (grossR === null) {
      // Não bateu stop nem alvo: fecha no último preço disponível (R fracionado).
      exit = Math.min(i + maxHold, candles.length - 1);
      const close = candles[exit].c;
      grossR = (long ? close - entry : entry - close) / dist;
    }
    trades.push({ entry: i, exit, long, grossR, netR: grossR - custoR, custoR });
    i = exit + 1; // sem operações sobrepostas
  }

  const n = trades.length;
  // Acerto = a OPERAÇÃO em si deu certo (antes do custo): direção acertou.
  const wins = trades.filter((t) => t.grossR > 0).length;
  const winRate = n ? (wins / n) * 100 : 0;
  const expGross = n ? trades.reduce((s, t) => s + t.grossR, 0) / n : 0;
  const expNet = n ? trades.reduce((s, t) => s + t.netR, 0) / n : 0;
  const custoMedioR = n ? trades.reduce((s, t) => s + t.custoR, 0) / n : 0;
  const gw = trades.filter((t) => t.netR > 0).reduce((s, t) => s + t.netR, 0);
  const gl = -trades.filter((t) => t.netR < 0).reduce((s, t) => s + t.netR, 0);
  const profitFactor = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;

  // "Edge" avalia a DIREÇÃO do sinal (antes do custo); o custo é mostrado à parte.
  let edge;
  if (n < 20) edge = "poucos dados";
  else if (expGross > 0.05) edge = "edge positivo";
  else if (expGross >= -0.02) edge = "marginal / sem edge";
  else edge = "negativo";

  return {
    n, winRate,
    expectancy: expGross,       // R médio por operação, antes do custo
    expectancyNet: expNet,      // depois do custo realista
    custoMedioR,                // quanto o custo come por operação (em R)
    profitFactor, edge, rr, atrMult, custoPct,
  };
}
