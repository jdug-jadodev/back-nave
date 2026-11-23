/**
 * Las cuentas: iniciar sesión con Google y guardar el progreso. Aquí "Google" es un par de llaves
 * hecho para la prueba: se firman comprobantes como los firmaría Google y se revisa que el
 * servidor acepte solo los buenos.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '../src/almacenes.js';
import { MAX_AUTH, MAX_SAVE, NONCE_LIFE, SESSION_LIFE, SESSION_MAX, SLOT, cleanSave, keyRing, sha256 } from '../src/cuentas.js';
import { clientKey } from '../src/limites.js';
import { cleanup, handle } from '../src/reglas.js';

const NOW = Date.UTC(2026, 10, 22, 15, 0);
const CLIENT = 'giro-estelar-prueba.apps.googleusercontent.com';
const b64url = (data) => Buffer.from(data).toString('base64url');

/* un "Google" de mentira: firma comprobantes y publica su llave */
async function fakeGoogle(kid = 'llave-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  const token = async (claims, head = {}) => {
    const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...head })),
      p = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 3600, iat: NOW / 1000, ...claims })),
      sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(h + '.' + p));
    return h + '.' + p + '.' + b64url(new Uint8Array(sig));
  };
  return { jwk, token };
}
async function server() {
  const google = await fakeGoogle();
  const env = {
    store: memoryStore(),
    now: NOW,
    adminKey: 'secreta',
    secret: 'secreto-de-prueba',
    googleIds: [CLIENT],
    googleKeys: async () => [google.jwk],
    ip: '10.0.0.1',
  };
  const call = async (method, path, data, session) => {
    const r = await handle(
      new Request('http://x' + path, {
        method,
        headers: session ? { authorization: 'Bearer ' + session } : {},
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
    );
    return { status: r.status, data: JSON.parse(await r.text()) };
  };
  /* inicia sesión como una persona (su número de cuenta de Google) */
  const login = async (sub, claims = {}) => {
    const nonce = (await call('POST', '/v1/auth/nonce')).data.nonce;
    return call('POST', '/v1/auth/google', { idToken: await google.token({ sub, nonce, ...claims }) });
  };
  /* un comprobante de Google recién sacado, para lo que pide volver a confirmar quién es */
  const proof = async (sub) => ({ idToken: await google.token({ sub, nonce: (await call('POST', '/v1/auth/nonce')).data.nonce }) });
  return { env, call, login, proof, google };
}

test('entrar con Google crea la cuenta; volver a entrar encuentra la misma', async () => {
  const s = await server();
  const a = await s.login('1001');
  assert.equal(a.status, 200);
  assert.equal(a.data.fresh, true);
  assert.deepEqual(a.data.save, { version: 0, at: 0, data: null });
  assert.match(a.data.session, /^[A-Za-z0-9_-]{40,}$/);

  await s.call('PUT', '/v1/save', { data: { coins: 250, xp: 1200 }, base: 0 }, a.data.session);
  const again = await s.login('1001');
  assert.equal(again.data.fresh, false, 'ya existía');
  assert.deepEqual(again.data.save.data, { coins: 250, xp: 1200 }, 'trae su progreso');
  assert.notEqual(again.data.session, a.data.session, 'cada inicio da una llave nueva');

  const other = await s.login('2002');
  assert.equal(other.data.fresh, true, 'otra persona, otra cuenta');
  assert.equal(other.data.save.data, null);
});

test('no se guarda nada que identifique a la persona, ni la llave de sesión', async () => {
  const s = await server();
  const a = await s.login('123456789012345678901', { email: 'alguien@example.com', name: 'Alguien' });
  await s.call('PUT', '/v1/save', { data: { coins: 5 }, base: 0 }, a.data.session);
  /* todo lo que el almacén tiene, mirado por dentro a través de sus propias respuestas */
  const hash = await sha256(a.data.session),
    session = await s.env.store.session(hash),
    dump = JSON.stringify([session, await s.env.store.getSave(session.account)]);
  assert.ok(session, 'la sesión se encuentra por la huella de la llave');
  assert.equal(await s.env.store.session(a.data.session), null, 'y no por la llave misma');
  assert.equal(await s.env.store.accountBySub('123456789012345678901'), null, 'el número de Google no está tal cual');
  for (const secret of ['123456789012345678901', 'alguien@example.com', 'Alguien', a.data.session])
    assert.ok(!dump.includes(secret), 'no aparece: ' + secret);
});

test('un comprobante falso, ajeno, vencido o repetido no entra', async () => {
  const s = await server();
  const nonce = async () => (await s.call('POST', '/v1/auth/nonce')).data.nonce;
  const tryWith = async (idToken) => (await s.call('POST', '/v1/auth/google', { idToken })).status;

  const good = await s.google.token({ sub: '1', nonce: await nonce() });
  assert.equal(await tryWith(good), 200);
  assert.equal(await tryWith(good), 401, 'el mismo comprobante no sirve dos veces (número de un solo uso)');

  assert.equal(await tryWith(await s.google.token({ sub: '1' })), 401, 'sin número de un solo uso');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: 'inventado' })), 401, 'con un número que no dio el servidor');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: await nonce(), aud: 'otra-app' })), 401, 'hecho para otra app');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: await nonce(), iss: 'https://malo.example' })), 401, 'no lo emitió Google');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: await nonce(), exp: NOW / 1000 - 1 })), 401, 'vencido');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: await nonce(), iat: NOW / 1000 + 3600 })), 401, 'con fecha futura');

  /* firmado por otro que dice ser Google */
  const impostor = await fakeGoogle('llave-1');
  assert.equal(await tryWith(await impostor.token({ sub: '1', nonce: await nonce() })), 401, 'firma de otro');
  /* cambiar el contenido después de firmar */
  const [h, , sig] = good.split('.');
  const forged = h + '.' + b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 3600, sub: '999', nonce: await nonce() })) + '.' + sig;
  assert.equal(await tryWith(forged), 401, 'contenido cambiado');
  /* "sin firma" */
  const none = b64url(JSON.stringify({ alg: 'none', kid: 'llave-1' })) + '.' + good.split('.')[1] + '.';
  assert.equal(await tryWith(none), 401, 'sin firma');
  assert.equal(await tryWith(await s.google.token({ sub: '1', nonce: await nonce() }, { alg: 'HS256' })), 401, 'otro tipo de firma');
  assert.equal(await tryWith('no.es.nada'), 401);
  assert.equal(await tryWith(undefined), 401);
});

