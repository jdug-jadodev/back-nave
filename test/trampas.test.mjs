/**
 * Contra las trampas: el tiquete de partida de la copa, la lista de revisión del panel y el tope
 * de monedas de las cuentas.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d1Store, memoryStore } from '../src/almacenes.js';
import { sha256 } from '../src/cuentas.js';
import { handle, review } from '../src/reglas.js';
import { LIFE, SLACK, ticketFor, ticketStart } from '../src/tiquetes.js';
import PRICES from '../src/precios.js';
import { FIRST, RATE, ROOM, START, judge, wealthOf } from '../src/tope.js';
import { fakeD1 } from './apoyo/d1.mjs';

const NOW = Date.UTC(2026, 10, 20, 17, 0); // viernes al mediodía, hora de Colombia
const WEEK = '2026-11-16';
const CLIENT = 'giro-estelar-prueba.apps.googleusercontent.com';
const uid = (n) => 'jugador' + String(n).padStart(12, '0');
const b64url = (data) => Buffer.from(data).toString('base64url');

/* un servidor con todo: copa, cuentas (con un "Google" de mentira) y administración */
async function server(store = memoryStore()) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'llave-1' };
  const env = {
    store,
    now: NOW,
    adminKey: 'secreta',
    secret: 'secreto-de-prueba',
    googleIds: [CLIENT],
    googleKeys: async () => [jwk],
    ip: '10.0.0.1',
  };
  const call = async (method, path, data, bearer) => {
    const r = await handle(
      new Request('http://x' + path, {
        method,
        headers: bearer ? { authorization: 'Bearer ' + bearer } : {},
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
    );
    const text = await r.text();
    return { status: r.status, text, data: (r.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : null };
  };
  /* entra con Google como esa persona y devuelve su llave de sesión */
  const login = async (sub) => {
    const nonce = (await call('POST', '/v1/auth/nonce')).data.nonce,
      h = b64url(JSON.stringify({ alg: 'RS256', kid: 'llave-1', typ: 'JWT' })),
      p = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: env.now / 1000 + 3600, iat: env.now / 1000, sub, nonce })),
      sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(h + '.' + p));
    return (await call('POST', '/v1/auth/google', { idToken: h + '.' + p + '.' + b64url(new Uint8Array(sig)) })).data.session;
  };
  /* una partida como la juega el juego: pide el tiquete, pasa el tiempo, manda la marca */
  const play = async (n, nick, time, extra = 0) => {
    const ticket = (await call('POST', '/v1/run', { uid: uid(n) })).data.ticket;
    env.now += (time + extra) * 1000;
    return call('POST', '/v1/score', { uid: uid(n), nick, week: WEEK, time, ticket });
  };
  /* guardar el progreso de una cuenta; lleva la versión por su cuenta */
  const versions = new Map();
  const save = async (session, data) => {
    const base = versions.get(session) || 0,
      r = await call('PUT', '/v1/save', { data, base }, session);
    if (r.status === 200) versions.set(session, r.data.version);
    return r;
  };
  return { env, call, login, play, save };
}

