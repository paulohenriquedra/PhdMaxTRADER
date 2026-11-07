// indicators.js
// Indicadores técnicos clássicos, implementados como funções puras.
// Cada função recebe arrays de números e devolve arrays/valores calculados.
// Nada aqui "prevê o futuro": tudo é cálculo transparente sobre o histórico.

/** Média móvel simples. Retorna array com null nos pontos iniciais sem janela completa. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Média móvel exponencial (EMA). Semeada pela SMA do primeiro período. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI de Wilder (suavização por média de ganhos/perdas). */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD (12,26,9). Retorna { macd, signal, hist } como arrays alinhados. */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // sinal = EMA da linha MACD apenas sobre os pontos válidos
  const firstValid = macdLine.findIndex((v) => v != null);
  const signal = new Array(closes.length).fill(null);
  const hist = new Array(closes.length).fill(null);
  if (firstValid !== -1) {
    const valid = macdLine.slice(firstValid).map((v) => (v == null ? 0 : v));
    const sig = ema(valid, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      const idx = firstValid + i;
      if (sig[i] != null) {
        signal[idx] = sig[i];
        hist[idx] = macdLine[idx] - sig[i];
      }
    }
  }
  return { macd: macdLine, signal, hist };
}

/** Bandas de Bollinger (20,2). Retorna { mid, upper, lower, pctB, width }. */
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const pctB = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    const range = upper[i] - lower[i];
    pctB[i] = range === 0 ? 0.5 : (closes[i] - lower[i]) / range;
    width[i] = mid[i] === 0 ? 0 : (range / mid[i]) * 100;
  }
  return { mid, upper, lower, pctB, width };
}

/** ATR de Wilder (14). Mede volatilidade/risco em termos de preço. */
export function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const tr = new Array(closes.length).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Oscilador estocástico (%K, %D). */
export function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    k[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const kVals = k.map((v) => (v == null ? 0 : v));
  const dRaw = sma(kVals, dPeriod);
  const d = k.map((v, i) => (v == null ? null : dRaw[i]));
  return { k, d };
}

/** ADX de Wilder (força de tendência). Retorna array (null no aquecimento). */
export function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  if (len <= 2 * period) return out;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let atrS = 0, plusS = 0, minusS = 0;
  for (let i = 1; i <= period; i++) { atrS += tr[i]; plusS += plusDM[i]; minusS += minusDM[i]; }
  const dx = new Array(len).fill(null);
  const calcDx = () => {
    const pdi = 100 * (plusS / (atrS || 1));
    const mdi = 100 * (minusS / (atrS || 1));
    return (100 * Math.abs(pdi - mdi)) / (pdi + mdi || 1);
  };
  dx[period] = calcDx();
  for (let i = period + 1; i < len; i++) {
    atrS = atrS - atrS / period + tr[i];
    plusS = plusS - plusS / period + plusDM[i];
    minusS = minusS - minusS / period + minusDM[i];
    dx[i] = calcDx();
  }
  let sum = 0;
  for (let i = period; i < 2 * period; i++) sum += dx[i];
  let prev = sum / period;
  out[2 * period - 1] = prev;
  for (let i = 2 * period; i < len; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}
