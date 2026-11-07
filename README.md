# Sinalizador de Confluência

Leitura técnica de mercado **em tempo real**, visual e direta: para cada tempo gráfico
(1m · 5m · 15m) a ferramenta mostra um veredito pronto — **COMPRA**, **VENDA** ou **ESPERAR** —
com uma barra de **confluência** (quantos indicadores concordam) e uma barra de **risco**
(volatilidade do momento).

> **Isto não é previsão garantida nem conselho financeiro.** É análise técnica honesta:
> o veredito vem de indicadores reais concordando entre si, nunca de um número inventado.
> O mercado pode virar e o indicador pode errar. Opere só com dinheiro que pode perder.

## Como funciona

Para cada tempo gráfico, 4 indicadores clássicos "votam" em uma direção:

1. **Tendência** — EMA 9 vs EMA 21
2. **RSI (14)** — momento
3. **MACD** — histograma positivo/negativo
4. **Estocástico** — %K vs %D

- 3 ou 4 votos na mesma direção → **COMPRA** ou **VENDA**
- Sem maioria clara → **ESPERAR** (não força entrada)
- **Confluência** = % de indicadores concordando
- **Risco** = volatilidade atual vs. a normal recente (ATR) + nível absoluto + condições "esticadas" (sobrecomprado/sobrevendido)

Os dados vêm da API pública da Binance (sem chave, sem login). O cálculo roda inteiro
no navegador; nada do seu uso é enviado para servidores externos além da própria Binance.

## Rodar localmente

Precisa ser servido por HTTP (o `fetch` à Binance não funciona abrindo o arquivo direto):

```bash
# qualquer servidor estático serve. Exemplos:
python3 -m http.server 8080
# ou
npx serve .
```

Depois abra `http://localhost:8080`.

## Testes

```bash
node tests/engine.test.mjs
```

## Estrutura

```
index.html              página
assets/css/app.css      estilo
assets/js/indicators.js indicadores (funções puras)
assets/js/engine.js     motor de decisão (veredito + risco)
assets/js/data.js       busca de candles na Binance
assets/js/app.js        interface e atualização automática
tests/engine.test.mjs   testes de sanidade
```

## Aviso legal

Ferramenta educativa de apoio à análise técnica. Não garante resultado, não recomenda
operações específicas e não substitui o seu próprio julgamento e gestão de risco.
