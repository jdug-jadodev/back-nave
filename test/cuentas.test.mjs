/**
 * Las cuentas: iniciar sesión con Google y guardar el progreso. Aquí "Google" es un par de llaves
 * hecho para la prueba: se firman comprobantes como los firmaría Google y se revisa que el
 * servidor acepte solo los buenos.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStore } from '../src/almacenes.js';
import { MAX_AUTH, MAX_SAVE, NONCE_LIFE, SESSION_LIFE, SLOT, sha256 } from '../src/cuentas.js';
import { handle } from '../src/reglas.js';

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
  return { env, call, login, google };
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
  assert.equal((await s.call('DELETE', '/v1/account', undefined, a)).status, 200);
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