test('el número de un solo uso vence', async () => {
  const s = await server();
  const nonce = (await s.call('POST', '/v1/auth/nonce')).data.nonce;
  s.env.now = NOW + NONCE_LIFE + 1000;
  const token = await s.google.token({ sub: '1', nonce, exp: s.env.now / 1000 + 3600, iat: s.env.now / 1000 });
  assert.equal((await s.call('POST', '/v1/auth/google', { idToken: token })).status, 401);
});

test('sin llave de sesión no se lee ni se guarda nada', async () => {
  const s = await server();
  const a = await s.login('1');
  await s.call('PUT', '/v1/save', { data: { coins: 9 }, base: 0 }, a.data.session);
  assert.equal((await s.call('GET', '/v1/save')).status, 401, 'sin llave');
  assert.equal((await s.call('GET', '/v1/save', undefined, 'x'.repeat(43))).status, 401, 'llave inventada');
  assert.equal((await s.call('PUT', '/v1/save', { data: { coins: 1e9 }, base: 1 })).status, 401);
  assert.equal((await s.call('DELETE', '/v1/account')).status, 401);
  /* la llave de uno no abre la cuenta de otro */
  const b = await s.login('2');
  assert.equal((await s.call('GET', '/v1/save', undefined, b.data.session)).data.data, null);
  assert.deepEqual((await s.call('GET', '/v1/save', undefined, a.data.session)).data.data, { coins: 9 });
});

test('guardar: sube la versión, y dos teléfonos no se pisan', async () => {
  const s = await server();
  const phone1 = (await s.login('1')).data.session,
    phone2 = (await s.login('1')).data.session;
  const first = await s.call('PUT', '/v1/save', { data: { coins: 10 }, base: 0 }, phone1);
  assert.deepEqual(first.data, { version: 1, at: NOW });
  assert.equal((await s.call('PUT', '/v1/save', { data: { coins: 20 }, base: 1 }, phone1)).data.version, 2);
  /* el segundo teléfono todavía cree que no hay nada guardado */
  const clash = await s.call('PUT', '/v1/save', { data: { coins: 1 }, base: 0 }, phone2);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.version, 2);
  assert.deepEqual(clash.data.data, { coins: 20 }, 'recibe lo que hay, para decidir');
  assert.deepEqual((await s.call('GET', '/v1/save', undefined, phone2)).data.data, { coins: 20 }, 'y no se guardó lo suyo');
  /* con la versión correcta sí */
  assert.equal((await s.call('PUT', '/v1/save', { data: { coins: 21 }, base: 2 }, phone2)).data.version, 3);
});

