/**
 * Las compras: el servidor solo entrega lo que Google confirma como pagado, una sola vez y solo
 * a quien la compró. Aquí "Google Play" es de mentira: una lista de compras en memoria que
 * contesta como la API real.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d1Store, memoryStore } from '../src/almacenes.js';
import { MAX_DEVICES } from '../src/compras.js';
import { sha256 } from '../src/cuentas.js';
import { handle } from '../src/reglas.js';
import { fakeD1 } from './apoyo/d1.mjs';

const NOW = Date.UTC(2026, 10, 22, 18, 0);
const PKG = 'com.giroestelar';
const tok = (name) => (name + '-').repeat(40).slice(0, 40);
/* instalaciones del juego (su identificador anónimo, el de la copa) */
const phone = (n) => 'telefono' + String(n).padStart(12, '0');
const ANA = phone(1),
  BETO = phone(2);

/* la credencial del servidor, hecha para la prueba */
async function serviceKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return {
    client_email: 'servidor@prueba.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\n' + der.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}
/* Google Play de mentira.
   sales[token] = { product, state (0 pagada, 1 cancelada, 2 pendiente), consumed, acked, account (quién compró, si la app lo dijo) }
   setDown(true)    Google no responde a nada
   setStuck(true)   Google consulta bien pero no deja cerrar (consumir o reconocer)
   setLoose(true)   un Google que NO revisa que el comprobante sea del producto pedido (y dice cuál es) */
function fakePlay() {
  const sales = {},
    calls = [];
  let down = false,
    stuck = false,
    loose = false;
  const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fetcher = async (url, init = {}) => {
    calls.push((init.method || 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, ''));
    if (down) return reply({}, 503);
    if (url.includes('oauth2.googleapis.com/token')) {
      assert.match(init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
      return reply({ access_token: 'pase-de-prueba', expires_in: 3600 });
    }
    assert.equal(init.headers.authorization, 'Bearer pase-de-prueba', 'la consulta lleva el pase');
    const m = /applications\/([^/]+)\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:\w+)?$/.exec(url);
    if (!m || m[1] !== PKG) return reply({}, 404);
    const sale = sales[decodeURIComponent(m[3])];
    if (!sale || (!loose && sale.product !== m[2])) return reply({}, 404); // el comprobante no es de ese producto
    if (m[4] && stuck) return reply({}, 500);
    if (m[4] === ':consume') sale.consumed = true;
    else if (m[4] === ':acknowledge') sale.acked = true;
    else
      return reply({
        purchaseState: sale.state,
        consumptionState: sale.consumed ? 1 : 0,
        acknowledgementState: sale.acked ? 1 : 0,
        orderId: 'GPA.0000-' + m[3].slice(0, 6),
        purchaseTimeMillis: String(NOW - 5000),
        ...(sale.account ? { obfuscatedExternalAccountId: sale.account } : {}),
        ...(loose ? { productId: sale.product } : {}),
      });
    return reply({});
  };
  const asked = () => calls.filter((c) => c.startsWith('GET ')).length; // cuántas veces se le preguntó por una compra
  return { sales, calls, asked, fetcher, setDown: (v) => (down = v), setStuck: (v) => (stuck = v), setLoose: (v) => (loose = v) };
}
async function server(store = memoryStore()) {
  const play = fakePlay();
  const env = { store, now: NOW, adminKey: 'k', ip: '10.0.0.9', playKey: await serviceKey(), playPackage: PKG, playFetch: play.fetcher };
  const call = async (path, data) => {
    const r = await handle(new Request('http://x' + path, { method: 'POST', body: JSON.stringify(data) }), env);
    return { status: r.status, data: JSON.parse(await r.text()) };
  };
  return {
    env,
    play,
    call,
    buy: (productId, token, uid = ANA) => call('/v1/purchase', { productId, token, uid }),
    done: (productId, token, uid = ANA) => call('/v1/purchase/done', { productId, token, uid }),
  };
}