/* ---------- el tiquete de partida ---------- */
test('el tiquete: lo firma el servidor, para un jugador y con su hora', async () => {
  const t = await ticketFor('secreto', uid(1), NOW);
  assert.match(t, /^[0-9a-z]+\.[0-9a-f]{32}$/);
  assert.equal(await ticketStart('secreto', uid(1), t, NOW + 5000), NOW, 'el servidor lo reconoce y sabe cuándo empezó');
  assert.equal(await ticketStart('secreto', uid(2), t, NOW + 5000), 0, 'no sirve para otro jugador');
  assert.equal(await ticketStart('otro-secreto', uid(1), t, NOW + 5000), 0, 'ni lo acepta quien no lo firmó');
  const [hour, mark] = t.split('.');
  assert.equal(await ticketStart('secreto', uid(1), (NOW - 3600000).toString(36) + '.' + mark, NOW), 0, 'cambiarle la hora lo daña');
  assert.equal(await ticketStart('secreto', uid(1), hour + '.' + '0'.repeat(32), NOW), 0, 'una firma inventada no vale');
  assert.equal(await ticketStart('secreto', uid(1), t, NOW + LIFE + 1), 0, 'vence');
  assert.equal(await ticketStart('secreto', uid(1), await ticketFor('secreto', uid(1), NOW + 3600000), NOW), 0, 'ni uno con fecha futura');
  for (const junk of [undefined, null, '', 'hola', 42, {}, ['a.b'], 'a.b.c', t + 'x'])
    assert.equal(await ticketStart('secreto', uid(1), junk, NOW), 0, 'basura: ' + JSON.stringify(junk));
  assert.equal(await ticketStart('', uid(1), t, NOW), 0, 'sin secreto configurado no vale ninguno');
});

test('la copa solo anota marcas con tiquete, y el tiempo tiene que caber en el reloj', async () => {
  const s = await server();
  const post = (data) => s.call('POST', '/v1/score', { uid: uid(1), nick: 'Ana', week: WEEK, ...data });

  /* como lo haría un programa que imita al juego: la marca sola */
  const bare = await post({ time: 900 });
  assert.equal(bare.status, 200, 'contesta la tabla, pero...');
  assert.equal(bare.data.saved, false);
  assert.equal(bare.data.refused, 'ticket', '...dice por qué no la anotó');
  assert.equal(bare.data.total, 0);
  assert.equal((await post({ time: 900, ticket: 'inventado.' + 'a'.repeat(32) })).data.refused, 'ticket');

  /* pide el tiquete y manda enseguida un tiempo que todavía no ha pasado */
  const ticket = (await s.call('POST', '/v1/run', { uid: uid(1) })).data.ticket;
  s.env.now += 60000;
  const rush = await post({ time: 900, ticket });
  assert.equal(rush.data.saved, false, '15 minutos aguantados en 1 minuto de reloj: no');
  assert.equal(rush.data.refused, 'ticket');
  const fair = await post({ time: 60 + SLACK, ticket });
  assert.equal(fair.data.saved, true, 'lo que sí cabe (con la holgura de la señal), entra');
  assert.equal(fair.data.refused, undefined);
  assert.equal(fair.data.me.time, 60 + SLACK);

  /* el tiquete de otro no sirve */
  const stolen = await s.call('POST', '/v1/score', { uid: uid(2), nick: 'Beto', week: WEEK, time: 30, ticket });
  assert.equal(stolen.data.saved, false);
  assert.equal(stolen.data.total, 1);

  /* una partida de verdad */
  const real = await s.play(3, 'Caro', 240);
  assert.equal(real.data.saved, true);
  assert.equal(real.data.me.time, 240);
  /* terminó sin señal y la marca llega una hora después: sigue valiendo */
  const late = await s.play(4, 'Dani', 100, 3600);
  assert.equal(late.data.saved, true);

  /* pedir tiquete: hace falta un identificador, y el secreto del servidor */
  assert.equal((await s.call('POST', '/v1/run', { uid: 'corto' })).status, 400);
  assert.equal((await s.call('POST', '/v1/run', 'hola')).status, 400);
  delete s.env.secret;
  assert.equal((await s.call('POST', '/v1/run', { uid: uid(1) })).status, 503, 'sin secreto no hay tiquetes');
  assert.equal((await post({ time: 30, ticket })).data.saved, false, 'ni se aceptan los que había');
});

