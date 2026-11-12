// app.js — lista de jogos com probabilidade real (Poisson) e caça-valor.
import { LEAGUES, fetchTable, fetchMatches, fetchForm } from "./data.js";
import { leagueStrengths, teamRates, expectedGoalsAdv, matchProbs, fairOdd, value } from "./poisson.js";

const $ = (s) => document.querySelector(s);
let league = localStorage.getItem("cv_league") || "bra.1";
let lg = null;           // média de gols da liga
let byName = {};         // nome -> {gp, gf, ga} (temporada)
let formCache = {};      // teamId -> {recent, lastDate}
let matches = [];
let oddCache = {};
let probCache = {};      // mid -> probabilidades (p/ atualizar valor sem re-render)
let openMore = new Set(); // mids com "mais mercados" aberto (mantém entre refresh)

const KEYP = { h: "home", d: "draw", a: "away", o: "over25", b: "bttsYes", "1x": "dc1x", x2: "dcx2", "12": "dc12", o15: "over15", o35: "over35", hm1: "homeM1", am1: "awayM1" };

const daysSince = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 86400000) : null);

function setStatus(txt, cls) { const s = $("#status"); if (s) { $("#status-text").textContent = txt; s.className = "status" + (cls ? " " + cls : ""); } }
const pct = (x) => Math.round(x * 100) + "%";

function renderLeagues() {
  $("#leagues").innerHTML = LEAGUES.map((l) =>
    `<button data-lg="${l.code}" class="${l.code === league ? "on" : ""}">${l.label}</button>`).join("");
}

// Veredito humilde: valor grande = provável erro do modelo, não dinheiro grátis.
function valueVerdict(edge) {
  if (edge == null) return "";
  if (edge >= 0.12) return `<span class="vv warn">⚠️ modelo discorda demais — provável erro do modelo</span>`;
  if (edge >= 0.04) return `<span class="vv good">🟢 leve valor (confira lesão/forma)</span>`;
  if (edge > -0.04) return `<span class="vv mid">⚪ justo (sem valor)</span>`;
  return `<span class="vv bad">🔴 sem valor (a favor da casa)</span>`;
}

function marketRow(nome, prob, key, mid) {
  const fair = fairOdd(prob).toFixed(2);
  const saved = (oddCache[mid] || {})[key] || "";
  const edge = saved ? value(prob, parseFloat(saved)).edge : null;
  return `<div class="mk">
    <span class="mk-n">${nome}</span>
    <span class="mk-p">${pct(prob)}</span>
    <span class="mk-f">justa ${fair}</span>
    <input class="mk-o" data-mid="${mid}" data-key="${key}" inputmode="decimal" placeholder="odd casa" value="${saved}">
    <span class="mk-v">${valueVerdict(edge)}</span>
  </div>`;
}

function cardHTML(m) {
  const hs = byName[m.home], as = byName[m.away];
  const fh = formCache[m.homeId] || { recent: [] }, fa = formCache[m.awayId] || { recent: [] };
  let eg = null, rh = null, ra = null, restH = null, restA = null;
  if (lg && hs && as) {
    rh = teamRates(hs, fh.recent, lg.avgGoals);
    ra = teamRates(as, fa.recent, lg.avgGoals);
    restH = daysSince(fh.lastDate); restA = daysSince(fa.lastDate);
    eg = expectedGoalsAdv(rh, ra, lg.avgGoals, restH, restA);
  }
  const live = m.state === "in";
  const scoreTxt = (m.state !== "pre") ? `<span class="sc">${m.homeScore}-${m.awayScore}</span>` : "";
  if (!eg) {
    return `<div class="card"><div class="ch"><span class="tm">${m.home}</span> ${scoreTxt} <span class="tm">${m.away}</span>
      <span class="st ${live ? "live" : ""}">${m.status}</span></div>
      <div class="noeg">sem dados de força dos times pra este jogo</div></div>`;
  }
  const p = matchProbs(eg.lambdaHome, eg.lambdaAway);
  const mid = m.id;
  probCache[mid] = p;
  const top = p.topScores.map((s) => `${s.i}-${s.j} ${pct(s.p)}`).join(" · ");
  const formBadge = (r, rest) => `${r.formStr ? `<span class="fm">${r.formStr.split("").map((c) => `<i class="f${c}">${c}</i>`).join("")}</span>` : ""}${rest != null ? ` <span class="rest">${rest}d</span>` : ""}`;
  return `<div class="card${live ? " live" : ""}">
    <div class="ch">
      <span class="tm home">${m.home}</span> ${scoreTxt || "<span class='x'>x</span>"} <span class="tm away">${m.away}</span>
      <span class="st ${live ? "live" : ""}">${live ? "🔴 " : ""}${m.status}${live && m.clock ? " " + m.clock : ""}</span>
    </div>
    <div class="form">${m.homeAbbr || "Casa"}: ${formBadge(rh, restH)} &nbsp;·&nbsp; ${m.awayAbbr || "Fora"}: ${formBadge(ra, restA)}</div>
    <div class="xg">Gols esperados: <b>${eg.lambdaHome.toFixed(2)}</b> x <b>${eg.lambdaAway.toFixed(2)}</b> · placar provável <b>${p.topScores[0].i}-${p.topScores[0].j}</b></div>
    <div class="mks">
      ${marketRow("Casa", p.home, "h", mid)}
      ${marketRow("Empate", p.draw, "d", mid)}
      ${marketRow("Fora", p.away, "a", mid)}
      ${marketRow("Over 2.5", p.over25, "o", mid)}
      ${marketRow("Ambas marcam", p.bttsYes, "b", mid)}
    </div>
    <details class="more"${openMore.has(String(mid)) ? " open" : ""} data-more="${mid}">
      <summary>+ mais mercados</summary>
      <div class="mks">
        ${marketRow("Dupla 1X", p.dc1x, "1x", mid)}
        ${marketRow("Dupla X2", p.dcx2, "x2", mid)}
        ${marketRow("Dupla 12", p.dc12, "12", mid)}
        ${marketRow("Over 1.5", p.over15, "o15", mid)}
        ${marketRow("Over 3.5", p.over35, "o35", mid)}
        ${marketRow("Casa -1 (2+)", p.homeM1, "hm1", mid)}
        ${marketRow("Fora -1 (2+)", p.awayM1, "am1", mid)}
      </div>
    </details>
    <div class="scores">Placares prováveis: ${top}</div>
    ${m.state === "pre" ? `<div class="lineup">⚠️ Confira a escalação antes de apostar — lesão/desfalque de última hora o modelo não vê.</div>` : ""}
  </div>`;
}

