import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '../src/almacenes.js';
import { LIMITS } from '../src/limites.js';
import { KEEP_VISIT_DAYS, MAX_DAYS, cleanNick, cleanup, dayFromKey, dayOf, handle, weekOf } from '../src/reglas.js';
import { ticketFor } from '../src/tiquetes.js';

/* hora de Colombia → instante */
const at = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h + 5, min);
const FRI = at(2026, 11, 20); // viernes
const uid = (n) => 'jugador' + String(n).padStart(12, '0');

function server(now = FRI) {
  const env = { store: memoryStore(), now, adminKey: 'secreta', secret: 'secreto-de-prueba' };
  const call = async (method, path, data) => {
    const r = await handle(
      new Request('http://x' + path, { method, body: data === undefined ? undefined : JSON.stringify(data) }),
      env,
    );
    const text = await r.text();
    return { status: r.status, data: r.headers.get('content-type').includes('json') ? JSON.parse(text) : text };
  };
  /* una marca como la manda el juego: con el tiquete de una partida que empezó hace justo ese tiempo */
  const score = async (n, nick, time, week = '2026-11-16') =>
    call('POST', '/v1/score', { uid: uid(n), nick, week, time, ticket: await ticketFor(env.secret, uid(n), env.now - time * 1000) });
  return { env, call, score };
}

test('la semana va de lunes a domingo, con la hora de Colombia', () => {
  assert.equal(weekOf(at(2026, 11, 20)).key, '2026-11-16');
  assert.equal(weekOf(at(2026, 11, 16, 0, 0)).key, '2026-11-16', 'lunes a medianoche ya es la semana nueva');
  assert.equal(weekOf(at(2026, 11, 22, 23, 59)).key, '2026-11-16', 'domingo en la noche sigue en la misma');
  assert.equal(weekOf(at(2026, 11, 23, 0, 0)).key, '2026-11-23');
  assert.equal(weekOf(at(2026, 11, 22, 23, 0)).ends, 3600, 'falta una hora para que termine');
});

test('el apodo se limpia', () => {
  assert.equal(cleanNick('  Jon   el <b>Rápido</b>!!  '), 'Jon el bRápido');
  assert.equal(cleanNick('Ñandú_7'), 'Ñandú_7');
  assert.equal(cleanNick('😀'), '');
  assert.equal(cleanNick(null), '');
});

test('la tabla ordena por tiempo y, en empate, gana quien lo logró primero', async () => {
  const s = server();
  await s.score(1, 'Ana', 120);
  s.env.now += 1000;
  await s.score(2, 'Beto', 200);
  s.env.now += 1000;
  const r = await s.score(3, 'Caro', 120);
  assert.deepEqual(
    r.data.top.map((x) => x.nick),
    ['Beto', 'Ana', 'Caro'],
  );
  assert.deepEqual(r.data.me, { time: 120, rank: 3 });
  assert.equal(r.data.top[2].me, true);
  assert.equal(r.data.top[0].me, undefined, 'no se marca a los demás, ni se entrega su identificador');
  assert.equal(JSON.stringify(r.data).includes('jugador'), false);
  assert.equal(r.data.total, 3);
  assert.equal(r.data.week, '2026-11-16');
});

test('solo cuenta el mejor tiempo; un tiempo peor no lo baja pero sí cambia el apodo', async () => {
  const s = server();
  await s.score(1, 'Ana', 150);
  const r = await s.score(1, 'Anita', 90);
  assert.equal(r.data.me.time, 150);
  assert.equal(r.data.top[0].nick, 'Anita');
  s.env.now += 60000; // otra partida, más tarde
  assert.equal((await s.score(1, 'Anita', 180)).data.me.time, 180);
});

test('una marca de otra semana no entra', async () => {
  const s = server();
  const r = await s.score(1, 'Ana', 150, '2026-11-09');
  assert.equal(r.status, 200);
  assert.equal(r.data.saved, false);
  assert.equal(r.data.total, 0);
});