test('una compra pagada se entrega una sola vez, y se gasta en Google antes de entregarla', async () => {
  const s = await server();
  s.play.sales[tok('a')] = { product: 'coins_m', state: 0 };
  const first = await s.buy('coins_m', tok('a'));
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { status: 'grant', grant: { kind: 'coins', coins: 2800 } });
  assert.equal(s.play.sales[tok('a')].consumed, true, 'ya quedó gastada en Google: no queda abierta ni se devuelve sola');
  /* si el juego se cierra antes de avisar, al volver recibe lo mismo: no se pierde */
  assert.equal((await s.buy('coins_m', tok('a'))).data.status, 'grant');
  assert.equal((await s.done('coins_m', tok('a'))).status, 200);
  /* y después ya no hay nada que dar, las veces que se pida */
  assert.deepEqual((await s.buy('coins_m', tok('a'))).data, { status: 'done' });
  assert.deepEqual((await s.buy('coins_m', tok('a'))).data, { status: 'done' });
});

test('lo que no está pagado no se entrega', async () => {
  const s = await server();
  s.play.sales[tok('p')] = { product: 'coins_s', state: 2 };
  s.play.sales[tok('c')] = { product: 'coins_s', state: 1 };
  assert.deepEqual((await s.buy('coins_s', tok('p'))).data, { status: 'pending' }, 'pago lento: todavía no');
  assert.equal((await s.buy('coins_s', tok('c'))).status, 402, 'cancelada');
  assert.equal((await s.buy('coins_s', tok('inventado'))).status, 402, 'Google no la conoce');
  /* cuando el pago lento se confirma, entonces sí */
  s.play.sales[tok('p')].state = 0;
  assert.equal((await s.buy('coins_s', tok('p'))).data.status, 'grant');
});

test('un comprobante no sirve para otro producto ni para pedir de más', async () => {
  const s = await server();
  s.play.sales[tok('s')] = { product: 'coins_s', state: 0 };
  assert.equal((await s.buy('coins_l', tok('s'))).status, 402, 'compró la bolsa pequeña: no recibe el cofre');
  assert.equal((await s.buy('coins_s', tok('s'))).data.grant.coins, 1200, 'la cantidad la pone el servidor');
  assert.equal((await s.buy('monedas_infinitas', tok('s'))).status, 400, 'producto que no existe');
  assert.equal((await s.buy('coins_s', 'corto')).status, 400);
  assert.equal((await s.buy('coins_s', tok('s') + ' ; DROP TABLE')).status, 400);
  assert.equal((await s.done('coins_s', tok('nunca-verificada'))).status, 404, 'no se puede cerrar lo que no se verificó');
  assert.equal((await s.done('coins_l', tok('s'))).status, 404, 'ni cerrarla como si fuera otro producto');
});

test('aunque Google no revisara el producto, el servidor sí: si dice que es otro, no se entrega', async () => {
  const s = await server();
  s.play.setLoose(true);
  s.play.sales[tok('s')] = { product: 'coins_s', state: 0 };
  s.play.sales[tok('t')] = { product: 'coins_s', state: 0 };
  assert.equal((await s.buy('coins_l', tok('s'))).status, 402, 'bolsa pequeña presentada como cofre');
  assert.equal((await s.buy('no_ads', tok('t'))).status, 402, 'o como "sin anuncios para siempre"');
  assert.ok(!s.play.sales[tok('s')].consumed && !s.play.sales[tok('t')].acked, 'y no se cerró nada en Google');
  assert.equal((await s.buy('coins_s', tok('s'))).data.grant.coins, 1200, 'con su producto de verdad, sí');
});

test('datos con forma rara se rechazan sin romper nada', async () => {
  const s = await server();
  s.play.sales[tok('z')] = { product: 'coins_s', state: 0 };
  assert.equal((await s.call('/v1/purchase', { productId: ['coins_s'], token: tok('z'), uid: ANA })).status, 400, 'el producto debe ser un texto');
  assert.equal((await s.call('/v1/purchase', { productId: 'coins_s', token: tok('z') })).status, 400, 'sin identificador de instalación');
  assert.equal((await s.call('/v1/purchase', { productId: 'coins_s', token: tok('z'), uid: 'X' })).status, 400);
  assert.equal((await s.call('/v1/purchase', { productId: 'coins_s', token: [tok('z')], uid: ANA })).status, 400);
  assert.equal((await s.call('/v1/purchase/done', { productId: 'coins_s', token: tok('z') })).status, 400);
  assert.equal(s.play.asked(), 0, 'ni se le preguntó a Google');
  assert.equal((await s.buy('coins_s', tok('z'))).data.status, 'grant', 'y la compra de verdad sigue intacta');
});