function render() {
  const box = $("#list");
  // não re-renderiza enquanto você digita uma odd (não perde foco/abertura)
  if (document.querySelector(".mk-o:focus")) return;
  if (!matches.length) { box.innerHTML = `<div class="empty">Sem jogos nesta liga agora. Tente outra.</div>`; return; }
  const byDate = (a, b) => new Date(a.date) - new Date(b.date);
  const live = matches.filter((m) => m.state === "in").sort(byDate);
  const pre = matches.filter((m) => m.state === "pre").sort(byDate);
  const post = matches.filter((m) => m.state === "post").sort((a, b) => new Date(b.date) - new Date(a.date));
  let html = "";
  if (live.length) html += `<div class="sec live">🔴 Ao vivo agora</div>` + live.map(cardHTML).join("");
  if (pre.length) html += `<div class="sec">📅 Hoje / próximos</div>` + pre.map(cardHTML).join("");
  if (post.length) html += `<details class="done"><summary>✓ Encerrados (${post.length})</summary>${post.map(cardHTML).join("")}</details>`;
  box.innerHTML = html || `<div class="empty">Sem jogos nesta liga agora. Tente outra.</div>`;
}

async function refresh() {
  try {
    setStatus("buscando…");
    const [table, ms] = await Promise.all([fetchTable(league), fetchMatches(league)]);
    lg = leagueStrengths(table);
    byName = {}; table.forEach((t) => { byName[t.name] = { gp: t.gp, gf: t.gf, ga: t.ga }; });
    matches = ms;
    render(); // mostra já com o modelo de temporada
    // busca a forma recente de cada time (melhora o modelo) e re-renderiza
    const ids = [...new Set(ms.flatMap((m) => [m.homeId, m.awayId]).filter(Boolean))];
    await Promise.all(ids.map(async (id) => { if (!formCache[id]) formCache[id] = await fetchForm(league, id); }));
    render();
    setStatus("ao vivo · " + new Date().toLocaleTimeString("pt-BR"), "live");
  } catch (e) {
    setStatus("sem dados — tentando de novo", "err");
    setTimeout(refresh, 5000);
  }
}

function bind() {
  $("#leagues").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    league = b.dataset.lg; localStorage.setItem("cv_league", league);
    renderLeagues(); $("#list").innerHTML = `<div class="empty">carregando…</div>`; refresh();
  });
  $("#list").addEventListener("input", (e) => {
    const inp = e.target.closest(".mk-o"); if (!inp) return;
    const mid = inp.dataset.mid, key = inp.dataset.key;
    (oddCache[mid] = oddCache[mid] || {})[key] = inp.value;
    // atualiza SÓ o veredito deste mercado (sem re-render, sem perder foco)
    const p = probCache[mid]; if (!p) return;
    const prob = p[KEYP[key]];
    const edge = inp.value ? (value(prob, parseFloat(inp.value)) || {}).edge : null;
    const vspan = inp.parentElement.querySelector(".mk-v");
    if (vspan) vspan.innerHTML = valueVerdict(edge == null ? null : edge);
  });
  // lembra quais "mais mercados" estão abertos (pra não fechar no refresh)
  $("#list").addEventListener("toggle", (e) => {
    const d = e.target; if (!d.classList || !d.classList.contains("more")) return;
    if (d.open) openMore.add(d.dataset.more); else openMore.delete(d.dataset.more);
  }, true);
}

renderLeagues();
bind();
refresh();
setInterval(refresh, 30000);
