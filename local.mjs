/**
 * El mismo servidor, corriendo en el computador con los datos en memoria. Sirve para probar el
 * juego en el navegador sin publicar nada:
 *
 *   node local.mjs            → http://localhost:8787   (panel: /panel?key=local)
 *   node local.mjs 8787 demo  → lo mismo, con seis rivales de mentira ya en la tabla de la copa
 *   node local.mjs 8787 --red → además atiende a otros aparatos de la red (para probar desde el
 *                               teléfono). Sin --red solo atiende a este computador: este servidor
 *                               regala comprobantes de mentira y no debe quedar a la vista de la red.
 *
 * En el navegador, antes de abrir el juego:  localStorage.giro_api = 'http://localhost:8787'
 * Para probar las cuentas, además:           localStorage.giro_google = '111'   (un número de cuenta
 * cualquiera; este servidor hace de Google y firma el comprobante de esa cuenta)
 */
import http from 'node:http';
import { memoryStore } from './src/almacenes.js';
import { cleanup, handle, weekOf } from './src/reglas.js';

/* Un "Google" de mentira, solo para probar las cuentas en el computador: firma comprobantes como
   los firmaría Google, con una llave hecha al arrancar. Jamás existe en el servidor publicado. */
const TEST_CLIENT = 'giro-estelar-local';
async function fakeGoogle() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'local' };
  const b64 = (data) => Buffer.from(data).toString('base64url');
  return {
    jwk,
    async token(sub, nonce, now) {
      const h = b64(JSON.stringify({ alg: 'RS256', kid: 'local', typ: 'JWT' })),
        p = b64(JSON.stringify({ iss: 'https://accounts.google.com', aud: TEST_CLIENT, sub, nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 })),
        sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(h + '.' + p));
      return h + '.' + p + '.' + b64(new Uint8Array(sig));
    },
  };
}

/* Un "Google Play" de mentira, solo para probar las compras en el computador: lleva una lista de
   ventas en memoria y contesta como la API de verdad. Jamás existe en el servidor publicado. */
const PRICES = { coins_s: '$ 1.000', coins_m: '$ 2.000', coins_l: '$ 5.000', no_ads_30: '$ 1.000', no_ads: '$ 3.000' };
async function fakePlay() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const sales = {}; // comprobante → { product, state: 0 pagada · 1 cancelada · 2 pendiente, consumed, acked, account }
  const reply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
  return {
    sales,
    key: { client_email: 'local@prueba', private_key: '-----BEGIN PRIVATE KEY-----\n' + der + '\n-----END PRIVATE KEY-----', token_uri: 'https://oauth2.googleapis.com/token' },
    /* una venta nueva, como si el jugador acabara de pagar (o de dejar el pago pendiente) */
    /* account = la huella que la app le pasa a Google al cobrar (obfuscatedAccountId), si la manda */
    sell(product, state, account) {
      const token = 'venta' + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
      sales[token] = { product, state: state === 'pending' ? 2 : 0, ...(account ? { account } : {}) };
      return token;
    },
    /* lo que el teléfono vería como compras abiertas */
    open: () =>
      Object.entries(sales)
        .filter(([, s]) => !s.consumed && s.state !== 1)
        .map(([token, s]) => ({ productId: s.product, token, state: s.state === 2 ? 'pending' : 'paid' })),
    async fetch(url, init = {}) {
      if (url.includes('oauth2.googleapis.com/token')) return reply({ access_token: 'pase-local', expires_in: 3600 });
      const m = /purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:\w+)?$/.exec(url),
        sale = m && sales[decodeURIComponent(m[2])];
      if (!sale || sale.product !== m[1]) return reply({}, 404);
      if (m[3] === ':consume') sale.consumed = true;
      else if (m[3] === ':acknowledge') sale.acked = true;
      else
        return reply({
          purchaseState: sale.state,
          consumptionState: sale.consumed ? 1 : 0,
          acknowledgementState: sale.acked ? 1 : 0,
          orderId: 'GPA.local',
          purchaseTimeMillis: String(Date.now()),
          ...(sale.account ? { obfuscatedExternalAccountId: sale.account } : {}),
        });
      return reply({});
    },
  };
}

/* host: por defecto solo este computador; '0.0.0.0' para atender a toda la red (--red) */
export async function start(port = 8787, clock = () => Date.now(), host = '127.0.0.1') {
  const store = memoryStore(),
    google = await fakeGoogle(),
    play = await fakePlay();
  const server = http.createServer(async (req, res) => {
    /* el "Google Play" de mentira: precios, vender algo y ver lo que sigue abierto.
       /test/store?do=prices · do=buy&product=coins_s&state=paid|pending[&account=huella] · do=open · do=confirm (paga lo pendiente) */
    if (req.method === 'GET' && req.url.startsWith('/test/store')) {
      const q = new URL('http://localhost' + req.url).searchParams,
        what = q.get('do');
      let out = { list: [] };
      if (what === 'prices') out = { prices: PRICES };
      else if (what === 'buy') {
        const token = play.sell(q.get('product'), q.get('state'), q.get('account') || '');
        out = { list: play.open().filter((p) => p.token === token) };
      } else if (what === 'open') out = { list: play.open() };
      else if (what === 'confirm') {
        for (const s of Object.values(play.sales)) if (s.state === 2) s.state = 0;
        out = { list: play.open() };
      } else if (what === 'refund') for (const s of Object.values(play.sales)) s.state = 1;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(out));
    }
    /* el "Google" de mentira: entrega el comprobante de la cuenta que se le pida */
    if (req.method === 'GET' && req.url.startsWith('/test/token')) {
      const q = new URL('http://localhost' + req.url).searchParams;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ idToken: await google.token(q.get('sub') || '', q.get('nonce') || '', clock()) }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : Buffer.concat(chunks),
    });
    const response = await handle(request, {
      store,
      now: clock(),
      adminKey: 'local',
      secret: 'secreto-local',
      googleIds: [TEST_CLIENT],
      googleKeys: async () => [google.jwk],
      ip: req.socket.remoteAddress || '',
      playKey: play.key,
      playPackage: 'com.giroestelar',
      playFetch: (url, init) => play.fetch(url, init),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  /* la limpieza que en Cloudflare corre una vez al día */
  setInterval(() => cleanup(store, clock()).catch(() => {}), 3600000).unref();
  return new Promise((ok) => server.listen(port, host, () => ok({ server, store, play })));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1].endsWith('local.mjs')) {
  const port = +(process.argv[2] || 8787) || 8787,
    open = process.argv.includes('--red');
  start(port, undefined, open ? '0.0.0.0' : '127.0.0.1').then(async ({ store }) => {
    if (process.argv.includes('demo')) {
      const week = weekOf(Date.now()).key;
      const rivals = [['Caro', 312], ['Beto', 205], ['Santi', 188], ['Lau', 95], ['Don Mario', 64], ['Pipe_7', 41]];
      for (const [i, [nick, time]] of rivals.entries()) await store.putScore(week, 'rivaldeprueba' + i, nick, time, Date.now() + i);
      console.log('Con rivales de mentira en la copa: ' + rivals.map((r) => r[0]).join(', '));
    }
  }).then(() =>
    console.log('Servidor local de Astrion Space en http://localhost:' + port + '  (panel: /panel?key=local)' + (open ? '  · a la vista de toda la red' : '')),
  );
}