test('una compra vieja, ya gastada en Google, no se vuelve a entregar', async () => {
  const s = await server();
  s.play.sales[tok('v')] = { product: 'coins_l', state: 0, consumed: true };
  assert.deepEqual((await s.buy('coins_l', tok('v'))).data, { status: 'done' });
  assert.deepEqual((await s.buy('coins_l', tok('v'), BETO)).data, { status: 'done' });
});

test('sin anuncios por 30 días: se entrega una vez, contando desde el pago', async () => {
  const s = await server();
  s.play.sales[tok('m')] = { product: 'no_ads_30', state: 0 };
  assert.deepEqual((await s.buy('no_ads_30', tok('m'))).data, { status: 'grant', grant: { kind: 'adsMonth', days: 30, from: NOW - 5000 } });
  assert.equal(s.play.sales[tok('m')].consumed, true);
  await s.done('no_ads_30', tok('m'));
  assert.deepEqual((await s.buy('no_ads_30', tok('m'))).data, { status: 'done' });
});

for (const [name, makeStore] of [
  ['en memoria', () => memoryStore()],
  ['en la base de datos', () => d1Store(fakeD1())],
])
  test('una compra es de quien la presenta primero: a nadie más se le entrega (' + name + ')', async () => {
    const s = await server(makeStore());
    s.play.sales[tok('a')] = { product: 'coins_l', state: 0 };
    /* la misma instalación la pide muchas veces a la vez sin avisar nunca que la entregó:
       recibe lo mismo (es su compra), pero otra instalación no recibe nada */
    const mine = await Promise.all(Array.from({ length: 6 }, () => s.buy('coins_l', tok('a'), ANA)));
    assert.ok(mine.every((r) => r.data.status === 'grant'));
    for (let i = 2; i < 8; i++) assert.deepEqual((await s.buy('coins_l', tok('a'), phone(i))).data, { status: 'done' }, 'otra instalación: nada');
    /* y varias instalaciones a la vez sobre una compra nueva: la gana una sola */
    s.play.sales[tok('b')] = { product: 'coins_l', state: 0 };
    const race = await Promise.all(Array.from({ length: 8 }, (_, i) => s.buy('coins_l', tok('b'), phone(10 + i))));
    assert.equal(race.filter((r) => r.data.status === 'grant').length, 1, 'una sola la recibe');
    assert.equal(race.filter((r) => r.data.status === 'done').length, 7);
    /* solo quien la reclamó puede darla por entregada */
    assert.equal((await s.done('coins_l', tok('a'), BETO)).status, 403);
    assert.equal((await s.buy('coins_l', tok('a'), ANA)).data.status, 'grant', 'el intento ajeno no la cerró');
    assert.equal((await s.done('coins_l', tok('a'), ANA)).status, 200);
    assert.deepEqual((await s.buy('coins_l', tok('a'), ANA)).data, { status: 'done' });
  });

test('si Google dice quién la compró, solo esa instalación la recibe', async () => {
  const s = await server();
  s.play.sales[tok('q')] = { product: 'coins_m', state: 0, account: await sha256(ANA) };
  const thief = await s.buy('coins_m', tok('q'), BETO);
  assert.equal(thief.status, 402, 'otra instalación llegó primero con el comprobante ajeno: no vale');
  assert.equal(thief.data.status, 'void');
  assert.ok(!s.play.sales[tok('q')].consumed, 'y no se gastó');
  assert.equal((await s.buy('coins_m', tok('q'), ANA)).data.status, 'grant', 'la dueña sí la recibe');
});

