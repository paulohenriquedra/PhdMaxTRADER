// poisson.js
// Motor honesto de probabilidade de futebol. A partir da força de ataque e
// defesa de cada time (gols marcados/sofridos vs. a média da liga), estima
// quantos gols cada lado tende a fazer (λ) e, com a distribuição de Poisson,
// calcula a chance REAL de cada resultado. Nada é inventado: sai dos números.

const HOME_ADV = 1.15; // times marcam ~15% mais em casa (ajuste conservador)

function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
// P(exatamente k gols) quando a média é λ
export function poissonPMF(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Força dos times a partir da tabela.
 * teams: [{ name, gp, gf, ga }]  (jogos, gols pró, gols contra)
 * Devolve um mapa name -> { att, def } normalizado pela média da liga.
 */
export function leagueStrengths(teams) {
  const valid = teams.filter((t) => t.gp > 0);
  const avgGF = valid.reduce((s, t) => s + t.gf / t.gp, 0) / valid.length; // média de gols marcados por time/jogo
  const str = {};
  for (const t of valid) {
    str[t.name] = {
      att: (t.gf / t.gp) / avgGF, // >1 ataca mais que a média
      def: (t.ga / t.gp) / avgGF, // >1 sofre mais que a média (defesa pior)
    };
  }
  return { str, avgGoals: avgGF };
}

/** λ esperado de cada lado para um confronto (modelo simples só por temporada). */
export function expectedGoals(home, away, lg) {
  const h = lg.str[home], a = lg.str[away];
  if (!h || !a) return null;
  const lambdaHome = lg.avgGoals * h.att * a.def * HOME_ADV;
  const lambdaAway = lg.avgGoals * a.att * h.def / HOME_ADV;
  return { lambdaHome, lambdaAway };
}

/**
 * Taxas de um time misturando TEMPORADA + FORMA recente, com encolhimento
 * para a média da liga (evita exagerar poucos jogos). Opcionalmente separa
 * mando (casa/fora). recent: [{for, against, home}] do mais novo p/ o antigo.
 */
export function teamRates(season, recent, leagueAvg) {
  const k = 4; // jogos "fantasma" na média da liga (encolhimento)
  const seasonAtt = (season.gf + k * leagueAvg) / (season.gp + k);
  const seasonDef = (season.ga + k * leagueAvg) / (season.gp + k);
  // forma recente com peso exponencial (jogo mais novo pesa mais)
  let wF = 0, wA = 0, wSum = 0, i = 0;
  for (const g of (recent || []).slice(0, 8)) {
    const w = Math.pow(0.82, i);
    wF += w * g.for; wA += w * g.against; wSum += w; i++;
  }
  const recAtt = wSum ? wF / wSum : seasonAtt;
  const recDef = wSum ? wA / wSum : seasonDef;
  // 55% forma recente + 45% temporada
  const att = 0.55 * recAtt + 0.45 * seasonAtt;
  const def = 0.55 * recDef + 0.45 * seasonDef;
  // forma em texto (últimos 5): V/E/D
  const formStr = (recent || []).slice(0, 5).map((g) =>
    g.for > g.against ? "V" : g.for === g.against ? "E" : "D").join("");
  return { att, def, formStr };
}

/** Descanso: poucos dias desde o último jogo cansa (abaixa ataque de leve). */
export function restFactor(daysSinceLast) {
  if (daysSinceLast == null) return 1;
  if (daysSinceLast <= 2) return 0.94;
  if (daysSinceLast === 3) return 0.98;
  return 1; // 4+ dias = descansado
}

/**
 * λ do confronto usando as taxas melhoradas (forma+temporada) e o descanso.
 * homeR/awayR: { att, def } já misturados.  leagueAvg: média de gols/time.
 */
export function expectedGoalsAdv(homeR, awayR, leagueAvg, restHome, restAway) {
  if (!homeR || !awayR || !leagueAvg) return null;
  const hAtt = homeR.att / leagueAvg, hDef = homeR.def / leagueAvg;
  const aAtt = awayR.att / leagueAvg, aDef = awayR.def / leagueAvg;
  const lambdaHome = leagueAvg * hAtt * aDef * HOME_ADV * restFactor(restHome);
  const lambdaAway = leagueAvg * aAtt * hDef / HOME_ADV * restFactor(restAway);
  return { lambdaHome, lambdaAway };
}

/**
 * Probabilidades do confronto a partir dos λ.
 * Monta a matriz de placares (0..maxG) e soma os cenários.
 */
export function matchProbs(lambdaHome, lambdaAway, maxG = 8) {
  const ph = []; const pa = [];
  for (let k = 0; k <= maxG; k++) { ph[k] = poissonPMF(k, lambdaHome); pa[k] = poissonPMF(k, lambdaAway); }
  let home = 0, draw = 0, away = 0;
  let over15 = 0, over25 = 0, over35 = 0, bttsYes = 0;
  let homeM1 = 0, awayM1 = 0; // vencer por 2+ gols (handicap -1)
  const scores = [];
  for (let i = 0; i <= maxG; i++) {
    for (let j = 0; j <= maxG; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i + j >= 2) over15 += p;
      if (i + j >= 3) over25 += p;
      if (i + j >= 4) over35 += p;
      if (i >= 1 && j >= 1) bttsYes += p;
      if (i - j >= 2) homeM1 += p;
      if (j - i >= 2) awayM1 += p;
      scores.push({ i, j, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return {
    home, draw, away,
    dc1x: home + draw, dc12: home + away, dcx2: draw + away, // dupla chance
    over15, under15: 1 - over15,
    over25, under25: 1 - over25,
    over35, under35: 1 - over35,
    bttsYes, bttsNo: 1 - bttsYes,
    homeM1, awayM1, // casa/fora -1 (vence por 2+)
    topScores: scores.slice(0, 4),
    lambdaHome, lambdaAway,
  };
}

/** Odd justa (sem margem) = 1 / probabilidade. */
export const fairOdd = (p) => (p > 0 ? 1 / p : Infinity);

/**
 * Valor de uma aposta: comparar a probabilidade do modelo com a odd da casa.
 * edge > 0 = a casa está pagando MAIS do que o risco real (tem valor).
 * edge = prob * odd - 1.  (ex.: prob 0,5 e odd 2,2 -> 0,5*2,2-1 = +10%)
 */
export function value(prob, odd) {
  if (!odd || odd <= 1) return null;
  const edge = prob * odd - 1;
  const implied = 1 / odd; // o que a casa "acha" (com margem embutida)
  return { edge, implied, modelProb: prob, odd };
}

/** Converte um conjunto de odds 1X2 em probabilidades sem a margem da casa. */
export function noVig(odds) {
  const inv = odds.map((o) => (o > 0 ? 1 / o : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  return s > 0 ? inv.map((x) => x / s) : inv;
}
