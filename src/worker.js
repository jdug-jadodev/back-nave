/** Entrada en Cloudflare: conecta las reglas con la base de datos D1 y con los secretos. */
import { d1Store } from './almacenes.js';
import { keyRing } from './cuentas.js';
import { cleanup, handle } from './reglas.js';

/* Las llaves públicas con las que Google firma sus comprobantes (ver keyRing en cuentas.js) */
const googleKeys = keyRing(async () => {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  return r.ok ? (await r.json()).keys || [] : null;
});

/* la credencial de la cuenta de servicio llega como texto JSON; si falta o está mal, no hay compras */
function serviceKey(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

/* Memoria que dura entre peticiones mientras viva esta copia del servidor: ahí se recuerdan
   unos segundos los totales de las tablas (ver board en reglas.js). */
const cache = new Map();

/* Primera capa de límites, opcional: el servicio de límites de Cloudflare frena a quien va
   demasiado rápido sin tocar la base de datos. Solo se usa si en wrangler.toml se conectó con
   el nombre RATE_LIMITER (ver LEEME: es un paso opcional y hay que seguir la documentación
   vigente). Si no está, o si falla, se deja pasar y cuentan los límites propios (limites.js). */
function gateOf(env) {
  const limiter = env.RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return undefined;
  return async (key) => {
    try {
      return (await limiter.limit({ key })).success !== false;
    } catch (e) {
      return true;
    }
  };
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
      /* compras: la credencial con la que el servidor le pregunta a Google Play (un "secret") */
      playKey: serviceKey(env.PLAY_SERVICE_ACCOUNT),
      playPackage: env.PLAY_PACKAGE || 'com.giroestelar',
      playFetch: (url, init) => fetch(url, init),
      cache,
      gate: gateOf(env),
    }),
  /* el reloj de Cloudflare (ver [triggers] en wrangler.toml): una vez al día se bota lo que ya no sirve */
  scheduled: (event, env, ctx) => ctx.waitUntil(cleanup(d1Store(env.DB), Date.now())),
};