test('la semana nueva empieza vacía y la anterior no se pierde', async () => {
  const s = server();
  await s.score(1, 'Ana', 150);
  s.env.now = at(2026, 11, 23, 8);
  const r = await s.call('GET', '/v1/cup?uid=' + uid(1));
  assert.equal(r.data.week, '2026-11-23');
  assert.deepEqual(r.data.top, []);
  assert.equal(r.data.me, null);
  assert.equal(await s.env.store.total('2026-11-16'), 1);
});

test('rechaza datos malos', async () => {
  const s = server();
  assert.equal((await s.call('POST', '/v1/score', { uid: 'corto', nick: 'Ana', week: '2026-11-16', time: 10 })).status, 400);
  assert.equal((await s.score(1, 'A', 10)).status, 400, 'apodo de una letra');
  assert.equal((await s.score(1, 'Ana', 99999)).status, 400, 'tiempo imposible');
  assert.equal((await s.score(1, 'Ana', 0)).status, 400);
  assert.equal((await s.call('POST', '/v1/score', 'hola')).status, 400);
  assert.equal((await s.call('GET', '/nada')).status, 404);
  assert.equal((await s.call('GET', '/v1/cup')).data.me, null, 'sin identificador solo se ve la tabla');
});

test('solo la tabla muestra a los 20 primeros, pero la posición propia siempre llega', async () => {
  const s = server();
  for (let i = 1; i <= 25; i++) {
    await s.score(i, 'Jug' + i, 100 + i);
    s.env.now += 10;
  }
  const r = await s.call('GET', '/v1/cup?uid=' + uid(2));
  assert.equal(r.data.top.length, 20);
  assert.equal(r.data.total, 25);
  assert.deepEqual(r.data.me, { time: 102, rank: 24 });
});

test('la medición cuenta cuántos volvieron al día siguiente y a la semana', async () => {
  const s = server(at(2026, 11, 20));
  const visits = (n, first, days) => s.call('POST', '/v1/visits', { uid: uid(n), first, days });
  /* cuatro llegaron el 12: dos volvieron al día siguiente, uno a los 7 días */
  await visits(1, '2026-11-12', [0, 1, 7]);
  await visits(2, '2026-11-12', [0, 1]);
  await visits(3, '2026-11-12', [0]);
  await visits(4, '2026-11-12', [0, 2]);
  /* uno llegó ayer y volvió hoy; otro llegó hoy */
  await visits(5, '2026-11-19', [0, 1]);
  await visits(6, '2026-11-20', [0]);
  assert.equal((await visits(1, '2026-11-12', [0, 1, 7])).data.ok, true, 'repetir no duplica');

  assert.equal((await s.call('GET', '/v1/stats?key=mala')).status, 403);
  const st = (await s.call('GET', '/v1/stats?key=secreta')).data;
  assert.equal(st.activeToday, 2);
  assert.equal(st.players, 6);
  const c12 = st.rows.find((r) => r.day === '2026-11-12');
  assert.deepEqual(c12, { day: '2026-11-12', n: 4, d1: 2, d3: 0, d7: 1, d30: null });
  const c20 = st.rows.find((r) => r.day === '2026-11-20');
  assert.equal(c20.d1, null, 'los de hoy aún no han tenido tiempo de volver');
  /* día siguiente: de 5 que ya tuvieron tiempo (4 del 12 + 1 del 19), volvieron 3 */
  assert.deepEqual(st.total.d1, { base: 5, back: 3, pct: 60 });
  assert.deepEqual(st.total.d7, { base: 4, back: 1, pct: 25 });
  assert.equal(st.total.d30, null);

  const page = await s.call('GET', '/panel?key=secreta');
  assert.equal(page.status, 200);
  assert.match(page.data, /60%/);
});

test('la medición descarta fechas imposibles', async () => {
  const s = server(at(2026, 11, 20));
  const r = await s.call('POST', '/v1/visits', { uid: uid(1), first: '2026-11-19', days: [0, 1, 5, -2, 'x', 1] });
  assert.equal(r.data.n, 2, 'el día 5 aún no existe');
  assert.equal((await s.call('POST', '/v1/visits', { uid: uid(1), first: '2027-01-01', days: [0] })).status, 400);
  assert.equal(dayFromKey('no es fecha') !== dayFromKey('no es fecha'), true);
});