test('guardar: se rechaza lo que no es un progreso razonable', async () => {
  const s = await server();
  const k = (await s.login('1')).data.session;
  const put = async (payload) => (await s.call('PUT', '/v1/save', payload, k)).status;
  assert.equal(await put({ data: 'texto', base: 0 }), 400);
  assert.equal(await put({ data: [1, 2], base: 0 }), 400);
  assert.equal(await put({ base: 0 }), 400);
  assert.equal(await put({ data: { a: 1 }, base: -1 }), 400);
  assert.equal(await put({ data: { a: 1 }, base: 'x' }), 400);
  assert.equal(await put({ data: { junk: 'x'.repeat(MAX_SAVE) }, base: 0 }), 400, 'demasiado grande');
  assert.equal(await put({ data: { ok: 'x'.repeat(MAX_SAVE - 200) }, base: 0 }), 200, 'cerca del tope, entra');
});

test('cerrar sesión deja la llave sin efecto; las demás sesiones siguen', async () => {
  const s = await server();
  const a = (await s.login('1')).data.session,
    b = (await s.login('1')).data.session;
  assert.equal((await s.call('POST', '/v1/auth/logout', undefined, a)).status, 200);
  assert.equal((await s.call('GET', '/v1/save', undefined, a)).status, 401);
  assert.equal((await s.call('GET', '/v1/save', undefined, b)).status, 200);
});

test('la sesión vence si no se usa, y se renueva si se usa', async () => {
  const s = await server();
  const k = (await s.login('1')).data.session;
  s.env.now = NOW + SESSION_LIFE - 86400000; // un día antes de vencer: se usa y se renueva
  assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 200);
  s.env.now = NOW + SESSION_LIFE + 30 * 86400000; // un mes después de cuando habría vencido
  assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 200, 'seguía viva por haberse usado');
  s.env.now += SESSION_LIFE + 1000; // y ahora sí, seis meses sin usarla
  assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 401);
});

test('borrar la cuenta se lleva el progreso y todas las sesiones', async () => {
  const s = await server();
  const a = (await s.login('1')).data.session,
    b = (await s.login('1')).data.session;
  await s.call('PUT', '/v1/save', { data: { coins: 77 }, base: 0 }, a);
  assert.equal((await s.call('DELETE', '/v1/account', await s.proof('1'), a)).status, 200);
  assert.equal((await s.call('GET', '/v1/save', undefined, a)).status, 401);
  assert.equal((await s.call('GET', '/v1/save', undefined, b)).status, 401, 'la otra sesión también se cerró');
  const again = await s.login('1');
  assert.equal(again.data.fresh, true, 'si vuelve a entrar, empieza de cero');
  assert.equal(again.data.save.data, null);
});

test('demasiados intentos de entrar desde la misma dirección se frenan', async () => {
  const s = await server();
  let last;
  for (let i = 0; i <= MAX_AUTH; i++) last = await s.call('POST', '/v1/auth/nonce');
  assert.equal(last.status, 429);
  s.env.ip = '10.0.0.2';
  assert.equal((await s.call('POST', '/v1/auth/nonce')).status, 200, 'otra dirección no se ve afectada');
  s.env.ip = '10.0.0.1';
  s.env.now = NOW + SLOT;
  assert.equal((await s.call('POST', '/v1/auth/nonce')).status, 200, 'pasada la ventana, vuelve a poder');
});

test('sin configurar, las cuentas están apagadas y lo demás sigue funcionando', async () => {
  const env = { store: memoryStore(), now: NOW, adminKey: 'k' };
  const r = await handle(new Request('http://x/v1/auth/nonce', { method: 'POST' }), env);
  assert.equal(r.status, 503);
  const cup = await handle(new Request('http://x/v1/cup'), env);
  assert.equal(cup.status, 200);
});

test('borrar la cuenta pide, además de la llave, volver a confirmar con Google que es esa persona', async () => {
  const s = await server();
  const k = (await s.login('1')).data.session;
  await s.login('2');
  await s.call('PUT', '/v1/save', { data: { coins: 77 }, base: 0 }, k);
  const del = async (payload) => (await s.call('DELETE', '/v1/account', payload, k)).status;
  assert.equal(await del(undefined), 403, 'con la llave sola (una llave robada) no se borra');
  assert.equal(await del({ idToken: 'no.es.nada' }), 403);
  assert.equal(await del({ idToken: await s.google.token({ sub: '1' }) }), 403, 'comprobante sin número de un solo uso');
  assert.equal(await del({ idToken: await s.google.token({ sub: '1', nonce: 'inventado' }) }), 403);
  assert.equal(await del(await s.proof('2')), 403, 'comprobante de OTRA persona');
  const used = await s.proof('1');
  assert.equal((await s.call('POST', '/v1/auth/google', used)).status, 200);
  assert.equal(await del(used), 403, 'un comprobante ya usado no sirve');
  assert.deepEqual((await s.call('GET', '/v1/save', undefined, k)).data.data, { coins: 77 }, 'nada se borró');
  assert.equal(await del(await s.proof('1')), 200, 'con el comprobante fresco de la misma persona, sí');
  assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 401);
});