test('un tiquete sirve para una sola marca', async () => {
  for (const store of [memoryStore(), d1Store(fakeD1())]) {
    const s = await server(store);
    const ticket = (await s.call('POST', '/v1/run', { uid: uid(1) })).data.ticket;
    const post = (time, t = ticket) => s.call('POST', '/v1/score', { uid: uid(1), nick: 'Ana', week: WEEK, time, ticket: t });
    s.env.now += 100000;
    assert.equal((await post(100)).data.me.time, 100);
    /* el mismo tiquete, más tarde, con un tiempo mayor: es otra "partida" que nunca empezó */
    s.env.now += 500000;
    assert.equal((await post(600)).data.me.time, 100, 'no mejora con el tiquete ya usado');
    /* con un tiquete nuevo sí */
    const again = (await s.call('POST', '/v1/run', { uid: uid(1) })).data.ticket;
    s.env.now += 300000;
    assert.equal((await post(300, again)).data.me.time, 300);
    /* y uno más viejo que el de la marca actual tampoco la mejora */
    s.env.now += 900000;
    assert.equal((await post(900, ticket)).data.me.time, 300);
  }
});

test('pedir tiquetes no escribe en la base, y la capa de límites frena a quien los pide a chorros', async () => {
  const s = await server();
  let writes = 0;
  for (const name of ['bump', 'putScore', 'putNonce', 'putVisits']) {
    const real = s.env.store[name];
    s.env.store[name] = (...a) => (writes++, real(...a));
  }
  for (let i = 0; i < 200; i++) assert.equal((await s.call('POST', '/v1/run', { uid: uid(i) })).status, 200);
  assert.equal(writes, 0, 'doscientos tiquetes, ninguna escritura');
  const seen = [];
  s.env.gate = async (key) => (seen.push(key), seen.length <= 3);
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/v1/run', { uid: uid(1) })).status, 200);
  assert.equal((await s.call('POST', '/v1/run', { uid: uid(1) })).status, 429);
  assert.equal(seen[0], 'run:10.0.0.1:' + uid(1), 'se cuenta por cliente y por jugador');
});

/* ---------- la lista de revisión ---------- */
test('la lista de revisión señala las marcas raras, sin vetar a nadie sola', async () => {
  const s = await server();
  for (const [n, nick, time] of [[1, 'Ana', 100], [2, 'Beto', 140], [3, 'Caro', 180], [4, 'Dani', 90], [5, 'Eli', 120]]) await s.play(n, nick, time);
  await s.play(6, 'Lejos', 2000); // muy por encima de los demás
  await s.play(7, 'Tarde', 130, 2 * 3600); // la mandó dos horas después de terminar
  await s.play(8, 'Maximo', 7200);

  assert.equal((await s.call('GET', '/v1/admin/review')).status, 403, 'solo con la clave');
  const r = (await s.call('GET', '/v1/admin/review', undefined, 'secreta')).data;
  assert.equal(r.week, WEEK);
  const by = Object.fromEntries(r.rows.map((x) => [x.nick, x]));
  assert.deepEqual(by.Lejos.flags, ['lejos']);
  assert.deepEqual(by.Tarde.flags, ['tarde']);
  assert.ok(by.Tarde.late >= 7200 && by.Tarde.late < 7300, 'dice cuánto tardó en llegar');
  assert.deepEqual(by.Maximo.flags, ['lejos', 'tope']);
  for (const nick of ['Ana', 'Beto', 'Caro', 'Dani', 'Eli']) assert.deepEqual(by[nick].flags, [], nick + ' no tiene nada raro');
  assert.equal(by.Ana.uid, uid(1), 'trae el identificador, para poder vetar');
  assert.equal(r.rows[0].rank, 1);
  assert.equal((await s.call('GET', '/v1/cup')).data.total, 8, 'señalar no saca a nadie');
  assert.deepEqual(await review(memoryStore(), NOW), { week: WEEK, median: 0, rows: [], bans: [] }, 'sin marcas no falla');

  /* el panel la muestra, con los botones; y lo que se escribe en él va escapado */
  const page = await s.call('GET', '/panel?key=secreta');
  assert.equal(page.status, 200);
  assert.match(page.text, /para revisar/);
  assert.match(page.text, /muy por encima/);
  assert.match(page.text, new RegExp('data-do="ban" data-uid="' + uid(6) + '"'));
  assert.match(page.text, /Nadie\./, 'todavía no hay vetados');

  /* vetar desde el panel (lo que hace el botón) */
  assert.equal((await s.call('POST', '/v1/admin/ban', { uid: uid(6) }, 'secreta')).status, 200);
  const after = (await s.call('GET', '/v1/admin/review', undefined, 'secreta')).data;
  assert.equal(after.rows.some((x) => x.nick === 'Lejos'), false);
  assert.deepEqual(after.bans.map((b) => [b.uid, b.why]), [[uid(6), 'admin']]);
  assert.match((await s.call('GET', '/panel?key=secreta')).text, /vetado a mano/);
});