test('un reto: se crea con código, otro lo juega en la misma pista y comparten tabla', async () => {
  const s = server();
  const codes = ['ABC234', 'ABC234', 'XYZ789'];
  s.env.code = () => codes.shift();
  const made = await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: 123456789, time: 151 });
  assert.equal(made.status, 200);
  assert.equal(made.data.code, 'ABC234');
  assert.equal(made.data.seed, 123456789);
  assert.equal(made.data.by, 'Ana');
  assert.deepEqual(made.data.me, { time: 151, rank: 1 });
  /* otro reto: el primer código que sale ya existe, así que se usa el siguiente */
  const other = await s.call('POST', '/v1/duel', { uid: uid(2), nick: 'Beto', seed: 5, time: 30 });
  assert.equal(other.data.code, 'XYZ789');
  /* Beto consulta el reto de Ana (el código se acepta en minúsculas y con espacios) y lo juega */
  const seen = await s.call('GET', '/v1/duel?code=abc%20234&uid=' + uid(2));
  assert.equal(seen.data.seed, 123456789);
  assert.equal(seen.data.by, 'Ana');
  assert.equal(seen.data.me, null);
  s.env.now += 1000;
  const played = await s.call('POST', '/v1/duel/score', { code: 'ABC234', uid: uid(2), nick: 'Beto', time: 170 });
  assert.deepEqual(
    played.data.top.map((x) => x.nick + ' ' + x.time),
    ['Beto 170', 'Ana 151'],
  );
  assert.deepEqual(played.data.me, { time: 170, rank: 1 });
  /* Ana ve que la pasaron */
  const back = await s.call('GET', '/v1/duel?code=ABC234&uid=' + uid(1));
  assert.deepEqual(back.data.me, { time: 151, rank: 2 });
  assert.equal(JSON.stringify(back.data).includes('jugador'), false, 'no se entregan identificadores');
  /* los retos no se mezclan con la copa ni entre sí */
  assert.equal((await s.call('GET', '/v1/cup')).data.total, 0);
  assert.equal((await s.call('GET', '/v1/duel?code=XYZ789')).data.total, 1);
});