test('cerrar sesión en todos los teléfonos deja sin efecto todas las llaves de esa cuenta', async () => {
  const s = await server();
  const a = (await s.login('1')).data.session,
    b = (await s.login('1')).data.session,
    other = (await s.login('2')).data.session;
  assert.equal((await s.call('POST', '/v1/auth/logout-all')).status, 401, 'sin llave, nada');
  assert.equal((await s.call('POST', '/v1/auth/logout-all', undefined, a)).status, 200);
  assert.equal((await s.call('GET', '/v1/save', undefined, a)).status, 401);
  assert.equal((await s.call('GET', '/v1/save', undefined, b)).status, 401, 'la del otro teléfono (o la robada) también');
  assert.equal((await s.call('GET', '/v1/save', undefined, other)).status, 200, 'las de otra cuenta siguen');
  assert.equal((await s.login('1')).data.fresh, false, 'la cuenta y su progreso siguen ahí');
});

test('ninguna sesión vive más de un año, por mucho que se use', async () => {
  const s = await server();
  const k = (await s.login('1')).data.session;
  const DAY = 86400000;
  /* se usa cada tres meses o así: se renueva cada vez que le queda menos de la mitad */
  for (const days of [100, 200, 270, 360]) {
    s.env.now = NOW + days * DAY;
    assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 200, 'día ' + days);
  }
  s.env.now = NOW + SESSION_MAX + 1000;
  assert.equal((await s.call('GET', '/v1/save', undefined, k)).status, 401, 'al año hay que volver a entrar con Google');
  const again = await s.login('1', { exp: s.env.now / 1000 + 3600, iat: s.env.now / 1000 });
  assert.equal(again.data.fresh, false, 'la cuenta sigue ahí');
});

test('guardar: no entra lo que un juego de verdad nunca mandaría', async () => {
  const s = await server();
  const k = (await s.login('1')).data.session;
  const put = async (data) => (await s.call('PUT', '/v1/save', { data, base: 0 }, k)).status;
  assert.equal(await put({ coins: '<img src=x onerror=alert(1)>' }), 400, 'las monedas son un número');
  assert.equal(await put({ coins: -5 }), 400);
  assert.equal(await put({ coins: 1e12 }), 400);
  assert.equal(await put({ coins: 10, xp: 'mucho' }), 400);
  assert.equal(await put({ coins: 10, cup: { nick: '<script>x</script>' } }), 400, 'ningún texto con < >, a ninguna profundidad');
  assert.equal(await put({ coins: 10, duels: [{ code: 'ABC234', rival: { nick: 'a<b' } }] }), 400);
  assert.equal(await put({ coins: 10, '<b>': 1 }), 400, 'tampoco en los nombres');
  let deep = { fin: 1 };
  for (let i = 0; i < 40; i++) deep = { d: deep };
  assert.equal(await put({ coins: 10, deep }), 400, 'anidado de más');
  /* el tamaño se mide en bytes: 9.000 "€" son 27.000 */
  assert.equal(await put({ coins: 10, t: '€'.repeat(9000) }), 400);
  /* y un progreso normal entra */
  const real = {
    coins: 12500, xp: 4300, bossWins: 3, streak: 4, runs: 51, best: 212, noAdsUntil: NOW + 30 * 86400000, noAds: false,
    owned: ['aurora'], parts: ['paint.espectro', 'wing.halcón'], fit: { paint: 'paint.espectro' }, topTimes: [212.5, 180],
    nick: 'Ñandú_7', uid: 'abcdefgh12345678', cup: { week: '2026-11-16', rank: 3, total: 20 }, duels: [{ code: 'ABC234', n: 2 }],
    first: '2026-11-01', seen: [0, 1, 4], worlds: { hielo: 1 }, paid: { x: 1 },
  };
  assert.equal(await put(real), 200);
  assert.deepEqual((await s.call('GET', '/v1/save', undefined, k)).data.data, real, 'y vuelve tal cual');
  assert.equal(cleanSave({ coins: 1 }), '{"coins":1}');
});