/* ---------- el tope de monedas ---------- */
test('cuánto vale un progreso: sus monedas más lo que cuestan sus piezas', () => {
  assert.equal(wealthOf({ coins: 250 }), 250);
  assert.equal(wealthOf({ coins: 250, parts: ['ship.caza'] }), 10250, 'una nave única cuesta 10.000');
  assert.equal(wealthOf({ coins: 0, parts: ['ship.caza', 'ship.caza'] }), 10000, 'repetida no cuenta dos veces');
  assert.equal(wealthOf({ coins: 10, parts: ['pieza.que.no.existe', 7, null, {}] }), 10, 'lo desconocido cuenta como gratis');
  assert.equal(wealthOf({ coins: 'muchas', parts: 'todas' }), 0);
  assert.equal(wealthOf({}), 0);
});

test('el cupo: se llena con el reloj, se gasta con lo que se gana, y lo comprado no lo gasta', () => {
  /* primer guardado de una cuenta */
  const first = judge(null, 5000, 0, NOW);
  assert.deepEqual(first, { ok: true, next: { wealth: 5000, room: START, at: NOW, bought: 0, trusted: 0 } });
  assert.equal(judge(null, FIRST + 1, 0, NOW).ok, false, 'un primer guardado millonario no');
  assert.equal(judge(null, FIRST + 8000, 8000, NOW).ok, true, 'salvo que lo haya comprado');

  /* jugar: gana menos de lo que deja el reloj */
  const hour = judge(first.next, 5000 + 3000, 0, NOW + 3600000);
  assert.equal(hour.ok, true);
  assert.equal(hour.next.room, START + RATE * 3600 - 3000, 'el cupo creció una hora y gastó lo ganado');
  /* gastar monedas en piezas no cambia lo que vale: no gasta cupo */
  assert.equal(judge(hour.next, 8000, 0, NOW + 3600000).next.room, hour.next.room);
  /* perder valor (trajo un progreso más viejo) tampoco da cupo de más */
  assert.equal(judge(hour.next, 100, 0, NOW + 3600000).next.room, hour.next.room);
  /* el cupo no crece sin fin */
  assert.equal(judge(first.next, 5000, 0, NOW + 365 * 86400000).next.room, ROOM);

  /* retocar el archivo: 500.000 monedas de un guardado al siguiente */
  const edit = judge(hour.next, 508000, 0, NOW + 3660000);
  assert.equal(edit.ok, false);
  assert.equal(edit.next.room, 0);
  assert.ok(edit.next.wealth < 508000, 'queda anotado hasta donde sí cabía');
  assert.equal(judge(edit.next, 508000, 0, NOW + 3720000).ok, false, 'los guardados que siguen con lo mismo también se pasan');
  /* comprar con plata: sube lo que vale sin gastar cupo */
  const paid = judge(hour.next, 8000 + 8000, 8000, NOW + 3600000);
  assert.equal(paid.ok, true);
  assert.equal(paid.next.room, hour.next.room);
  assert.equal(paid.next.bought, 8000);
  /* le levantaron el veto: lo que tenga se da por bueno, una vez */
  const forgiven = judge({ ...edit.next, trusted: 1 }, 508000, 0, NOW + 3720000);
  assert.deepEqual(forgiven, { ok: true, next: { wealth: 508000, room: START, at: NOW + 3720000, bought: 0, trusted: 0 } });
});

