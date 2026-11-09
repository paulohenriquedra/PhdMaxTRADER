// app.js — Lista inteligente: para cada cripto, a ação do momento + checklist
// em mini-barras. Tempo real (WebSocket) com fallback de polling. Apoio à
// decisão; o usuário confere e opera.
import { fetchCandles, SYMBOLS } from "./data.js";
import { analyze, VERDICT } from "./engine.js";
import { runBinaryBacktest, evalPayout } from "./backtest.js";
import { ema } from "./indicators.js";

const BROKER = "https://assettbroker.com/app/traderoom";
const REFRESH_MS = 10000;       // re-busca os dados
const BT_EVERY_MS = 60000;      // recalcula o histórico no máx. a cada 60s
const BT_DEPTH = 300;
const NOTIF_THROTTLE = 5 * 60 * 1000;
const ENTRY_LEAD_S = 30;        // avisa "PREPARAR" com N segundos de antecedência
let armedDir = {};              // direção travada perto da virada, por cripto
let day = { date: "", wins: 0, losses: 0, limit: 3 };
let dayLocked = false;
let lastLeadBoundary = 0;       // dedup da notificação de 30s por vela
let pending = loadPending();    // operações aguardando resultado (persistido)
let streak = 0;                 // perdas seguidas
let pauseStreak = +localStorage.getItem("sc_pausestreak") || 2;
let paused = false;             // pausa temporária após sequência de perdas
let history = loadHistory();    // histórico de operações (p/ estudar)

function loadHistory() { try { return JSON.parse(localStorage.getItem("sc_history") || "[]"); } catch (_) { return []; } }
function loadPending() { try { return JSON.parse(localStorage.getItem("sc_pending") || "[]"); } catch (_) { return []; } }
function savePending() { try { localStorage.setItem("sc_pending", JSON.stringify(pending)); } catch (_) {} }
function saveHistory() { try { history = history.slice(-300); localStorage.setItem("sc_history", JSON.stringify(history)); } catch (_) {} }
const LOW_VOL = 35;
const DUR = { "1m": 60000, "5m": 300000, "15m": 900000 };
// Banco de dados (Supabase) — a chave 'anon' é pública por design; o acesso é
// controlado por RLS no servidor. Só a tabela 'operacoes' é liberada.
const SB_URL = "https://mgvbhrfdmfxxdesayhvs.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ndmJocmZkbWZ4eGRlc2F5aHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MDkxNzUsImV4cCI6MjEwODk4NTE3NX0.G8-K4bjbMBTUHssFOmm26eMIlaRv_Qyay2dKSR83260";
let sb = null;
function getSB() {
  if (sb) return sb;
  try { if (window.supabase && window.supabase.createClient) sb = window.supabase.createClient(SB_URL, SB_KEY); } catch (_) {}
  return sb;
}
const deviceId = (() => {
  let d = localStorage.getItem("sc_device");
  if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem("sc_device", d); }
  return d;
})();
const SYMBOL_LABEL = Object.fromEntries(SYMBOLS.map((s) => [s.v, s.label]));

const $ = (s) => document.querySelector(s);
let ovTf = localStorage.getItem("sc_ovtf") || "5m";
let payout = clampPayout(+localStorage.getItem("sc_payout") || 90);
let timer = null, lastBtAt = 0;
let candlesSym = {};   // { SYM: candles[] }
let aCache = {};       // { SYM: resultado do analyze }
let btCacheSym = {};   // { SYM: {n, winRate} }
let prevAlert = {}, lastNotifAt = {}, swReg = null;
let ws = null, wsFails = 0, wsRenderPending = false;

function clampPayout(v) { return Math.max(10, Math.min(100, v || 90)); }
const regIcon = (r) => (r === "tendencia" ? "✅" : r === "parado" ? "😴" : "🌀");
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
const scoreColor = (s) => (s >= 70 ? "var(--buy)" : s >= 40 ? "var(--risk-mid)" : "var(--sell)");