test('un envío enorme se rechaza por su tamaño declarado, sin leerlo', async () => {
  const s = await server();
  let pulled = 0;
  const huge = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(65536));
    },
  });
  const r = await handle(
    new Request('http://x/v1/auth/google', { method: 'POST', headers: { 'content-length': String(40 * 1024 * 1024) }, body: huge, duplex: 'half' }),
    s.env,
  );
  assert.equal(r.status, 400);
  assert.ok(pulled <= 2, 'no se leyó (el navegador prepara un pedazo, nada más): ' + pulled);
  /* y si miente sobre el tamaño, se deja de leer en cuanto se pasa */
  let chunks = 0;
  const liar = new ReadableStream({
    pull(c) {
      chunks++;
      c.enqueue(new Uint8Array(4096).fill(32));
    },
  });
  const r2 = await handle(new Request('http://x/v1/auth/google', { method: 'POST', body: liar, duplex: 'half' }), s.env);
  assert.equal(r2.status, 400);
  assert.ok(chunks < 10, 'leyó ' + chunks + ' pedazos y paró');
});

test('los límites cuentan una red IPv6 entera como un solo cliente, y lo frenado no escribe', async () => {
  assert.equal(clientKey('2001:db8:aa:bb:1:2:3:4'), clientKey('2001:db8:aa:bb:ffff::9'), 'mismo bloque /64');
  assert.notEqual(clientKey('2001:db8:aa:bb::1'), clientKey('2001:db8:aa:bc::1'), 'otro bloque');
  assert.equal(clientKey('2001:0db8:00aa:00bb::1'), clientKey('2001:db8:aa:bb::1'), 'escrita con ceros');
  assert.equal(clientKey('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(clientKey('10.1.2.3'), '10.1.2.3');
  assert.equal(clientKey(''), 'local');
  const s = await server();
  let last;
  for (let i = 0; i <= MAX_AUTH + 60; i++) {
    s.env.ip = '2001:db8:aa:bb::' + i.toString(16); // una dirección distinta cada vez, del mismo bloque
    last = await s.call('POST', '/v1/auth/nonce');
  }
  assert.equal(last.status, 429, 'cambiar de dirección dentro del bloque no sirve');
  const slot = Math.floor(NOW / SLOT);
  assert.equal(await s.env.store.peek('auth:' + clientKey('2001:db8:aa:bb::1'), slot), MAX_AUTH, 'el contador paró en el tope: lo frenado no escribe');
  s.env.ip = '2001:db8:aa:bc::1';
  assert.equal((await s.call('POST', '/v1/auth/nonce')).status, 200, 'otro bloque no se ve afectado');
});

test('lo vencido lo bota la limpieza diaria, sin depender de que alguien inicie sesión', async () => {
  const s = await server();
  const stale = (await s.call('POST', '/v1/auth/nonce')).data.nonce,
    k = (await s.login('1')).data.session;
  s.env.now = NOW + SESSION_LIFE + 5 * 86400000;
  await cleanup(s.env.store, s.env.now);
  assert.equal(await s.env.store.session(await sha256(k)), null, 'la sesión vencida ya no está guardada');
  assert.equal(await s.env.store.takeNonce(await sha256(stale), 0), false, 'ni el número de un solo uso que nadie usó');
  assert.equal(await s.env.store.peek('auth:' + clientKey('10.0.0.1'), Math.floor(NOW / SLOT)), 0, 'ni los contadores de entonces');
});

test('las llaves de Google se vuelven a pedir como mucho una vez por minuto', async () => {
  let now = 1000000,
    loads = 0;
  const ring = keyRing(async () => {
    loads++;
    return [{ kid: 'k' + loads }];
  }, () => now);
  assert.deepEqual(await ring(false), [{ kid: 'k1' }]);
  for (let i = 0; i < 25; i++) await ring(true); // 25 comprobantes con una llave desconocida
  assert.equal(loads, 1, 'no se descargan otra vez por cada comprobante inventado');
  now += 61000;
  await ring(true);
  assert.equal(loads, 2, 'pasado un minuto, sí (por si Google cambió de llaves)');
  await ring(false);
  assert.equal(loads, 2);
  now += 3600000;
  await ring(false);
  assert.equal(loads, 3, 'y cada hora se refrescan solas');
  /* si Google no responde, se sigue con las que había y se reintenta pronto */
  const flaky = keyRing(async () => {
    throw new Error('sin red');
  }, () => now);
  assert.deepEqual(await flaky(false), []);
});
