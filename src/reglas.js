/**
 * Servidor de Astrion Space: la copa semanal y la medición de retorno.
 *
 * Este archivo son las reglas, sin nada de Cloudflare: recibe una petición web y un "almacén"
 * (dónde se guardan los datos) y devuelve la respuesta. Así se prueba en el computador con un
 * almacén en memoria y corre igual en Cloudflare con la base de datos real.
 *
 *   POST /v1/run      { uid }                     tiquete de partida: se pide al empezar una Supervivencia (tiquetes.js)
 *   POST /v1/score    { uid, nick, week, time, ticket }   anota el mejor tiempo de la semana y devuelve la tabla.
 *                                                 Sin un tiquete válido, o si el tiempo no cabe en lo que pasó
 *                                                 desde que se pidió, no se anota: { saved: false, refused: 'ticket' }
 *   GET  /v1/cup?uid=…                            solo la tabla
 *   POST /v1/duel       { uid, nick, seed, time }   crea un reto y devuelve su código
 *   GET  /v1/duel?code=…&uid=…                    la pista de un reto y su tabla
 *   POST /v1/duel/score { code, uid, nick, time }   anota un tiempo en un reto
 *   POST /v1/visits   { uid, first, days: [] }    días en que se abrió el juego (sin datos personales)
 *   GET  /panel?key=…                             página con cuánta gente vuelve (solo con la clave)
 *   GET  /v1/stats                                lo mismo, en datos
 *   GET  /v1/admin/review                         la copa de la semana con señales de trampa, y los vetados
 *   POST /v1/admin/ban   { uid }                  saca a un tramposo de las tablas y no le guarda más marcas
 *   POST /v1/admin/unban { uid }                  le levanta el veto (y da por bueno lo que tenga su cuenta: tope.js)
 *   /v1/auth/…, /v1/save, /v1/account             cuentas y progreso guardado: ver cuentas.js
 *   /v1/purchase, /v1/purchase/done               compras verificadas con Google Play: ver compras.js
 *
 * Lo de administración pide la clave: en la cabecera `Authorization: Bearer <clave>` o, para
 * abrir el panel en el navegador, en la dirección (?key=).
 *
 * Todo lo que escribe sin pedir cuenta (marcas, retos, medición) tiene un tope por cliente
 * (limites.js), y cleanup() bota cada día lo que ya no sirve: así nadie puede llenar la base.
 */
import { purchases } from './compras.js';
import { accounts } from './cuentas.js';
import { UNIT, clientKey, tooMany } from './limites.js';
import { privacyResponse } from './privacidad.js';
import { CORS, bad, body, json, sameSecret, validUid } from './respuestas.js';
import { SLACK, ticketFor, ticketStart } from './tiquetes.js';
import { audit } from './tope.js';