// ---- Ação e pontuações de cada cripto ----
// remMs = quanto falta pra vela fechar; dur = duração da vela.
// O clique certo é NA VIRADA da vela (contador em 0), pra operar a próxima.
function rowAction(a, sym, remMs, dur) {
  if (!a || !a.ok) { armedDir[sym] = null; return { key: 0, txt: "…", cls: "wait", hot: false }; }
  if (a.regime !== "tendencia") { armedDir[sym] = null; return { key: 1, txt: `NÃO OPERAR ${regIcon(a.regime)}`, cls: "no", hot: false }; }
  if (a.verdict === VERDICT.WAIT) { armedDir[sym] = null; return { key: 2, txt: "AGUARDE", cls: "wait", hot: false }; }
  const dir = a.verdict, cls = dir === VERDICT.BUY ? "buy" : "sell";
  const strong = a.confluence >= 75;

  // Trava a direção nos segundos finais (pra não mudar bem na hora do clique).
  if (remMs <= 12000 && strong) armedDir[sym] = dir;
  // Zona de clique: últimos 5s da vela atual OU primeiros 3s da próxima (a virada).
  const clickZone = remMs <= 5000 || remMs >= dur - 3000;
  if (clickZone && armedDir[sym]) {
    const d = armedDir[sym], c = d === VERDICT.BUY ? "buy" : "sell";
    return { key: 5, txt: `⚡ CLIQUE ${d}`, cls: c, hot: true, dir: d };
  }
  // Longe da virada: libera a trava.
  if (remMs < dur - 3000 && remMs > 12000) armedDir[sym] = null;

  if (!strong) return { key: 2, txt: "AGUARDE", cls: "wait", hot: false };
  if (dayLocked) return { key: 1, txt: "🛑 limite do dia", cls: "no", hot: false };
  if (paused) return { key: 1, txt: "⏸️ em pausa", cls: "no", hot: false };
  if (remMs <= ENTRY_LEAD_S * 1000) return { key: 4, txt: `PREPARAR ${dir} · ${fmtCountdown(remMs)}`, cls, hot: false, dir };
  return { key: 3, txt: dir, cls, hot: false, dir };
}

// ---- Controle do dia (gestão de perdas) ----
function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadDay() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem("sc_day") || "null"); } catch (_) {}
  const t = todayStr();
  if (!d || d.date !== t) d = { date: t, wins: 0, losses: 0, limit: (d && d.limit) || +localStorage.getItem("sc_losslimit") || 3 };
  day = d;
  saveDay();
}
function saveDay() { try { localStorage.setItem("sc_day", JSON.stringify(day)); } catch (_) {} }
function renderDay() {
  const dw = $("#dw"), dl = $("#dl"), lock = $("#daylock");
  if (dw) dw.textContent = day.wins;
  if (dl) dl.textContent = day.losses;
  const ds = $("#dstreak"); if (ds) ds.textContent = streak;
  dayLocked = day.losses >= day.limit;
  if (lock) lock.hidden = !dayLocked;
  const pb = $("#daypause"), pm = $("#pausemsg");
  if (pb) pb.hidden = !paused;
  if (pm && paused) pm.textContent = `${streak} perdas seguidas. Dê um tempo, espere o mercado mudar.`;
  const lim = $("#dayLimit"); if (lim && document.activeElement !== lim) lim.value = day.limit;
  const ps = $("#pauseStreak"); if (ps && document.activeElement !== ps) ps.value = pauseStreak;
}
function bindDay() {
  loadDay();
  $("#dayWin")?.addEventListener("click", () => { day.wins++; saveDay(); renderDay(); renderList(); });
  $("#dayLoss")?.addEventListener("click", () => { day.losses++; saveDay(); renderDay(); renderList(); });
  $("#dayReset")?.addEventListener("click", () => { day.wins = 0; day.losses = 0; saveDay(); renderDay(); renderList(); });
  $("#dayLimit")?.addEventListener("change", (e) => {
    day.limit = Math.max(1, Math.min(30, +e.target.value || 3));
    localStorage.setItem("sc_losslimit", day.limit);
    saveDay(); renderDay(); renderList();
  });
  $("#pauseStreak")?.addEventListener("change", (e) => {
    pauseStreak = Math.max(1, Math.min(10, +e.target.value || 2));
    localStorage.setItem("sc_pausestreak", pauseStreak);
    renderDay();
  });
  $("#pauseResume")?.addEventListener("click", resumeTrading);
  renderDay();
}

