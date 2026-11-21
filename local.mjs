/**
 * El mismo servidor, corriendo en el computador con los datos en memoria. Sirve para probar el
 * juego en el navegador sin publicar nada:
 *
 *   node local.mjs            → http://localhost:8787   (panel: /panel?key=local)
 *   node local.mjs 8787 demo  → lo mismo, con seis rivales de mentira ya en la tabla de la copa
 *
 * En el navegador, antes de abrir el juego:  localStorage.giro_api = 'http://localhost:8787'
 */
import http from 'node:http';
import { memoryStore } from './src/almacenes.js';
import { handle, weekOf } from './src/reglas.js';

export function start(port = 8787, clock = () => Date.now()) {
  const store = memoryStore();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : Buffer.concat(chunks),
    });
    const response = await handle(request, { store, now: clock(), adminKey: 'local' });
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