export const TZ_MIN = -300; // la semana y el día se cuentan con la hora de Colombia
export const TOP = 20; // cuántos se muestran en la tabla
export const MAX_TIME = 7200; // segundos: nadie aguanta más de 2 horas en Supervivencia
export const MAX_DAYS = 60; // días de medición que se aceptan en un solo envío
export const KEEP_WEEKS = 8; // semanas de copa que se conservan
export const KEEP_DUEL_DAYS = 30; // un reto sin marcas nuevas en este tiempo se borra
export const KEEP_VISIT_DAYS = 180; // días de medición que se conservan (el panel mira hasta PANEL_DAYS + 30)
export const PANEL_DAYS = 150; // el panel muestra a quienes llegaron en estos días
export const LATE = 3600; // segundos: una marca que llega más de una hora después de terminada se señala
export const FAR = 3; // una marca este número de veces por encima de la mediana de la tabla se señala
const CACHE_LIFE = 30000; // cuánto se recuerda el total de una tabla y el puesto de un jugador
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
  (typeof text === 'string' ? text : '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14)
    .trim();

/* ---------- las tablas ----------
   Todas las tablas se guardan igual: una clave, y el mejor tiempo de cada jugador bajo esa clave.
   La copa de la semana usa como clave la fecha de su lunes; un reto, "r" más su código.

   Contar cuántos hay en una tabla (y cuántos van por delante de un jugador) recorre la tabla:
   con mucha gente, hacerlo en cada petición sale caro. Por eso se recuerda unos segundos
   (env.cache, la memoria del servidor; en las pruebas no hay y se cuenta siempre). Cuando alguien
   anota una marca en una tabla (fresh), lo recordado de esa tabla deja de valer: quien anota ve
   sus números recién contados, y los demás también en su siguiente consulta. */
async function remembered(env, key, count) {
  const cache = env.cache;
  if (!cache) return count();
  const hit = cache.get(key);
  if (hit && hit.until > env.now) return hit.value;
  const value = await count();
  if (cache.size > 5000) cache.clear();
  cache.set(key, { value, until: env.now + CACHE_LIFE });
  return value;
}
async function board(env, key, uid, fresh) {
  const { store, cache } = env;
  /* cada tabla lleva la cuenta de sus cambios: lo recordado antes del último ya no se encuentra */
  if (cache && fresh) cache.set('v|' + key, (cache.get('v|' + key) || 0) + 1);
  const v = cache ? cache.get('v|' + key) || 0 : 0,
    rows = await store.top(key, TOP),
    mine = validUid(uid) ? await store.mine(key, uid) : null,
    rank = mine ? 1 + (await remembered(env, `a|${key}|${v}|${uid}|${mine.time}|${mine.at}`, () => store.ahead(key, mine.time, mine.at))) : 0,
    total = await remembered(env, `t|${key}|${v}`, () => store.total(key));
  return {
    /* un total recordado puede ir un poco atrás: nunca menos que lo que ya se ve */
    total: Math.max(total, rows.length, rank),
    top: rows.map((r) => ({ nick: r.nick, time: r.time, ...(r.uid === uid ? { me: true } : {}) })),
    me: mine ? { time: mine.time, rank } : null,
  };
}
/* lo que trae una marca: devuelve { nick, time } o el texto del error */
function scoreOf(b) {
  const nick = cleanNick(b.nick),
    time = typeof b.time === 'number' ? Math.floor(b.time) : NaN;
  if (!validUid(b.uid)) return 'identificador inválido';
  if (nick.length < 2) return 'apodo inválido';
  if (!(time >= 1 && time <= MAX_TIME)) return 'tiempo inválido';
  return { nick, time };
}
const SLOW = () => bad('demasiados intentos, espera unos minutos', 429);

/* ---------- la copa de la semana ---------- */
async function table(env, uid, fresh) {
  const week = weekOf(env.now);
  return { week: week.key, ends: week.ends, ...(await board(env, week.key, uid, fresh)) };
}
/* El tiquete de partida (tiquetes.js). No toca la base de datos: no hay nada que llenar. Si está
   la capa de límites de la plataforma, frena a quien los pida a chorros. */
async function postRun(request, env) {
  const b = await body(request);
  if (!b || !validUid(b.uid)) return bad('identificador inválido');
  if (!env.secret) return bad('copa sin configurar', 503);
  if (env.gate && !(await env.gate('run:' + clientKey(env.ip) + ':' + b.uid))) return SLOW();
  return json({ ticket: await ticketFor(env.secret, b.uid, env.now) });
}
async function postScore(request, env) {
  const { store, now } = env;
  if (await tooMany(env, 'score')) return SLOW();
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const sc = scoreOf(b);
  if (typeof sc === 'string') return bad(sc);
  const week = weekOf(now);
  /* nadie puede haber aguantado más de lo que lleva la semana (con un minuto de holgura) */
  if (sc.time > 7 * 86400 - week.ends + 60) return bad('tiempo inválido');
  /* la partida tiene que haber empezado con un tiquete de este servidor, y el tiempo caber en
     lo que pasó desde entonces: nadie anota 20 minutos sin que hayan pasado 20 minutos */
  const started = await ticketStart(env.secret, b.uid, b.ticket, now),
    fits = started > 0 && sc.time <= (now - started) / 1000 + SLACK;
  /* una marca de otra semana (guardada sin conexión) ya no cuenta, ni la de un vetado: solo se devuelve la tabla */
  const saved = fits && b.week === week.key && !(await store.banned(b.uid));
  if (saved) await store.putScore(week.key, b.uid, sc.nick, sc.time, now, started);
  return json({ ...(await table(env, b.uid, saved)), saved, ...(fits ? {} : { refused: 'ticket' }) });
}

/* ---------- retos entre amigos ----------
   Un reto es una pista (su semilla) con tabla propia. Quien lo crea juega la pista, recibe un
   código de 6 letras y se lo manda a sus amigos; ellos juegan esa misma pista contra su tiempo. */
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I/L, que se confunden al dictarlos
export const cleanCode = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
function randomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (x) => LETTERS[x % LETTERS.length]).join('');
}
const duelView = async (env, d, uid, fresh) => ({
  code: d.code,
  seed: d.seed,
  by: d.nick,
  ...(await board(env, 'r' + d.code, uid, fresh)),
});
/* crear un reto: llega la semilla de la pista y el tiempo de quien lo crea */
async function postDuel(request, env) {
  const { store, now } = env;
  if (await tooMany(env, 'duel')) return SLOW();
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const sc = scoreOf(b);
  if (typeof sc === 'string') return bad(sc);
  if (!Number.isInteger(b.seed) || b.seed < 0 || b.seed > 4294967295) return bad('pista inválida');
  if (await store.banned(b.uid)) return bad('no se pudo crear el reto', 403);
  /* el código sale al azar; si ya existe (casi imposible), se prueba con otro */
  for (let tries = 0; tries < 6; tries++) {
    const code = (env.code || randomCode)();
    if (!(await store.putDuel(code, b.seed, b.uid, sc.nick, now))) continue;
    await store.putScore('r' + code, b.uid, sc.nick, sc.time, now);
    return json(await duelView(env, await store.duel(code), b.uid, true));
  }
  return bad('no se pudo crear el reto', 500);
}
/* jugar un reto que ya existe: se anota el tiempo y se devuelve su tabla */
async function postDuelScore(request, env) {
  const { store, now } = env;
  if (await tooMany(env, 'duelScore')) return SLOW();
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const sc = scoreOf(b);
  if (typeof sc === 'string') return bad(sc);
  const d = await store.duel(cleanCode(b.code));
  if (!d) return bad('ese reto no existe', 404);
  const saved = !(await store.banned(b.uid));
  if (saved) await store.putScore('r' + d.code, b.uid, sc.nick, sc.time, now);
  return json(await duelView(env, d, b.uid, saved));
}
async function getDuel(url, env) {
  const d = await env.store.duel(cleanCode(url.searchParams.get('code')));
  return d ? json(await duelView(env, d, url.searchParams.get('uid'))) : bad('ese reto no existe', 404);
}