// ---- Registro automático de resultado (Green/Loss) ----
function flashToast(msg, good) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = "toast show" + (good === true ? " good" : good === false ? " bad" : "");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => { t.className = "toast"; }, 3800);
}
// Clicar em Operar = você ACEITA o sinal. A entrada real é na virada da vela.
// Então o resultado é medido pela própria vela que você vai operar:
// - aceitou no ⚡ CLIQUE (logo após a virada): vale pra vela atual;
// - aceitou antes (PREPARAR/direção): vale pra PRÓXIMA vela (a da virada).
function registerTrade(sym) {
  if (paused) { flashToast("Em pausa — não registrado", false); return; }
  if (dayLocked) { flashToast("Limite do dia atingido — não registrado", false); return; }
  const a = aCache[sym];
  if (!a || !a.ok) { flashToast(`${SYMBOL_LABEL[sym] || sym}: sem dados — não registrado`, false); return; }
  if (a.verdict !== VERDICT.BUY && a.verdict !== VERDICT.SELL) {
    flashToast(`${SYMBOL_LABEL[sym]}: sem direção clara (${a.verdict}) — não registrado`, false);
    return;
  }
  // Proteção: só opera com mercado em tendência (parado/instável = não).
  if (a.regime !== "tendencia") {
    flashToast(`${SYMBOL_LABEL[sym]}: ${(a.regimeLabel || "sem tendência").toLowerCase()} — não registrado`, false);
    return;
  }
  // Proteção: uma operação por vez. Só aceita a próxima quando a anterior
  // resolver — assim a pausa após perdas realmente te segura.
  if (pending.length > 0) {
    flashToast("Espere o resultado da operação anterior (1 por vez)", false);
    return;
  }
  const dur = DUR[ovTf] || 300000, now = Date.now();
  const into = now % dur;
  const open = into <= 3000 ? now - into : now - into + dur; // vela operada (abre em 'open')
  if (pending.some((p) => p.sym === sym && p.open === open)) {
    flashToast(`${SYMBOL_LABEL[sym]} já aceita para essa vela`);
    return;
  }
  const votes = a.votes ? a.votes.map((v) => `${v.nome}=${v.dir}`).join("|") : "";
  pending.push({ sym, dir: a.verdict, open, at: open + dur, tf: ovTf, snap: { conf: a.confluence, regime: a.regime, risk: a.risk, votes } });
  savePending();
  const quando = into <= 3000 ? "vale pra ESTA vela" : "vale pra PRÓXIMA vela — entre na virada";
  flashToast(`✓ Aceito: ${SYMBOL_LABEL[sym]} ${a.verdict} · ${quando}`, true);
}
function recordOutcome(sym, win) {
  if (win) { day.wins++; streak = 0; }
  else { day.losses++; streak++; }
  saveDay();
  flashToast(`${SYMBOL_LABEL[sym] || sym}: ${win ? "GREEN ✓" : "LOSS ✗"}`, win);
  fireNotif(`${SYMBOL_LABEL[sym] || sym}: ${win ? "GREEN ✓" : "LOSS ✗"}`, win ? "Operação registrada." : "Faz parte. Respeite seu limite.", sym);
  if (!win && streak >= pauseStreak) enterPause();
  renderDay();
  const hm = $("#histModal"); if (hm && !hm.hidden) renderHist();
}
async function resolvePending() {
  if (!pending.length) return;
  const now = Date.now();
  let changed = false;
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i], dur = DUR[p.tf] || 300000;
    if (now < p.open + dur) continue; // a vela de resultado ainda não fechou
    let cndl = (candlesSym[p.sym] || []).find((c) => c.t === p.open);
    if (!cndl) {
      // busca a vela exata da operação (ex.: voltou de outra aba / outro tempo)
      try { const c = await fetchCandles(p.sym, p.tf, 200); cndl = c.find((x) => x.t === p.open); } catch (_) {}
    }
    if (!cndl) {
      if (now > p.at + dur * 3) { pending.splice(i, 1); savePending(); } // velho demais: descarta
      continue;
    }
    // Resultado = direção da própria vela operada (abertura → fechamento).
    const win = p.dir === VERDICT.BUY ? cndl.c > cndl.o : cndl.c < cndl.o;
    pending.splice(i, 1);
    savePending();
    const s = p.snap || {};
    const result = win ? "green" : "loss";
    history.push({ t: p.open, sym: p.sym, dir: p.dir, tf: p.tf, result, conf: s.conf, regime: s.regime, risk: s.risk, votes: s.votes });
    saveHistory();
    const client = getSB();
    if (client) {
      client.from("operacoes").insert({
        vela_em: new Date(p.open).toISOString(),
        cripto: p.sym, direcao: p.dir, tempo: p.tf, resultado: result,
        confluencia: s.conf ?? null, regime: s.regime ?? null, volatilidade: s.risk ?? null,
        votos: s.votes ?? null, device: deviceId,
      }).then(() => {}, () => {});
    }
    recordOutcome(p.sym, win);
    changed = true;
  }
  if (changed) renderList();
}
function enterPause() {
  paused = true;
  renderDay();
  flashToast(`⏸️ Pausa: ${streak} perdas seguidas. Respire antes de voltar.`, false);
  fireNotif("⏸️ Pausa recomendada", `${streak} perdas seguidas. Pare um pouco antes de voltar.`, null);
}
function resumeTrading() { paused = false; streak = 0; renderDay(); renderList(); }

