/** Entrada en Cloudflare: conecta las reglas con la base de datos D1 y con los secretos. */
import { d1Store } from './almacenes.js';
import { handle } from './reglas.js';

/* Las llaves públicas con las que Google firma sus comprobantes. Cambian cada tanto: se guardan
   una hora, y se vuelven a pedir si llega un comprobante firmado con una que no está. */
let google = { at: 0, keys: [] };
async function googleKeys(force) {
  if (!force && google.keys.length && Date.now() - google.at < 3600000) return google.keys;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (r.ok) google = { at: Date.now(), keys: (await r.json()).keys || [] };
  } catch (e) {
    /* sin respuesta de Google se sigue con las que había */
  }
  return google.keys;
}

export default {
  fetch: (request, env) =>
    handle(request, {
      store: d1Store(env.DB),
      now: Date.now(),
      adminKey: env.ADMIN_KEY,
      /* cuentas: el secreto es un "secret" de Cloudflare; el identificador de Google es público */
      secret: env.AUTH_SECRET,
      googleIds: String(env.GOOGLE_CLIENT_ID || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      googleKeys,
      ip: request.headers.get('cf-connecting-ip') || '',
    }),
};