/* ---------- medición: días en que se abrió el juego ---------- */
async function postVisits(request, env) {
  const { store, now } = env;
  if (await tooMany(env, 'visits')) return SLOW();
  const b = await body(request);
  if (!b) return bad('datos ilegibles');
  const first = dayFromKey(b.first),
    today = dayOf(now);
  if (!validUid(b.uid)) return bad('identificador inválido');
  if (!Number.isFinite(first) || first > today + 1 || first < today - 3000) return bad('fecha inválida');
  if (!Array.isArray(b.days) || b.days.length > 400) return bad('días inválidos');
  /* se descartan los días imposibles (un reloj adelantado) y los que ya no se conservan, sin
     rechazar el resto; y de un envío se anotan como mucho los MAX_DAYS más recientes (el juego
     manda uno o dos: solo trae muchos quien pasó meses sin conexión) */
  const days = [...new Set(b.days)]
    .filter((n) => Number.isInteger(n) && n >= 0 && first + n <= today + 1 && first + n > today - KEEP_VISIT_DAYS)
    .map((n) => first + n)
    .sort((a, c) => a - c)
    .slice(-MAX_DAYS);
  if (days.length) await store.putVisits(b.uid, first, days);
  return json({ ok: true, n: days.length });
}

/* cuántos de los que llegaron un día volvieron al día siguiente, a los 3, a los 7 y a los 30 */
export async function stats(store, now) {
  const today = dayOf(now),
    week = weekOf(now),
    cohorts = await store.cohorts(60, today - PANEL_DAYS);
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
/* ---------- revisión: la copa de la semana con señales de trampa ----------
   Ninguna señal prueba nada por sí sola: es una lista para que una persona mire y decida.
     lejos   = el tiempo está muy por encima de lo normal en la tabla (FAR veces la mediana)
     tarde   = la marca llegó mucho después de terminada la partida (más de LATE segundos):
               es lo que deja quien pide el tiquete, espera y manda un tiempo inventado... y
               también quien terminó sin conexión
     tope    = el tiempo es exactamente el máximo que el servidor acepta */
export async function review(store, now) {
  const week = weekOf(now),
    rows = await store.top(week.key, TOP),
    times = rows.map((r) => r.time).sort((a, b) => a - b),
    median = times.length ? times[Math.floor(times.length / 2)] : 0;
  return {
    week: week.key,
    median,
    rows: rows.map((r, i) => {
      const late = r.started ? Math.max(0, Math.round((r.at - r.started) / 1000 - r.time)) : null,
        flags = [];
      if (rows.length >= 5 && r.time >= FAR * median) flags.push('lejos');
      if (late !== null && late > LATE) flags.push('tarde');
      if (r.time >= MAX_TIME) flags.push('tope');
      return { rank: i + 1, uid: r.uid, nick: r.nick, time: r.time, at: r.at, late, flags };
    }),
    bans: await store.bans(100),
  };
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (secs) => (secs >= 3600 ? Math.floor(secs / 3600) + ' h ' : '') + Math.floor((secs % 3600) / 60) + ' min ' + (secs % 60) + ' s';
const WHY = { admin: 'vetado a mano', monedas: 'monedas o piezas que no cuadran', 'sin anuncios': '«sin anuncios» sin compra' };
const FLAG = { lejos: 'muy por encima', tarde: 'llegó tarde', tope: 'justo en el máximo' };
function reviewHtml(r) {
  const row = (x) =>
    `<tr${x.flags.length ? ' class="odd"' : ''}><td>${x.rank}. ${esc(x.nick)}</td><td>${esc(clock(x.time))}</td>` +
    `<td>${x.late === null ? '—' : esc(clock(x.late))}</td><td>${x.flags.map((f) => `<span class="tag">${esc(FLAG[f] || f)}</span>`).join(' ') || '<small>nada raro</small>'}</td>` +
    `<td><button data-do="ban" data-uid="${esc(x.uid)}">Vetar</button></td></tr>`;
  const ban = (b) =>
    `<tr><td><code>${esc(b.uid)}</code></td><td>${esc(WHY[b.why] || b.why)}</td><td>${esc(new Date(b.at).toISOString().slice(0, 16).replace('T', ' '))}</td>` +
    `<td><button data-do="unban" data-uid="${esc(b.uid)}">Levantar</button></td></tr>`;
  return `<h2>Copa de esta semana (${esc(r.week)}): para revisar</h2>
${
  r.rows.length
    ? `<table><tr><th>Jugador</th><th>Tiempo</th><th>Llegó después de</th><th>Señales</th><th></th></tr>
${r.rows.map(row).join('\n')}
</table>
<p><small>Lo normal en la tabla: ${esc(clock(r.median))}. «Llegó después de» es cuánto pasó entre que terminó la partida y llegó la marca: mucho rato es lo que deja un tiempo inventado, pero también alguien que se quedó sin señal. Ninguna señal prueba nada sola. Vetar borra las marcas de ese jugador y no le guarda más.</small></p>`
    : '<p><small>Todavía no hay marcas esta semana.</small></p>'
}
<h2>Vetados</h2>
${
  r.bans.length
    ? `<table><tr><th>Instalación</th><th>Motivo</th><th>Desde (UTC)</th><th></th></tr>
${r.bans.map(ban).join('\n')}
</table>
<p><small>Levantar el veto de alguien marcado por monedas da por bueno lo que tenga su cuenta en ese momento.</small></p>`
    : '<p><small>Nadie.</small></p>'
}
<script>
/* la clave va en la dirección de esta página; los botones la mandan en la cabecera */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-do]');
  if (!b) return;
  const ban = b.dataset.do === 'ban';
  if (!confirm(ban ? '¿Vetar a este jugador de la copa? Se borran sus marcas.' : '¿Levantar el veto?')) return;
  b.disabled = true;
  const key = new URLSearchParams(location.search).get('key') || '';
  const r = await fetch('/v1/admin/' + b.dataset.do, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ uid: b.dataset.uid }),
  }).catch(() => null);
  if (r && r.ok) location.reload();
  else {
    b.disabled = false;
    alert('No se pudo. Revisa la clave o la conexión.');
  }
});
</script>`;
}
const pct = (back, n) => (back === null ? '<td class="na">—</td>' : `<td>${n ? Math.round((back / n) * 100) : 0}% <small>(${back})</small></td>`);
function panel(s, r) {
  const tot = (k) => (s.total[k] ? `<b>${s.total[k].pct}%</b><small>${s.total[k].back} de ${s.total[k].base}</small>` : '<b>—</b><small>aún sin datos</small>');
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astrion Space · retorno</title>
<style>
body{font:15px system-ui,sans-serif;background:#0a0f24;color:#e8ecff;margin:0;padding:16px;max-width:760px;margin:auto}
h1{font-size:20px}h2{font-size:15px;color:#9aa8cc;margin-top:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.cards div{background:#151c3d;border-radius:12px;padding:12px}
.cards span{display:block;color:#9aa8cc;font-size:12px}.cards b{font-size:24px;display:block}.cards small{color:#9aa8cc}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid #222b55}th:first-child,td:first-child{text-align:left}
th{color:#9aa8cc;font-weight:500;font-size:12px}td small,p small{color:#9aa8cc}.na{color:#55608a}
.odd td{background:#2a1f3d}.tag{background:#ffb454;color:#201400;border-radius:6px;padding:1px 6px;font-size:12px;white-space:nowrap}
button{font:inherit;font-size:13px;background:#222b55;color:#e8ecff;border:1px solid #3a4680;border-radius:8px;padding:4px 10px;cursor:pointer}
code{font-size:12px;color:#9aa8cc;word-break:break-all}
</style>
<h1>Astrion Space · ¿la gente vuelve?</h1>
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
${reviewHtml(r)}
</html>`;
}

/* ---------- limpieza ----------
   Lo que ya no sirve se borra, para que la base no crezca sin fin: lo vencido de las cuentas, los
   contadores de ventanas pasadas, las copas viejas, los retos abandonados y la medición antigua.
   En Cloudflare la corre un reloj una vez al día (worker.js, scheduled). Devuelve cuánto borró. */
export async function cleanup(store, now) {
  const today = dayOf(now),
    monday = dayFromKey(weekOf(now).key);
  /* un contador vive como mucho un día: se botan los de ventanas que empezaron hace más de eso */
  await store.sweep(now, Math.floor(now / UNIT) - 145);
  return {
    scores: await store.dropWeeksBefore(dayKey(monday - 7 * KEEP_WEEKS)),
    duels: await store.dropDuelsBefore(now - KEEP_DUEL_DAYS * DAY),
    visits: await store.dropVisitsBefore(today - KEEP_VISIT_DAYS),
  };
}

/* ---------- administración ---------- */
/* la clave llega en la cabecera o, para abrir el panel en el navegador, en la dirección */
async function isAdmin(request, url, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || ''),
    given = m ? m[1] : url.searchParams.get('key');
  return sameSecret(given, env.adminKey);
}
/* sacar a un tramposo: se borran sus marcas y no se le guardan más (o se le levanta el veto) */
async function postBan(request, env, on) {
  const b = await body(request);
  if (!b || !validUid(b.uid)) return bad('identificador inválido');
  if (!on) {
    await env.store.unban(b.uid);
    /* si lo había marcado el tope de monedas, lo que tenga ahora se da por bueno (si no, el
       próximo guardado lo volvería a marcar) */
    await env.store.trustLedgers(b.uid);
    return json({ ok: true });
  }
  await env.store.ban(b.uid, env.now, 'admin');
  const removed = await env.store.dropScores(b.uid);
  if (env.cache) env.cache.clear();
  return json({ ok: true, removed });
}

/* ---------- entrada ---------- */
/** env = { store, now, adminKey }; para las cuentas y los tiquetes, { secret, googleIds, googleKeys, ip };
    para las compras, { playKey, playPackage, playFetch }; opcionales: cache (un Map que dure
    entre peticiones) y gate (ver limites.js) */
export async function handle(request, env) {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/+$/, '') || '/',
    { store, now } = env;
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    /* cada progreso que se guarda pasa por el tope de monedas (tope.js) */
    const acc = await accounts(request, { ...env, saved: (account, data) => audit(env, account, data) }, path);
    if (acc) return acc;
    const buy = await purchases(request, env, path);
    if (buy) return buy;
    if (request.method === 'POST' && path === '/v1/run') return await postRun(request, env);
    if (request.method === 'POST' && path === '/v1/score') return await postScore(request, env);
    if (request.method === 'POST' && path === '/v1/visits') return await postVisits(request, env);
    if (request.method === 'GET' && path === '/v1/cup') return json(await table(env, url.searchParams.get('uid')));
    if (request.method === 'POST' && path === '/v1/duel') return await postDuel(request, env);
    if (request.method === 'POST' && path === '/v1/duel/score') return await postDuelScore(request, env);
    if (request.method === 'GET' && path === '/v1/duel') return await getDuel(url, env);
    const admin =
      (request.method === 'GET' && (path === '/panel' || path === '/v1/stats' || path === '/v1/admin/review')) ||
      (request.method === 'POST' && (path === '/v1/admin/ban' || path === '/v1/admin/unban'));
    if (admin) {
      /* sin clave configurada no hay administración; y quien prueba claves a la fuerza se frena */
      if (!env.adminKey || !(await isAdmin(request, url, env))) {
        if (await tooMany(env, 'admin')) return SLOW();
        return bad('clave incorrecta', 403);
      }
      if (request.method === 'POST') return await postBan(request, env, path === '/v1/admin/ban');
      if (path === '/v1/admin/review') return json(await review(store, now));
      const s = await stats(store, now);
      return path === '/panel'
        ? new Response(panel(s, await review(store, now)), {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
          })
        : json(s);
    }
    /* la política de privacidad: una página pública, en español y en inglés (privacidad.js) */
    /* también con HEAD: así la consultan los verificadores automáticos (el de Google Play, entre ellos) */
    if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/privacidad' || path === '/privacy'))
      return privacyResponse(path === '/privacy' ? 'en' : 'es', {
        weeks: KEEP_WEEKS,
        duelDays: KEEP_DUEL_DAYS,
        visitDays: KEEP_VISIT_DAYS,
      });
    if (path === '/') return json({ ok: true, name: 'giro-estelar' });
    return bad('no existe', 404);
  } catch (e) {
    return bad('falló el servidor', 500);
  }
}