// ---- Histórico de operações (para estudar) ----
function wrLabel(arr) {
  const t = arr.length, w = arr.filter((x) => x.result === "green").length;
  return t ? `${((w / t) * 100).toFixed(0)}% (${w}/${t})` : "—";
}
function renderHistRows(rows, fonte) {
  const list = $("#histList"), stats = $("#histStats");
  if (!list || !stats) return;
  if (!rows.length) { stats.innerHTML = ""; list.innerHTML = `<div class="ovempty">Nenhuma operação registrada ainda.</div>`; return; }
  const h = rows;
  const bySym = {}; h.forEach((x) => { (bySym[x.sym] = bySym[x.sym] || []).push(x); });
  const symLines = Object.entries(bySym).sort((a, b) => b[1].length - a[1].length)
    .map(([s, a]) => `<span class="hchip">${s}: ${wrLabel(a)}</span>`).join("");
  const tend = h.filter((x) => x.regime === "tendencia");
  const notend = h.filter((x) => x.regime && x.regime !== "tendencia");
  const c100 = h.filter((x) => x.conf >= 100), c75 = h.filter((x) => x.conf < 100);
  const vb = h.filter((x) => x.risk != null && x.risk < 35);
  const vm = h.filter((x) => x.risk != null && x.risk >= 35 && x.risk < 50);
  const va = h.filter((x) => x.risk != null && x.risk >= 50);
  // lista (mais recentes primeiro)
  list.innerHTML = h.slice().sort((a, b) => b.t - a.t).map((x) => {
    const d = new Date(x.t);
    const hh = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const dd = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    return `<div class="hrow"><span class="htime">${dd} ${hh}</span><span class="hsym">${x.sym}</span>` +
      `<span class="hdir ${x.dir === "COMPRA" ? "buy" : "sell"}">${x.dir}</span><span class="htf">${x.tf}</span>` +
      `<span class="hres ${x.result}">${x.result === "green" ? "GREEN" : "LOSS"}</span>` +
      `<span class="hcond">${x.conf ?? "?"}% ${regIcon(x.regime)}</span></div>`;
  }).join("");
  // RESULTADOS (abaixo da lista)
  stats.innerHTML =
    `<div class="hstat-main">Resultado geral: <b>${wrLabel(h)}</b></div>` +
    `<div class="hstat-row"><b>Por cripto:</b> ${symLines}</div>` +
    `<div class="hstat-row"><b>Condição:</b> <span class="hchip">✅ tendência: ${wrLabel(tend)}</span> <span class="hchip">🌀😴 instável/parado: ${wrLabel(notend)}</span></div>` +
    `<div class="hstat-row"><b>Confluência:</b> <span class="hchip">4/4: ${wrLabel(c100)}</span> <span class="hchip">3/4: ${wrLabel(c75)}</span></div>` +
    `<div class="hstat-row"><b>Volatilidade:</b> <span class="hchip">baixa &lt;35: ${wrLabel(vb)}</span> <span class="hchip">média: ${wrLabel(vm)}</span> <span class="hchip">alta ≥50: ${wrLabel(va)}</span></div>` +
    `<div class="hstat-src">${fonte} · amostra pequena = não confie em padrão ainda</div>`;
}
async function renderHist() {
  const list = $("#histList");
  if (list) list.innerHTML = `<div class="ovempty">carregando…</div>`;
  const client = getSB();
  if (client) {
    try {
      const { data, error } = await client.from("operacoes").select("*").order("criado_em", { ascending: false }).limit(300);
      if (!error && data) {
        const rows = data.map((r) => ({
          t: (r.vela_em ? new Date(r.vela_em) : new Date(r.criado_em)).getTime(),
          sym: r.cripto, dir: r.direcao, tf: r.tempo, result: r.resultado,
          conf: r.confluencia, regime: r.regime, risk: r.volatilidade, votes: r.votos,
        }));
        renderHistRows(rows, "☁️ banco de dados (Supabase)");
        return;
      }
    } catch (_) {}
  }
  renderHistRows(history.slice(), "📱 salvo neste aparelho (banco offline)");
}
function openHist() { const m = $("#histModal"); if (m) { m.hidden = false; renderHist(); } }
function closeHist() { const m = $("#histModal"); if (m) m.hidden = true; }
async function clearHist() {
  if (!confirm("Apagar todo o histórico de operações?")) return;
  history = []; saveHistory();
  const client = getSB();
  if (client) { try { await client.from("operacoes").delete().neq("id", 0); } catch (_) {} }
  renderHist();
}
function bindHist() {
  $("#histOpen")?.addEventListener("click", openHist);
  $("#hist-close")?.addEventListener("click", closeHist);
  $("#histModal")?.addEventListener("click", (e) => { if (e.target.id === "histModal") closeHist(); });
  $("#histClear")?.addEventListener("click", clearHist);
}

