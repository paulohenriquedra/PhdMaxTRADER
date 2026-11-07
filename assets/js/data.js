// data.js
// Busca candles reais de câmbios públicos, SEM chave e SEM login.
// Tenta vários provedores em sequência: se um estiver bloqueado na rede/região
// do usuário, cai para o próximo automaticamente.
// Todos devolvem o mesmo formato: array de { t, o, h, l, c, v } em ordem crescente.

const base = (sym) => sym.replace(/USDT$/, ""); // "BTCUSDT" -> "BTC"

const PROVIDERS = [
  {
    name: "Binance",
    url: (sym, itv, lim) =>
      `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${lim}`,
    parse: (raw) =>
      raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })),
  },
  {
    name: "OKX",
    url: (sym, itv, lim) =>
      `https://www.okx.com/api/v5/market/candles?instId=${base(sym)}-USDT&bar=${itv}&limit=${lim}`,
    parse: (json) =>
      json.data
        .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
        .reverse(), // OKX vem do mais novo para o mais antigo
  },
  {
    name: "Coinbase",
    url: (sym, itv) => {
      const g = { "1m": 60, "5m": 300, "15m": 900 }[itv] || 60;
      return `https://api.exchange.coinbase.com/products/${base(sym)}-USD/candles?granularity=${g}`;
    },
    parse: (raw, lim) =>
      raw
        .map((k) => ({ t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] }))
        .sort((a, b) => a.t - b.t)
        .slice(-lim), // Coinbase: [time, low, high, open, close, volume], mais novo primeiro
  },
];

export async function fetchCandles(symbol, interval, limit = 150) {
  let lastErr;
  for (const p of PROVIDERS) {
    try {
      const res = await fetch(p.url(symbol, interval, limit), { cache: "no-store" });
      if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`);
      const json = await res.json();
      const candles = p.parse(json, limit);
      if (candles && candles.length >= 40) {
        candles.source = p.name;
        return candles;
      }
      throw new Error(`${p.name}: poucos dados`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Nenhuma fonte de dados disponível");
}

export const SYMBOLS = [
  { v: "BTCUSDT", label: "BTC" },
  { v: "ETHUSDT", label: "ETH" },
  { v: "SOLUSDT", label: "SOL" },
  { v: "BNBUSDT", label: "BNB" },
  { v: "XRPUSDT", label: "XRP" },
  { v: "DOGEUSDT", label: "DOGE" },
  { v: "ADAUSDT", label: "ADA" },
  { v: "AVAXUSDT", label: "AVAX" },
];