test('los retos rechazan lo que no sirve', async () => {
  const s = server();
  s.env.code = () => 'ABC234';
  assert.equal((await s.call('GET', '/v1/duel?code=NOEXIS')).status, 404);
  assert.equal((await s.call('POST', '/v1/duel/score', { code: 'NOEXIS', uid: uid(1), nick: 'Ana', time: 10 })).status, 404);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: -1, time: 10 })).status, 400);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: 1.5, time: 10 })).status, 400);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: 7, time: 0 })).status, 400);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'A', seed: 7, time: 10 })).status, 400);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: 7, time: 10 })).status, 200);
  /* si el código se repite una y otra vez, no se queda dando vueltas */
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(1), nick: 'Ana', seed: 8, time: 10 })).status, 500);
  /* sin generador de pruebas, el código real tiene 6 caracteres de los permitidos */
  delete s.env.code;
  const real = await s.call('POST', '/v1/duel', { uid: uid(3), nick: 'Caro', seed: 9, time: 10 });
  assert.match(real.data.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

/* ---------- abuso: límites, limpieza y administración ---------- */

test('las rutas que escriben sin cuenta tienen un tope por cliente', async () => {
  const s = server();
  s.env.ip = '10.0.0.7';
  const post = (path, data) => s.call('POST', path, data);
  const flood = async (n, make) => {
    let last;
    for (let i = 0; i < n; i++) last = await make(i);
    return last;
  };
  /* marcas en la copa, cada una con un identificador distinto (como haría quien quiere llenar la tabla) */
  const [scores] = LIMITS.score;
  assert.equal((await flood(scores, (i) => s.score(i, 'Bot' + i, 50))).status, 200);
  assert.equal((await s.score(999, 'Bot', 50)).status, 429);
  assert.equal((await s.call('GET', '/v1/cup')).data.total, scores, 'lo frenado no entró');
  /* retos */
  const [duels] = LIMITS.duel;
  assert.equal((await flood(duels, (i) => post('/v1/duel', { uid: uid(i), nick: 'Bot', seed: i, time: 30 }))).status, 200);
  assert.equal((await post('/v1/duel', { uid: uid(1), nick: 'Bot', seed: 1, time: 30 })).status, 429);
  /* medición */
  const [visits] = LIMITS.visits;
  assert.equal((await flood(visits, (i) => post('/v1/visits', { uid: uid(i), first: '2026-11-19', days: [0] }))).status, 200);
  assert.equal((await post('/v1/visits', { uid: uid(1), first: '2026-11-19', days: [0] })).status, 429);
  /* a otro cliente no lo afecta, y pasada la ventana se puede otra vez */
  s.env.ip = '10.0.0.8';
  assert.equal((await s.score(500, 'Otra', 50)).status, 200);
  s.env.ip = '10.0.0.7';
  s.env.now += LIMITS.score[1];
  assert.equal((await s.score(501, 'Luego', 50)).status, 200);
  /* marcas en retos: mismo tope */
  s.env.ip = '10.0.0.9';
  const d = await post('/v1/duel', { uid: uid(1), nick: 'Ana', seed: 5, time: 30 });
  const [ds] = LIMITS.duelScore;
  await flood(ds, (i) => post('/v1/duel/score', { code: d.data.code, uid: uid(i), nick: 'Bot', time: 20 }));
  assert.equal((await post('/v1/duel/score', { code: d.data.code, uid: uid(1), nick: 'Bot', time: 20 })).status, 429);
});

test('la capa de límites de la plataforma, si está, frena antes de tocar la base', async () => {
  const s = server();
  let writes = 0;
  s.env.store = new Proxy(s.env.store, {
    get: (store, name) => (name === 'bump' || name.startsWith('put') ? (...a) => (writes++, store[name](...a)) : store[name]),
  });
  const asked = [];
  s.env.gate = async (key) => (asked.push(key), false);
  assert.equal((await s.score(1, 'Ana', 50)).status, 429);
  assert.equal(writes, 0, 'ni una escritura');
  assert.match(asked[0], /^score:/);
  s.env.gate = async () => true;
  assert.equal((await s.score(1, 'Ana', 50)).status, 200);
});

test('de un envío de la medición se anotan como mucho los días más recientes', async () => {
  const s = server(at(2026, 11, 20));
  const today = dayOf(s.env.now);
  /* 400 días de una sola vez: se quedan los 60 más recientes */
  const r = await s.call('POST', '/v1/visits', { uid: uid(1), first: '2025-10-17', days: Array.from({ length: 400 }, (_, i) => i) });
  assert.equal(r.status, 200);
  assert.equal(r.data.n, MAX_DAYS);
  assert.equal(await s.env.store.active(today - 1), 1);
  assert.equal(await s.env.store.active(today - MAX_DAYS - 5), 0);
  /* lo más viejo de lo que se conserva ni se anota */
  const old = await s.call('POST', '/v1/visits', { uid: uid(2), first: '2025-01-01', days: [0, 1, 2] });
  assert.equal(old.data.n, 0);
  assert.equal((await s.call('POST', '/v1/visits', { uid: uid(3), first: '2026-11-19', days: Array.from({ length: 401 }, (_, i) => i) })).status, 400);
});

test('una marca no puede ser más larga que lo que lleva la semana', async () => {
  const s = server(at(2026, 11, 16, 0, 30)); // lunes, media hora después de empezar la copa
  assert.equal((await s.score(1, 'Tramposo', 7200)).status, 400, 'dos horas aguantadas en media hora de semana');
  assert.equal((await s.score(1, 'Honesto', 1500)).status, 200);
  s.env.now = at(2026, 11, 16, 3, 0);
  assert.equal((await s.score(2, 'Largo', 7200)).status, 200, 'ya pasó tiempo de sobra');
});

test('datos con forma rara dan error de datos, no de servidor', async () => {
  const s = server();
  const post = (data) => s.call('POST', '/v1/score', data);
  assert.equal((await post({ uid: uid(1), nick: { toString: 1 }, week: '2026-11-16', time: 50 })).status, 400);
  assert.equal((await post({ uid: uid(1), nick: ['Ana'], week: '2026-11-16', time: 50 })).status, 400);
  assert.equal((await post({ uid: uid(1), nick: 'Ana', week: '2026-11-16', time: '0x1C20' })).status, 400, 'el tiempo es un número');
  assert.equal((await post({ uid: { length: 20 }, nick: 'Ana', week: '2026-11-16', time: 50 })).status, 400);
  assert.equal((await s.call('GET', '/v1/cup')).data.total, 0);
});

test('el total de la tabla y el puesto se recuerdan unos segundos; quien anota ve lo suyo al instante', async () => {
  const s = server();
  let counts = 0;
  s.env.store = new Proxy(s.env.store, {
    get: (store, name) => (name === 'total' || name === 'ahead' ? (...a) => (counts++, store[name](...a)) : store[name]),
  });
  s.env.cache = new Map();
  for (let i = 1; i <= 5; i++) await s.score(i, 'Jug' + i, 100 + i);
  counts = 0;
  for (let i = 0; i < 10; i++) {
    const r = await s.call('GET', '/v1/cup?uid=' + uid(2));
    assert.equal(r.data.total, 5);
    assert.deepEqual(r.data.me, { time: 102, rank: 4 });
  }
  assert.ok(counts <= 2, 'diez consultas, y la tabla se contó ' + counts + ' veces');
  /* quien acaba de anotar ve sus números recién contados, no los recordados */
  const mine = await s.score(6, 'Nueva', 500);
  assert.equal(mine.data.total, 6);
  assert.deepEqual(mine.data.me, { time: 500, rank: 1 });
  /* y los demás ven el cambio en su siguiente consulta */
  assert.deepEqual((await s.call('GET', '/v1/cup?uid=' + uid(2))).data.me, { time: 102, rank: 5 });
  /* lo recordado vence solo: pasado el rato se vuelve a contar */
  counts = 0;
  s.env.now += 31000;
  await s.call('GET', '/v1/cup?uid=' + uid(2));
  assert.equal(counts, 2);
  /* sin memoria (las pruebas, el servidor local) se cuenta siempre: mismos números */
  delete s.env.cache;
  assert.equal((await s.call('GET', '/v1/cup')).data.total, 6);
});

test('la limpieza diaria bota copas viejas, retos abandonados y medición antigua', async () => {
  const s = server(at(2026, 11, 20));
  const store = s.env.store;
  await store.putScore('2026-08-31', uid(1), 'Vieja', 80, 1);
  await store.putScore('2026-10-12', uid(1), 'Reciente', 80, 1);
  await s.score(1, 'Ana', 120);
  const old = s.env.now - 45 * 86400000;
  await store.putDuel('VIEJO2', 1, uid(1), 'Ana', old);
  await store.putScore('rVIEJO2', uid(1), 'Ana', 40, old);
  const duel = await s.call('POST', '/v1/duel', { uid: uid(2), nick: 'Beto', seed: 9, time: 30 });
  const today = dayOf(s.env.now);
  await store.putVisits(uid(1), today - 300, [today - 300, today - KEEP_VISIT_DAYS - 1, today - 20, today]);

  const gone = await cleanup(store, s.env.now);
  assert.deepEqual(gone, { scores: 1, duels: 1, visits: 2 });
  assert.equal(await store.total('2026-08-31'), 0, 'la copa de hace tres meses');
  assert.equal(await store.total('2026-10-12'), 1, 'la de hace un mes se conserva');
  assert.equal((await s.call('GET', '/v1/cup')).data.total, 1, 'la de esta semana, intacta');
  assert.equal((await s.call('GET', '/v1/duel?code=VIEJO2')).status, 404, 'el reto abandonado');
  assert.equal((await s.call('GET', '/v1/duel?code=' + duel.data.code)).status, 200, 'el reciente sigue');
  assert.equal(await store.active(today - 20), 1);
  assert.deepEqual(await cleanup(store, s.env.now), { scores: 0, duels: 0, visits: 0 }, 'repetirla no borra nada más');
});

test('administración: la clave va en la cabecera, se frena a quien la prueba a la fuerza, y se puede sacar a un tramposo', async () => {
  const s = server();
  s.env.ip = '10.9.9.9';
  const admin = async (method, path, data, key) => {
    const r = await handle(
      new Request('http://x' + path, { method, headers: key ? { authorization: 'Bearer ' + key } : {}, body: data ? JSON.stringify(data) : undefined }),
      s.env,
    );
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  assert.equal((await admin('GET', '/v1/stats', null, 'secreta')).status, 200, 'por cabecera, sin dejarla en la dirección');
  assert.equal((await admin('GET', '/v1/stats?key=secreta')).status, 200, 'en la dirección sigue sirviendo, para el navegador');
  assert.equal((await admin('GET', '/v1/stats', null, 'secret')).status, 403);
  assert.equal((await admin('GET', '/v1/stats', null, 'secretaa')).status, 403);
  assert.equal((await admin('GET', '/v1/stats')).status, 403);
  assert.equal((await admin('GET', '/panel?key=secreta')).headers.get('referrer-policy'), 'no-referrer');

  /* un tramposo en la punta de la tabla */
  await s.score(1, 'Ana', 120);
  await s.score(66, 'Tramposo', 7000);
  assert.equal((await s.call('GET', '/v1/cup')).data.top[0].nick, 'Tramposo');
  assert.equal((await admin('POST', '/v1/admin/ban', { uid: uid(66) })).status, 403, 'sin clave no');
  const ban = await admin('POST', '/v1/admin/ban', { uid: uid(66) }, 'secreta');
  assert.equal(ban.status, 200);
  assert.equal(JSON.parse(ban.text).removed, 1);
  assert.deepEqual(
    (await s.call('GET', '/v1/cup')).data.top.map((r) => r.nick),
    ['Ana'],
  );
  const again = await s.score(66, 'Tramposo', 7100);
  assert.equal(again.data.saved, false, 'sus marcas ya no se guardan');
  assert.equal(again.data.total, 1);
  assert.equal((await s.call('POST', '/v1/duel', { uid: uid(66), nick: 'Tramposo', seed: 1, time: 30 })).status, 403);
  assert.equal((await admin('POST', '/v1/admin/unban', { uid: uid(66) }, 'secreta')).status, 200);
  assert.equal((await s.score(66, 'Arrepentido', 90)).data.saved, true);

  /* adivinar la clave a la fuerza: se frena */
  let last;
  for (let i = 0; i <= 25; i++) last = await admin('GET', '/v1/stats', null, 'intento' + i);
  assert.equal(last.status, 429);
  assert.equal((await admin('GET', '/v1/stats', null, 'secreta')).status, 200, 'con la clave buena se sigue entrando');
  /* sin clave configurada, no hay administración */
  delete s.env.adminKey;
  s.env.ip = '10.9.9.10';
  assert.equal((await admin('GET', '/v1/stats', null, 'undefined')).status, 403);
  assert.equal((await admin('GET', '/v1/stats?key=')).status, 403);
});

test('la política de privacidad está en español y en inglés, con el contacto y los plazos de verdad', async () => {
  const s = server();
  const es = await s.call('GET', '/privacidad'),
    en = await s.call('GET', '/privacy');
  assert.equal(es.status, 200);
  assert.equal(en.status, 200);
  assert.match(es.data, /<html lang="es">/);
  assert.match(en.data, /<html lang="en">/);
  for (const page of [es.data, en.data]) {
    assert.match(page, /mailto:astrionspace\.game@gmail\.com/, 'trae el correo de contacto');
    assert.match(page, /AdMob/);
    assert.match(page, /Cloudflare/);
    assert.match(page, new RegExp(': ' + KEEP_VISIT_DAYS + ' (días|days)'), 'el plazo de la medición sale de reglas.js');
    assert.doesNotMatch(page, /<script/i, 'una página sin código');
    assert.doesNotMatch(page, /undefined|NaN|\$\{/, 'sin huecos en el texto');
  }
  assert.match(es.data, /Borrar mi cuenta y lo guardado/, 'nombra la opción del juego tal como aparece');
  assert.match(es.data, /menores de 13 años/);
  /* es pública (sin clave) y no acepta otra cosa que leerla */
  const r = await handle(new Request('http://x/privacidad'), s.env);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await s.call('POST', '/privacidad', {})).status, 404);
});