// ---- Notificação 30s antes da virada da vela ----
function checkLeadNotification() {
  if (!alertsOn() || dayLocked) return;
  const dur = DUR[ovTf] || 300000;
  const now = Date.now();
  const rem = dur - (now % dur);
  const boundary = Math.round((now + rem) / 1000); // próximo fechamento (s)
  if (rem <= ENTRY_LEAD_S * 1000 && rem > (ENTRY_LEAD_S - 3) * 1000 && boundary !== lastLeadBoundary) {
    lastLeadBoundary = boundary;
    const elig = SYMBOLS.map((s) => aCache[s.v])
      .filter((a) => a && a.ok && a.confluence >= 100 && a.risk < LOW_VOL && a.regime === "tendencia")
      .sort((x, y) => x.risk - y.risk);
    if (elig.length) {
      const a = elig[0];
      fireNotif(`⏰ 30s · ${SYMBOL_LABEL[a.sym]} ${a.verdict}`, `Prepare e clique na virada (${ovTf}, expiração ${ovTf})`, a.sym);
    }
  }
}

function scores(a) {
  // Conf agora inclui a condição do mercado: só vale quando há tendência.
  // Parado/instável -> Conf baixo e mostra o ícone, em vez de % enganoso.
  const alive = a.regime === "tendencia";
  const conf = alive ? a.confluence : (a.regime === "instavel" ? 30 : 12);
  const confVal = alive ? a.confluence + "%" : regIcon(a.regime);
  // Vol só fica "bom" (verde) com tendência; parado/instável = baixo/vermelho.
  const vol = alive ? (a.risk < 35 ? 90 : a.risk < 65 ? 55 : 20) : (a.regime === "instavel" ? 30 : 12);
  // Mov: força do movimento (amplitude da vela vs piso mínimo). Mais = mais
  // confiável (bate mais com a corretora); pouco = fio de cabelo.
  const ratio = a.minMove ? (a.movePct || 0) / a.minMove : 0;
  // ratio < 1 = abaixo do piso operável (vira "parado" e o Operar é bloqueado).
  const mov = ratio >= 1.6 ? 90 : ratio >= 1.0 ? 55 : 18;
  const movVal = (a.movePct || 0).toFixed(2) + "%";
  const bt = btCacheSym[a.sym];
  let hist = 50, histVal = "—";
  if (bt) {
    const ev = evalPayout(bt.winRate, bt.n, payout / 100);
    const m = (bt.winRate - ev.breakeven) * 100;
    hist = m >= 1.5 ? 90 : m >= -1.5 ? 50 : 20;
    histVal = `${m >= 0 ? "+" : "−"}${Math.abs(m).toFixed(0)}%`;
  }
  return { conf, confVal, vol, mov, movVal, hist, histVal };
}

