/**
 * Servidor de Giro Estelar: la copa semanal y la medición de retorno.
 *
 * Este archivo son las reglas, sin nada de Cloudflare: recibe una petición web y un "almacén"
 * (dónde se guardan los datos) y devuelve la respuesta. Así se prueba en el computador con un
 * almacén en memoria y corre igual en Cloudflare con la base de datos real.
 *
 *   POST /v1/score    { uid, nick, week, time }   anota el mejor tiempo de la semana y devuelve la tabla
 *   GET  /v1/cup?uid=…                            solo la tabla
 *   POST /v1/visits   { uid, first, days: [] }    días en que se abrió el juego (sin datos personales)
 *   GET  /panel?key=…                             página con cuánta gente vuelve (solo con la clave)
 *   GET  /v1/stats?key=…                          lo mismo, en datos
 */

export const TZ_MIN = -300; // la semana y el día se cuentan con la hora de Colombia
export const TOP = 20; // cuántos se muestran en la tabla
export const MAX_TIME = 7200; // segundos: nadie aguanta más de 2 horas en Supervivencia
const DAY = 86400000;
const two = (n) => String(n).padStart(2, '0');

/* ---------- fechas ---------- */
/* número de día (días desde 1970) según la hora de Colombia */
export const dayOf = (now) => Math.floor((now + TZ_MIN * 60000) / DAY);
export const dayKey = (day) => new Date(day * DAY).toISOString().slice(0, 10);
export const dayFromKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : NaN;
};
/* la semana va de lunes a domingo; su nombre es la fecha del lunes */
export function weekOf(now) {
  const local = now + TZ_MIN * 60000,
    day = Math.floor(local / DAY),
    monday = day - ((day + 3) % 7); // el 1 de enero de 1970 fue jueves
  return { key: dayKey(monday), ends: Math.round(((monday + 7) * DAY - local) / 1000) };
}

/* ---------- lo que se acepta ---------- */
export const cleanNick = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14)
    .trim();
const validUid = (uid) => typeof uid === 'string' && /^[a-z0-9]{16,40}$/.test(uid);

