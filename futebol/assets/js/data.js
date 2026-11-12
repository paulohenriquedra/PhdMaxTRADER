// data.js — dados de futebol REAIS e PÚBLICOS (ESPN), sem chave e sem login.
// Mesmo espírito do app de cripto: fonte pública, cálculo no navegador.

export const LEAGUES = [
  { code: "bra.1", label: "Brasileirão" },
  { code: "bra.2", label: "Brasileirão B" },
  { code: "conmebol.libertadores", label: "Libertadores" },
  { code: "conmebol.sudamericana", label: "Sul-Americana" },
  { code: "arg.1", label: "Argentina" },
  { code: "eng.1", label: "Premier League" },
  { code: "eng.2", label: "Championship" },
  { code: "esp.1", label: "La Liga" },
  { code: "ita.1", label: "Serie A" },
  { code: "ger.1", label: "Bundesliga" },
  { code: "fra.1", label: "Ligue 1" },
  { code: "por.1", label: "Portugal" },
  { code: "ned.1", label: "Holanda" },
  { code: "usa.1", label: "MLS" },
  { code: "mex.1", label: "Liga MX" },
  { code: "uefa.champions", label: "Champions" },
  { code: "uefa.europa", label: "Europa League" },
];

const BASE = "https://site.api.espn.com/apis";

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function findEntries(o) {
  if (o && typeof o === "object") {
    if (o.standings && o.standings.entries) return o.standings.entries;
    for (const v of Object.values(o)) { const r = findEntries(v); if (r) return r; }
  }
  if (Array.isArray(o)) for (const v of o) { const r = findEntries(v); if (r) return r; }
  return null;
}

/** Tabela da liga -> [{name, gp, gf, ga}] para calcular força de cada time. */
export async function fetchTable(league) {
  const d = await getJSON(`${BASE}/v2/sports/soccer/${league}/standings`);
  const ents = findEntries(d) || [];
  return ents.map((e) => {
    const s = {};
    (e.stats || []).forEach((x) => { s[x.name] = parseFloat(x.value ?? x.displayValue); });
    return { name: e.team.displayName, abbr: e.team.abbreviation, gp: s.gamesPlayed, gf: s.pointsFor, ga: s.pointsAgainst };
  }).filter((t) => t.gp > 0);
}

/** Forma recente de um time: últimos jogos com gols, mando e data. */
export async function fetchForm(league, teamId) {
  try {
    const d = await getJSON(`${BASE}/site/v2/sports/soccer/${league}/teams/${teamId}/schedule`);
    const played = [];
    for (const e of (d.events || [])) {
      const comp = e.competitions && e.competitions[0]; if (!comp) continue;
      const done = comp.status?.type?.completed || comp.status?.type?.state === "post";
      if (!done) continue;
      const cs = comp.competitors || [];
      const me = cs.find((x) => String(x.team?.id) === String(teamId));
      const opp = cs.find((x) => x !== me);
      if (!me || !opp) continue;
      const gf = parseInt(typeof me.score === "object" ? me.score.displayValue : me.score, 10);
      const ga = parseInt(typeof opp.score === "object" ? opp.score.displayValue : opp.score, 10);
      if (isNaN(gf) || isNaN(ga)) continue;
      played.push({ for: gf, against: ga, home: me.homeAway === "home", date: e.date });
    }
    played.sort((a, b) => new Date(b.date) - new Date(a.date)); // mais novo primeiro
    const lastDate = played[0]?.date || null;
    return { recent: played, lastDate };
  } catch (_) { return { recent: [], lastDate: null }; }
}

/** Jogos (ao vivo, do dia e próximos) da liga. */
export async function fetchMatches(league) {
  const d = await getJSON(`${BASE}/site/v2/sports/soccer/${league}/scoreboard`);
  return (d.events || []).map((e) => {
    const comp = e.competitions[0];
    const cs = comp.competitors;
    const home = cs.find((x) => x.homeAway === "home");
    const away = cs.find((x) => x.homeAway === "away");
    const st = e.status.type;
    // odds da casa, se a ESPN trouxer (nem sempre vem)
    let odds = null;
    if (comp.odds && comp.odds[0]) {
      const o = comp.odds[0];
      odds = {
        home: o.homeTeamOdds?.moneyLine, away: o.awayTeamOdds?.moneyLine,
        details: o.details, overUnder: o.overUnder,
      };
    }
    return {
      id: e.id,
      homeId: home.team.id, awayId: away.team.id,
      home: home.team.displayName, homeAbbr: home.team.abbreviation,
      away: away.team.displayName, awayAbbr: away.team.abbreviation,
      homeScore: home.score, awayScore: away.score,
      state: st.state,               // pre | in | post
      status: st.shortDetail || st.description,
      clock: e.status.displayClock,
      odds,
      date: e.date,
    };
  });
}