function miniBar(label, score, val) {
  return `<div class="mbar"><span class="mbl">${label}</span>` +
    `<span class="mbt"><i style="width:${score}%;background:${scoreColor(score)}"></i></span>` +
    `<span class="mbv">${val}</span></div>`;
}

function renderList() {
  const box = $("#mlist");
  if (!box) return;
  const now = Date.now();
  const dur = DUR[ovTf] || 300000;
  const rem = dur - (now % dur);
  const remTxt = fmtCountdown(rem);

  const rows = SYMBOLS.map((s) => {
    const a = aCache[s.v];
    return { v: s.v, label: s.label, a, act: rowAction(a, s.v, rem, dur) };
  }).filter((r) => r.a && r.a.ok);

  if (!rows.length) { box.innerHTML = `<div class="ovempty">carregando mercado…</div>`; return; }

  // ordena: AGORA > direção pronta > aguarde > não operar; depois por qualidade
  rows.forEach((r) => {
    const sc = scores(r.a);
    r.sc = sc;
    r.q = (sc.conf + sc.vol + sc.mov + sc.hist) / 4;
  });
  rows.sort((x, y) => y.act.key - x.act.key || y.q - x.q);

  box.innerHTML = rows.map((r) => {
    const a = r.a, sc = r.sc, act = r.act;
    const operar = `<a class="mgo${act.hot ? " hot" : ""}" href="${BROKER}" target="_blank" rel="noopener noreferrer">Operar ↗</a>`;
    return `<div class="mrow ${act.cls}${act.hot ? " hot" : ""}" data-sym="${r.v}">
      <div class="mrow-top">
        <span class="msym">${r.label}</span>
        <span class="maction ${act.cls}">${act.txt} <span class="mclk">${remTxt}</span></span>
        ${operar}
      </div>
      <div class="mbars">
        ${miniBar("Conf", sc.conf, sc.confVal)}
        ${miniBar("Vol", sc.vol, a.risk + "%")}
        ${miniBar("Mov", sc.mov, sc.movVal)}
        ${miniBar("Hist", sc.hist, sc.histVal)}
      </div>
    </div>`;
  }).join("");
}

function setStatus(state, text) {
  $("#status").className = "status" + (state ? " " + state : "");
  $("#status-text").textContent = text;
}

function tickClocks() {
  const now = Date.now();
  const ov = $("[data-ovclock]");
  if (ov) {
    const d = DUR[ovTf] || 300000;
    const r = d - (now % d);
    ov.textContent = "vela fecha em " + fmtCountdown(r);
    ov.classList.toggle("soon", r <= 10000);
  }
  renderList(); // re-renderiza (8 linhas) p/ atualizar contador e estado "AGORA"
  checkLeadNotification();
}

// ---- Dados ----
async function refresh() {
  try {
    let source = null;
    await Promise.all(
      SYMBOLS.map(async (s) => {
        try {
          const candles = await fetchCandles(s.v, ovTf, BT_DEPTH);
          if (candles.source) source = candles.source;
          candlesSym[s.v] = candles;
          const a = analyze(candles);
          a.sym = s.v;
          aCache[s.v] = a;
        } catch (_) { /* mantém cache anterior desta cripto */ }
      })
    );
    maybeBacktest();
    resolvePending();
    renderList();
    updateOpenChart();
    checkNotifications();
    setStatus("live", `${source || "ao vivo"} · ${new Date().toLocaleTimeString("pt-BR")}`);
    if (!ws) connectWS();
  } catch (err) {
    setStatus("err", "sem dados — tentando de novo");
  }
}

function maybeBacktest() {
  if (Date.now() - lastBtAt < BT_EVERY_MS && Object.keys(btCacheSym).length) return;
  for (const s of SYMBOLS) {
    const c = candlesSym[s.v];
    if (!c) continue;
    try {
      const b = runBinaryBacktest(c, { expiryBars: 1, payout: payout / 100 });
      btCacheSym[s.v] = { n: b.n, winRate: b.winRate };
    } catch (_) {}
  }
  lastBtAt = Date.now();
}

