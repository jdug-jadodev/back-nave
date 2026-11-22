/**
 * El mismo servidor, corriendo en el computador con los datos en memoria. Sirve para probar el
 * juego en el navegador sin publicar nada:
 *
 *   node local.mjs            → http://localhost:8787   (panel: /panel?key=local)
 *   node local.mjs 8787 demo  → lo mismo, con seis rivales de mentira ya en la tabla de la copa
 *
 * En el navegador, antes de abrir el juego:  localStorage.giro_api = 'http://localhost:8787'
 * Para probar las cuentas, además:           localStorage.giro_google = '111'   (un número de cuenta
 * cualquiera; este servidor hace de Google y firma el comprobante de esa cuenta)
 */
import http from 'node:http';
import { memoryStore } from './src/almacenes.js';
import { handle, weekOf } from './src/reglas.js';

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

export async function start(port = 8787, clock = () => Date.now()) {
  const store = memoryStore(),
    google = await fakeGoogle();
  const server = http.createServer(async (req, res) => {
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
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(port, () => ok({ server, store })));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1].endsWith('local.mjs')) {
  const port = +(process.argv[2] || 8787);
  start(port).then(async ({ store }) => {
    if (process.argv[3] === 'demo') {
      const week = weekOf(Date.now()).key;
      const rivals = [['Caro', 312], ['Beto', 205], ['Santi', 188], ['Lau', 95], ['Don Mario', 64], ['Pipe_7', 41]];
      for (const [i, [nick, time]] of rivals.entries()) await store.putScore(week, 'rivaldeprueba' + i, nick, time, Date.now() + i);
      console.log('Con rivales de mentira en la copa: ' + rivals.map((r) => r[0]).join(', '));
    }
  }).then(() => console.log('Servidor local de Giro Estelar en http://localhost:' + port + '  (panel: /panel?key=local)'));
}
