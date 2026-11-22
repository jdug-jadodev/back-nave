import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '../src/almacenes.js';
import { cleanNick, dayFromKey, handle, weekOf } from '../src/reglas.js';

/* hora de Colombia → instante */
const at = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h + 5, min);
const FRI = at(2026, 11, 20); // viernes
const uid = (n) => 'jugador' + String(n).padStart(12, '0');

function server(now = FRI) {
  const env = { store: memoryStore(), now, adminKey: 'secreta' };
  const call = async (method, path, data) => {
    const r = await handle(
      new Request('http://x' + path, { method, body: data === undefined ? undefined : JSON.stringify(data) }),
      env,
    );
    const text = await r.text();
    return { status: r.status, data: r.headers.get('content-type').includes('json') ? JSON.parse(text) : text };
  };
  return { env, call, score: (n, nick, time, week = '2026-11-16') => call('POST', '/v1/score', { uid: uid(n), nick, week, time }) };
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