// ---- WebSocket (tempo real) de todas as criptos no tempo escolhido ----
function closeWS() { if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; } }
function connectWS() {
  if (typeof WebSocket === "undefined") return;
  closeWS();
  const tf = ovTf;
  const streams = SYMBOLS.map((s) => s.v.toLowerCase() + "@kline_" + tf).join("/");
  let sock;
  try { sock = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); }
  catch (_) { return; }
  ws = sock;
  sock.onopen = () => { wsFails = 0; };
  sock.onmessage = (ev) => {
    if (tf !== ovTf) return;
    try {
      const msg = JSON.parse(ev.data).data;
      const sym = msg.s, k = msg.k;
      const arr = candlesSym[sym];
      if (!arr || !arr.length) return;
      const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const last = arr[arr.length - 1];
      if (c.t === last.t) arr[arr.length - 1] = c;
      else if (c.t > last.t) { arr.push(c); if (arr.length > BT_DEPTH) arr.shift(); }
      else return;
      const a = analyze(arr); a.sym = sym; aCache[sym] = a;
      scheduleWsRender();
    } catch (_) {}
  };
  sock.onerror = () => { try { sock.close(); } catch (_) {} };
  sock.onclose = () => {
    if (tf !== ovTf) return;
    wsFails++;
    if (wsFails <= 3) setTimeout(() => { if (tf === ovTf) connectWS(); }, 3000);
  };
}
function scheduleWsRender() {
  if (wsRenderPending) return;
  wsRenderPending = true;
  setTimeout(() => {
    wsRenderPending = false;
    try { resolvePending(); renderList(); updateOpenChart(); checkNotifications(); setStatus("live", `tempo real · ${new Date().toLocaleTimeString("pt-BR")}`); } catch (_) {}
  }, 300);
}

// ---- Notificações: 100% confluência + vol baixa + mercado com tendência ----
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  // quando um service worker novo assume, recarrega uma vez p/ pegar a versão nova
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    swReg = reg;
    if (reg.update) reg.update(); // checa atualização a cada carga
  }).catch(() => {});
}
function alertsOn() {
  return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("sc_alerts") === "1";
}
function updateAlertsBtn() {
  const btn = $("#alerts"); if (!btn) return;
  const on = alertsOn();
  btn.classList.toggle("on", on);
  btn.textContent = on ? "🔔 Alertas ativos" : "🔔 Ativar alertas";
}
function bindAlerts() {
  const btn = $("#alerts"); if (!btn) return;
  if (typeof Notification === "undefined") { btn.disabled = true; btn.textContent = "🔔 Sem suporte"; return; }
  btn.addEventListener("click", async () => {
    if (alertsOn()) { localStorage.setItem("sc_alerts", "0"); updateAlertsBtn(); return; }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem("sc_alerts", "1");
      fireNotif("Alertas ativados", "Aviso quando uma cripto tiver 100% de confluência, volatilidade baixa e tendência.", null);
    }
    updateAlertsBtn();
  });
  updateAlertsBtn();
}
function fireNotif(title, body, sym) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const opts = { body, tag: sym || "sc", renotify: true, data: { sym } };
    if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (_) {}
}
function checkNotifications() {
  const now = Date.now();
  for (const s of SYMBOLS) {
    const a = aCache[s.v];
    if (!a || !a.ok) continue;
    const eligible = a.confluence >= 100 && a.risk < LOW_VOL && a.regime === "tendencia";
    const was = prevAlert[s.v] || false;
    prevAlert[s.v] = eligible;
    if (!alertsOn()) continue;
    if (eligible && !was && now - (lastNotifAt[s.v] || 0) > NOTIF_THROTTLE) {
      lastNotifAt[s.v] = now;
      fireNotif(`${s.label} · 100% + vol baixa`, `${a.verdict} no ${ovTf} (vol ${a.risk}%) — toque para abrir`, s.v);
    }
  }
}