test('sin anuncios para siempre: se reconoce en Google y se recupera en otros teléfonos, pero no sin fin', async () => {
  const s = await server();
  s.play.sales[tok('f')] = { product: 'no_ads', state: 0, account: await sha256(ANA) };
  assert.deepEqual((await s.buy('no_ads', tok('f'))).data, { status: 'grant', grant: { kind: 'noAds' } });
  assert.equal(s.play.sales[tok('f')].acked, true, 'reconocida al entregarla (si no, Google la devuelve a los 3 días)');
  assert.ok(!s.play.sales[tok('f')].consumed, 'no se gasta: es para siempre');
  assert.equal((await s.done('no_ads', tok('f'))).status, 200);
  assert.equal((await s.buy('no_ads', tok('f'))).data.status, 'grant', 'el mismo teléfono, las veces que sea');
  /* teléfono nuevo de la misma persona (otra instalación): la recupera */
  for (let i = 2; i <= MAX_DEVICES; i++) assert.equal((await s.buy('no_ads', tok('f'), phone(i))).data.status, 'grant', 'teléfono ' + i);
  assert.equal((await s.done('no_ads', tok('f'), phone(2))).status, 200);
  /* pero un comprobante compartido no sirve para todo el mundo */
  const extra = await s.buy('no_ads', tok('f'), phone(MAX_DEVICES + 1));
  assert.equal(extra.status, 402);
  assert.equal((await s.done('no_ads', tok('f'), phone(MAX_DEVICES + 1))).status, 403);
  assert.equal((await s.buy('no_ads', tok('f'), phone(3))).data.status, 'grant', 'los que ya estaban siguen');
  /* si Google la devuelve (reembolso), ya no */
  s.play.sales[tok('f')].state = 1;
  assert.equal((await s.buy('no_ads', tok('f'))).status, 402);
});

test('si Google no responde, no se entrega nada y se puede reintentar', async () => {
  const s = await server();
  s.play.sales[tok('r')] = { product: 'coins_s', state: 0 };
  s.play.setDown(true);
  assert.equal((await s.buy('coins_s', tok('r'))).status, 502);
  s.play.setDown(false);
  /* si Google confirma el pago pero no deja cerrar la compra, tampoco se entrega todavía */
  s.play.setStuck(true);
  assert.equal((await s.buy('coins_s', tok('r'))).status, 502);
  assert.ok(!s.play.sales[tok('r')].consumed);
  s.play.setStuck(false);
  assert.equal((await s.buy('coins_s', tok('r'))).data.status, 'grant');
  assert.equal(s.play.sales[tok('r')].consumed, true);
  /* avisar que se entregó no depende de Google: ya estaba cerrada */
  s.play.setDown(true);
  assert.equal((await s.done('coins_s', tok('r'))).status, 200);
  s.play.setDown(false);
  assert.deepEqual((await s.buy('coins_s', tok('r'))).data, { status: 'done' }, 'entregada: no se repite');
});

test('un comprobante que Google rechazó se recuerda unos minutos: no se le vuelve a preguntar', async () => {
  const s = await server();
  for (let i = 0; i < 12; i++) assert.equal((await s.buy('coins_s', tok('falso'))).status, 402);
  assert.equal(s.play.asked(), 1, 'una sola pregunta a Google por el mismo comprobante falso');
  /* pasados unos minutos se puede volver a preguntar (por si Google tardó en enterarse de la compra) */
  s.env.now = NOW + 11 * 60000;
  s.play.sales[tok('falso')] = { product: 'coins_s', state: 0 };
  assert.equal((await s.buy('coins_s', tok('falso'))).data.status, 'grant');
});

test('no se guarda el comprobante tal cual, y sin configurar las compras están apagadas', async () => {
  const s = await server();
  s.play.sales[tok('h')] = { product: 'coins_s', state: 0 };
  await s.buy('coins_s', tok('h'));
  assert.equal(await s.env.store.purchase(tok('h')), null, 'no se encuentra por el comprobante mismo');
  const row = await s.env.store.purchase(await sha256(tok('h')));
  assert.equal(row.claimant, await sha256(ANA), 'de quien la reclamó se guarda la huella');
  assert.ok(!JSON.stringify(row).includes(ANA), 'no su identificador');
  const off = await handle(new Request('http://x/v1/purchase', { method: 'POST', body: '{}' }), { store: memoryStore(), now: NOW });
  assert.equal(off.status, 503);
});

test('demasiados intentos desde la misma dirección se frenan', async () => {
  const s = await server();
  let last;
  for (let i = 0; i < 42; i++) last = await s.buy('coins_s', tok('x' + i));
  assert.equal(last.status, 429);
});
