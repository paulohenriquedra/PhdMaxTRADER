// Teste rápido: gera séries sintéticas e confere se o veredito faz sentido.
import { analyze, VERDICT } from "../assets/js/engine.js";
import { rsi, ema, atr } from "../assets/js/indicators.js";

function assert(cond, msg) {
  if (!cond) { console.error("FALHOU:", msg); process.exitCode = 1; }
  else console.log("ok:", msg);
}

// Sanidade dos indicadores
const seq = Array.from({ length: 60 }, (_, i) => 100 + i); // subindo sempre
assert(ema(seq, 9).at(-1) > ema(seq, 21).at(-1), "EMA9 > EMA21 em alta");
assert(rsi(seq, 14).at(-1) > 70, "RSI alto numa subida contínua");

// Candles de alta forte -> deve dar COMPRA
const upCandles = Array.from({ length: 60 }, (_, i) => {
  const base = 100 + i * 0.8;
  return { t: i, o: base - 0.2, h: base + 0.3, l: base - 0.3, c: base, v: 10 };
});
const up = analyze(upCandles);
assert(up.ok, "análise de alta retornou ok");
assert(up.verdict === VERDICT.BUY, `tendência de alta vira COMPRA (veio ${up.verdict})`);
assert(up.confluence >= 50, "confluência alta numa tendência clara");

// Candles de baixa forte -> deve dar VENDA
const downCandles = Array.from({ length: 60 }, (_, i) => {
  const base = 150 - i * 0.8;
  return { t: i, o: base + 0.2, h: base + 0.3, l: base - 0.3, c: base, v: 10 };
});
const down = analyze(downCandles);
assert(down.verdict === VERDICT.SELL, `tendência de baixa vira VENDA (veio ${down.verdict})`);

// Mercado lateral ruidoso -> tende a ESPERAR
const flatCandles = Array.from({ length: 60 }, (_, i) => {
  const base = 100 + Math.sin(i / 2) * 0.5;
  return { t: i, o: base, h: base + 0.4, l: base - 0.4, c: base + (i % 2 ? 0.05 : -0.05), v: 10 };
});
const flat = analyze(flatCandles);
assert(flat.ok, "análise lateral ok");
assert(typeof flat.risk === "number" && flat.risk >= 0 && flat.risk <= 100, "risco entre 0 e 100");

console.log("\nVeredito alta:", up.verdict, up.confluence + "% conf", up.risk + "% risco");
console.log("Veredito baixa:", down.verdict, down.confluence + "% conf", down.risk + "% risco");
console.log("Veredito lateral:", flat.verdict, flat.confluence + "% conf", flat.risk + "% risco");