/* ---------- respuestas ---------- */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-private-network': 'true',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
const bad = (why, status = 400) => json({ error: why }, status);
async function body(request) {
  const text = await request.text();
  if (text.length > 4000) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

/* ---------- la copa ---------- */
async function table(store, now, uid) {
  const week = weekOf(now),
    rows = await store.top(week.key, TOP),
    mine = validUid(uid) ? await store.mine(week.key, uid) : null;
  return {
    week: week.key,
    ends: week.ends,
    total: await store.total(week.key),
    top: rows.map((r) => ({ nick: r.nick, time: r.time, ...(r.uid === uid ? { me: true } : {}) })),
    me: mine ? { time: mine.time, rank: 1 + (await store.ahead(week.key, mine.time, mine.at)) } : null,
  };
}
async function postScore(request, store, now) {
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const nick = cleanNick(b.nick),
    time = Math.floor(Number(b.time));
  if (!validUid(b.uid)) return bad('identificador inválido');
  if (nick.length < 2) return bad('apodo inválido');
  if (!(time >= 1 && time <= MAX_TIME)) return bad('tiempo inválido');
  /* una marca de otra semana (guardada sin conexión) ya no cuenta: solo se devuelve la tabla */
  const current = weekOf(now).key;
  if (b.week === current) await store.putScore(current, b.uid, nick, time, now);
  return json({ ...(await table(store, now, b.uid)), saved: b.week === current });
}

/* ---------- medición: días en que se abrió el juego ---------- */
async function postVisits(request, store, now) {
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const first = dayFromKey(b.first),
    today = dayOf(now);
  if (!validUid(b.uid)) return bad('identificador inválido');
  if (!Number.isFinite(first) || first > today + 1 || first < today - 3000) return bad('fecha inválida');
  if (!Array.isArray(b.days) || b.days.length > 400) return bad('días inválidos');
  /* se descartan los días imposibles (un reloj adelantado), sin rechazar el resto */
  const days = [...new Set(b.days)]
    .filter((n) => Number.isInteger(n) && n >= 0 && first + n <= today + 1)
    .map((n) => first + n);
  if (days.length) await store.putVisits(b.uid, first, days);
  return json({ ok: true, n: days.length });
}

/* cuántos de los que llegaron un día volvieron al día siguiente, a los 3, a los 7 y a los 30 */
export async function stats(store, now) {
  const today = dayOf(now),
    week = weekOf(now),
    cohorts = await store.cohorts(60);
  const sum = { n: 0 };
  const STEPS = [1, 3, 7, 30];
  const rows = cohorts.map((c) => {
    const row = { day: dayKey(c.first), n: c.n };
    for (const k of STEPS) row['d' + k] = today >= c.first + k ? c['d' + k] : null; // null = aún no se sabe
    return row;
  });
  /* el total solo cuenta a quienes ya tuvieron tiempo de volver */
  const total = {};
  for (const k of STEPS) {
    const known = rows.filter((r) => r['d' + k] !== null);
    const base = known.reduce((a, r) => a + r.n, 0),
      back = known.reduce((a, r) => a + r['d' + k], 0);
    total['d' + k] = base ? { base, back, pct: Math.round((back / base) * 100) } : null;
  }
  sum.n = rows.reduce((a, r) => a + r.n, 0);
  return {
    today: dayKey(today),
    activeToday: await store.active(today),
    activeYesterday: await store.active(today - 1),
    players: sum.n,
    cupWeek: week.key,
    cupPlayers: await store.total(week.key),
    total,
    rows,
  };
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (back, n) => (back === null ? '<td class="na">—</td>' : `<td>${n ? Math.round((back / n) * 100) : 0}% <small>(${back})</small></td>`);
function panel(s) {
  const tot = (k) => (s.total[k] ? `<b>${s.total[k].pct}%</b><small>${s.total[k].back} de ${s.total[k].base}</small>` : '<b>—</b><small>aún sin datos</small>');
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Giro Estelar · retorno</title>
<style>
body{font:15px system-ui,sans-serif;background:#0a0f24;color:#e8ecff;margin:0;padding:16px;max-width:760px;margin:auto}
h1{font-size:20px}h2{font-size:15px;color:#9aa8cc;margin-top:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.cards div{background:#151c3d;border-radius:12px;padding:12px}
.cards span{display:block;color:#9aa8cc;font-size:12px}.cards b{font-size:24px;display:block}.cards small{color:#9aa8cc}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid #222b55}th:first-child,td:first-child{text-align:left}
th{color:#9aa8cc;font-weight:500;font-size:12px}td small{color:#9aa8cc}.na{color:#55608a}
</style>
<h1>Giro Estelar · ¿la gente vuelve?</h1>
<div class="cards">
<div><span>Jugaron hoy (${esc(s.today)})</span><b>${s.activeToday}</b><small>ayer: ${s.activeYesterday}</small></div>
<div><span>Instalaciones (60 días)</span><b>${s.players}</b></div>
<div><span>En la copa esta semana</span><b>${s.cupPlayers}</b></div>
</div>
<h2>De los que llegaron, cuántos volvieron…</h2>
<div class="cards">
<div><span>al día siguiente</span>${tot('d1')}</div>
<div><span>a los 3 días</span>${tot('d3')}</div>
<div><span>a los 7 días</span>${tot('d7')}</div>
<div><span>a los 30 días</span>${tot('d30')}</div>
</div>
<h2>Por día de llegada</h2>
<table><tr><th>Llegaron el</th><th>Jugadores</th><th>Día 1</th><th>Día 3</th><th>Día 7</th><th>Día 30</th></tr>
${s.rows.map((r) => `<tr><td>${esc(r.day)}</td><td>${r.n}</td>${pct(r.d1, r.n)}${pct(r.d3, r.n)}${pct(r.d7, r.n)}${pct(r.d30, r.n)}</tr>`).join('\n')}
</table>
<p><small>"Día 7" cuenta a quien abrió el juego justo 7 días después de su primer día. Una raya significa que todavía no ha pasado ese tiempo.</small></p>
</html>`;
}

/* ---------- entrada ---------- */
/** env = { store, now, adminKey } */
export async function handle(request, env) {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/+$/, '') || '/',
    { store, now } = env;
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'POST' && path === '/v1/score') return await postScore(request, store, now);
    if (request.method === 'POST' && path === '/v1/visits') return await postVisits(request, store, now);
    if (request.method === 'GET' && path === '/v1/cup') return json(await table(store, now, url.searchParams.get('uid')));
    if (request.method === 'GET' && (path === '/panel' || path === '/v1/stats')) {
      if (!env.adminKey || url.searchParams.get('key') !== env.adminKey) return bad('clave incorrecta', 403);
      const s = await stats(store, now);
      return path === '/panel'
        ? new Response(panel(s), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
        : json(s);
    }
    if (path === '/') return json({ ok: true, name: 'giro-estelar' });
    return bad('no existe', 404);
  } catch (e) {
    return bad('falló el servidor', 500);
  }
}