test('un progreso retocado se guarda, pero esa instalación queda fuera de la copa hasta que se le levante', async () => {
  for (const store of [memoryStore(), d1Store(fakeD1())]) {
    const s = await server(store);
    const ana = await s.login('1001');
    /* juega normal: guarda, entra a la copa */
    assert.equal((await s.save(ana, { uid: uid(1), coins: 400, parts: [] })).status, 200);
    assert.equal((await s.play(1, 'Ana', 120)).data.saved, true);
    s.env.now += 3600000;
    assert.equal((await s.save(ana, { uid: uid(1), coins: 900, parts: ['ship.caza'] })).status, 200, 'una hora después: 500 más y una nave que no cabía... ');
    assert.equal(await s.env.store.banned(uid(1)), false, '...pero el cupo inicial la cubre');

    /* retoca el archivo del teléfono: un millón de monedas */
    s.env.now += 60000;
    const cheat = await s.save(ana, { uid: uid(1), coins: 1000900, parts: ['ship.caza'] });
    assert.equal(cheat.status, 200, 'el progreso se guarda igual');
    assert.equal((await s.call('GET', '/v1/save', undefined, ana)).data.data.coins, 1000900, 'y no se le borra nada');
    assert.equal(await s.env.store.banned(uid(1)), true);
    assert.equal((await s.call('GET', '/v1/cup')).data.total, 0, 'su marca sale de la tabla');
    assert.equal((await s.play(1, 'Ana', 300)).data.saved, false, 'y no se le guardan más');
    const r = (await s.call('GET', '/v1/admin/review', undefined, 'secreta')).data;
    assert.deepEqual(r.bans.map((b) => [b.uid, b.why]), [[uid(1), 'monedas']], 'aparece en el panel con el motivo');
    assert.match((await s.call('GET', '/panel?key=secreta')).text, /monedas o piezas que no cuadran/);

    /* otra persona, que no hizo nada, sigue normal */
    const beto = await s.login('2002');
    await s.save(beto, { uid: uid(2), coins: 300, parts: [] });
    assert.equal((await s.play(2, 'Beto', 90)).data.saved, true);

    /* fue un error: se le levanta desde el panel y no vuelve a caer con el mismo progreso */
    assert.equal((await s.call('POST', '/v1/admin/unban', { uid: uid(1) }, 'secreta')).status, 200);
    s.env.now += 60000;
    await s.save(ana, { uid: uid(1), coins: 1000950, parts: ['ship.caza'] });
    assert.equal(await s.env.store.banned(uid(1)), false, 'lo que tenía se dio por bueno');
    assert.equal((await s.play(1, 'Ana', 150)).data.saved, true);
    /* pero si vuelve a retocarlo, vuelve a caer */
    s.env.now += 60000;
    await s.save(ana, { uid: uid(1), coins: 3000000, parts: ['ship.caza'] });
    assert.equal(await s.env.store.banned(uid(1)), true);

    /* borrar la cuenta se lleva también su renglón del tope */
    assert.ok(await s.env.store.ledger((await s.env.store.session(await sha256(beto))).account));
  }
});