// ---- Controles ----
function bindOvTf() {
  const box = $("#ovtf"); if (!box) return;
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tf === ovTf);
    b.addEventListener("click", () => {
      ovTf = b.dataset.tf;
      localStorage.setItem("sc_ovtf", ovTf);
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.tf === ovTf));
      candlesSym = {}; aCache = {}; btCacheSym = {}; lastBtAt = 0;
      closeWS(); wsFails = 0; closeChart();
      $("#mlist").innerHTML = `<div class="ovempty">carregando ${ovTf}…</div>`;
      refresh();
    });
  });
}
function bindPayout() {
  const inp = $("#payout"); if (!inp) return;
  inp.value = payout;
  inp.addEventListener("change", () => {
    payout = clampPayout(+inp.value);
    inp.value = payout;
    localStorage.setItem("sc_payout", payout);
    renderList(); // histórico/margem dependem do payout
  });
}

// ---- Gráfico de velas (Lightweight Charts) ----
let chart = null, candleSeries = null, ema9S = null, ema21S = null, openChartSym = null;
const toBar = (x) => ({ time: Math.floor(x.t / 1000), open: x.o, high: x.h, low: x.l, close: x.c });
function emaBars(c, p) {
  const e = ema(c.map((x) => x.c), p);
  const out = [];
  for (let i = 0; i < c.length; i++) if (e[i] != null) out.push({ time: Math.floor(c[i].t / 1000), value: e[i] });
  return out;
}
function openChart(sym) {
  const modal = $("#chartModal"), el = $("#chart");
  openChartSym = sym;
  $("#chart-title").textContent = `${SYMBOL_LABEL[sym] || sym} · ${ovTf}`;
  const op = $("#chart-op"); if (op) op.href = BROKER;
  modal.hidden = false;
  if (typeof LightweightCharts === "undefined") {
    $("#chart-foot").textContent = "gráfico indisponível (biblioteca não carregou)";
    return;
  }
  if (chart) { try { chart.remove(); } catch (_) {} chart = null; }
  el.innerHTML = "";
  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: "#141b26" }, textColor: "#8a9bb0", fontFamily: "Inter, sans-serif" },
    grid: { vertLines: { color: "#1a2230" }, horzLines: { color: "#1a2230" } },
    rightPriceScale: { borderColor: "#223042" },
    timeScale: { borderColor: "#223042", timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false });
  ema9S = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ema21S = chart.addLineSeries({ color: "#f0b429", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const c = candlesSym[sym] || [];
  candleSeries.setData(c.map(toBar));
  ema9S.setData(emaBars(c, 9));
  ema21S.setData(emaBars(c, 21));
  chart.timeScale().fitContent();
}
function updateOpenChart() {
  if (!chart || !openChartSym || !candleSeries) return;
  const c = candlesSym[openChartSym];
  if (!c || !c.length) return;
  try {
    candleSeries.update(toBar(c[c.length - 1]));
    const cl = c.map((x) => x.c), t = Math.floor(c[c.length - 1].t / 1000);
    const e9 = ema(cl, 9).at(-1), e21 = ema(cl, 21).at(-1);
    if (e9 != null) ema9S.update({ time: t, value: e9 });
    if (e21 != null) ema21S.update({ time: t, value: e21 });
  } catch (_) {}
}
function closeChart() {
  const modal = $("#chartModal"); if (modal) modal.hidden = true;
  openChartSym = null;
  if (chart) { try { chart.remove(); } catch (_) {} chart = null; candleSeries = ema9S = ema21S = null; }
}
function bindChart() {
  $("#chart-close")?.addEventListener("click", closeChart);
  $("#chartModal")?.addEventListener("click", (e) => { if (e.target.id === "chartModal") closeChart(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeChart(); });
  $("#mlist")?.addEventListener("click", (e) => {
    const row = e.target.closest(".mrow");
    if (e.target.closest(".mgo")) { if (row) registerTrade(row.dataset.sym); return; } // Operar: registra e abre o link
    if (row && row.dataset.sym) openChart(row.dataset.sym);
  });
  window.addEventListener("resize", () => {
    if (chart) { const el = $("#chart"); chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); }
  });
}

function start() {
  bindOvTf();
  bindPayout();
  bindAlerts();
  bindChart();
  bindDay();
  bindHist();
  registerSW();
  refresh();
  tickClocks();
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  setInterval(tickClocks, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(timer); closeWS(); }
    else { refresh(); timer = setInterval(refresh, REFRESH_MS); }
  });
}

start();