test('todas las piezas de golpe también se nota; lo comprado con plata no', async () => {
  const s = await server();
  const ana = await s.login('1001');
  await s.save(ana, { uid: uid(1), coins: 100, parts: [] });
  s.env.now += 600000;
  /* el catálogo entero, diez minutos después */
  const all = Object.values(PRICES).flat();
  assert.ok(all.length > 250 && wealthOf({ coins: 0, parts: all }) > ROOM, 'el catálogo vale más que todo el cupo posible');
  await s.save(ana, { uid: uid(1), coins: 100, parts: all });
  assert.equal(await s.env.store.banned(uid(1)), true);
  assert.equal((await s.env.store.bans(10))[0].why, 'monedas');

  /* compras de verdad: el servidor las tiene anotadas a nombre de esa instalación */
  const beto = await s.login('2002'),
    who = await sha256(uid(2));
  await s.save(beto, { uid: uid(2), coins: 100, parts: [] });
  for (let i = 0; i < 10; i++) {
    await s.env.store.putPurchase('compra' + i, 'coins_l', 'GPA.' + i, s.env.now);
    await s.env.store.claimPurchase('compra' + i, who);
  }
  s.env.now += 60000;
  await s.save(beto, { uid: uid(2), coins: 100 + 10 * 8000, parts: [] });
  assert.ok(10 * 8000 > START + RATE * 60, 'más de lo que cabría sin haberlo comprado');
  assert.equal(await s.env.store.banned(uid(2)), false, 'diez cofres de monedas comprados: 80.000 de un minuto al otro, y está bien');
  s.env.now += 60000;
  await s.save(beto, { uid: uid(2), coins: 100 + 20 * 8000, parts: [] });
  assert.equal(await s.env.store.banned(uid(2)), true, 'pero las mismas compras no valen dos veces');
});

test('«sin anuncios» en el progreso sin que exista la compra', async () => {
  const s = await server();
  const DAY = 86400000;
  /* para siempre, sin compra */
  const ana = await s.login('1001');
  await s.save(ana, { uid: uid(1), coins: 100, noAds: true });
  assert.equal(await s.env.store.banned(uid(1)), true);
  assert.equal((await s.env.store.bans(10))[0].why, 'sin anuncios');
  /* con la compra a su nombre */
  const beto = await s.login('2002');
  await s.env.store.putPurchase('c1', 'no_ads', 'GPA.1', s.env.now);
  await s.env.store.claimPurchase('c1', await sha256(uid(2)));
  await s.save(beto, { uid: uid(2), coins: 100, noAds: true });
  assert.equal(await s.env.store.banned(uid(2)), false);
  /* recuperada en otro teléfono de la misma persona */
  const caro = await s.login('3003');
  await s.env.store.addClaim('c1', await sha256(uid(3)), s.env.now, 5);
  await s.save(caro, { uid: uid(3), coins: 100, noAds: true });
  assert.equal(await s.env.store.banned(uid(3)), false);
  /* el mes: no puede durar más que los meses comprados */
  const dani = await s.login('4004');
  await s.save(dani, { uid: uid(4), coins: 100, noAdsUntil: s.env.now + 400 * DAY });
  assert.equal(await s.env.store.banned(uid(4)), true, 'un año sin anuncios sin haber comprado ningún mes');
  const eli = await s.login('5005');
  await s.env.store.putPurchase('c2', 'no_ads_30', 'GPA.2', s.env.now);
  await s.env.store.claimPurchase('c2', await sha256(uid(5)));
  await s.save(eli, { uid: uid(5), coins: 100, noAdsUntil: s.env.now + 30 * DAY + 3600000 });
  assert.equal(await s.env.store.banned(uid(5)), false, 'un mes comprado, un mes (con la hora del teléfono un poco corrida)');
  /* un progreso sin identificador de instalación no veta a nadie ni rompe el guardado */
  const fer = await s.login('6006');
  assert.equal((await s.save(fer, { coins: 5000000 })).status, 200);
  assert.equal((await s.env.store.bans(10)).length, 2);
});

test('si la revisión del progreso falla, el guardado no se pierde', async () => {
  const s = await server();
  const ana = await s.login('1001');
  s.env.store.ledger = async () => {
    throw new Error('la base no responde');
  };
  const r = await s.save(ana, { uid: uid(1), coins: 400 });
  assert.equal(r.status, 200);
  assert.equal((await s.call('GET', '/v1/save', undefined, ana)).data.data.coins, 400);
});
