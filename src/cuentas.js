/**
 * Cuentas: guardar el progreso del jugador para que no se pierda al cambiar de teléfono.
 *
 * Se entra solo con Google. El servidor nunca ve ni guarda contraseñas, correos ni nombres:
 *
 *   1. El juego pide un número de un solo uso (nonce) y se lo pasa a Google al iniciar sesión.
 *   2. Google le entrega al juego un comprobante firmado (ID token) que lleva ese número.
 *   3. El servidor revisa el comprobante: la firma de Google, que sea para este juego, que no
 *      esté vencido y que el número sea el que él mismo dio y no se haya usado ya.
 *   4. Si todo está bien, crea (o encuentra) la cuenta y le da al juego una llave de sesión.
 *
 * Qué queda guardado:
 *   - de la persona, solo una huella de su número de cuenta de Google (HMAC con un secreto del
 *     servidor): con la base de datos sola no se puede saber de quién es cada cuenta;
 *   - de la sesión, solo la huella (SHA-256) de la llave: quien lea la base no puede usarla;
 *   - el progreso: el mismo archivo que el juego guarda en el teléfono.
 *
 *   POST   /v1/auth/nonce                      → { nonce }
 *   POST   /v1/auth/google  { idToken }        → { session, fresh, save }
 *   POST   /v1/auth/logout   (con la llave)    cierra esa sesión
 *   GET    /v1/save          (con la llave)    → { version, at, data }   (version 0 = no hay nada)
 *   PUT    /v1/save  { data, base }  (llave)   guarda si nadie guardó después de `base`; si no, 409
 *   DELETE /v1/account       (con la llave)    borra la cuenta, sus sesiones y su progreso
 *
 * La llave va en la cabecera:  Authorization: Bearer <llave>
 */
import { bad, body, json } from './respuestas.js';

const MIN = 60000,
  DAY = 86400000;
export const NONCE_LIFE = 10 * MIN; // el número de un solo uso vence a los 10 minutos
export const SESSION_LIFE = 180 * DAY; // la sesión dura 6 meses sin usarse
export const MAX_SAVE = 24000; // tamaño máximo del progreso (hoy pesa 1,5 KB)
export const SLOT = 10 * MIN; // ventana para contar intentos
export const MAX_AUTH = 30; // inicios de sesión por dirección en una ventana
export const MAX_SAVES = 120; // guardados por cuenta en una ventana
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/* ---------- piezas de criptografía ---------- */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
/* bytes al azar, del generador seguro */
export const randomKey = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
/* huella de un texto: lo que se guarda en vez de la llave o del número de un solo uso */
export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
/* huella con secreto: sin el secreto del servidor no se puede calcular ni comprobar */
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/* ---------- el comprobante de Google ----------
   Devuelve lo que trae ({ sub, nonce }) o el texto de por qué no vale.
   keys(force) entrega las llaves públicas de Google; se piden de nuevo si la del comprobante no está. */
export async function verifyGoogle(idToken, { clientIds, now, keys }) {
  if (typeof idToken !== 'string' || idToken.length > 4096) return 'comprobante ilegible';
  const parts = idToken.split('.');
  if (parts.length !== 3) return 'comprobante ilegible';
  let head, pay, sig;
  try {
    head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    pay = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    sig = fromB64url(parts[2]);
  } catch (e) {
    return 'comprobante ilegible';
  }
  /* solo la firma que usa Google: nada de "sin firma" ni de firmas con secreto compartido */
  if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string') return 'firma no admitida';
  const find = (list) => (list || []).find((k) => k.kid === head.kid && k.kty === 'RSA');
  const jwk = find(await keys(false)) || find(await keys(true));
  if (!jwk) return 'llave desconocida';
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, enc.encode(parts[0] + '.' + parts[1]));
  } catch (e) {
    ok = false;
  }
  if (!ok) return 'firma inválida';
  if (!pay || !ISSUERS.includes(pay.iss)) return 'no lo emitió Google';
  if (!clientIds.includes(pay.aud)) return 'no es para este juego';
  if (!(Number(pay.exp) * 1000 > now)) return 'comprobante vencido';
  if (Number(pay.iat) * 1000 > now + 5 * MIN) return 'comprobante con fecha futura';
  if (typeof pay.sub !== 'string' || !/^[0-9A-Za-z_-]{1,255}$/.test(pay.sub)) return 'cuenta ilegible';
  return { sub: pay.sub, nonce: typeof pay.nonce === 'string' ? pay.nonce : '' };
}

/* ---------- límites ---------- */
/* cuenta un intento; devuelve true si ya se pasó del tope en esta ventana */
async function tooMany(store, key, now, max) {
  return (await store.bump(key, Math.floor(now / SLOT))) > max;
}

/* ---------- sesión ---------- */
/* la cuenta dueña de la llave que trae la petición, o null. Renueva la sesión si va por la mitad. */
async function who(request, store, now) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const hash = await sha256(m[1]),
    s = await store.session(hash);
  if (!s || s.expires <= now) return null;
  if (s.expires - now < SESSION_LIFE / 2) await store.touchSession(hash, now + SESSION_LIFE);
  return { account: s.account, hash };
}

/* ---------- lo que se acepta como progreso ---------- */
/* devuelve el texto a guardar, o null si no es un objeto razonable */
function cleanSave(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const text = JSON.stringify(data);
  return text.length <= MAX_SAVE ? text : null;
}
const saveOut = (s) => (s ? { version: s.version, at: s.at, data: JSON.parse(s.data) } : { version: 0, at: 0, data: null });

/* ---------- rutas ---------- */
/** env = { store, now, secret, googleIds, googleKeys, ip }. Devuelve la respuesta, o null si la ruta no es de cuentas. */
export async function accounts(request, env, path) {
  const { store, now } = env,
    method = request.method;
  if (!path.startsWith('/v1/auth/') && path !== '/v1/save' && path !== '/v1/account') return null;
  /* sin el secreto y el identificador de Google configurados, las cuentas están apagadas */
  if (!env.secret || !env.googleIds || !env.googleIds.length) return bad('cuentas sin configurar', 503);
  const ipKey = 'ip:' + (env.ip || 'local');

  if (method === 'POST' && path === '/v1/auth/nonce') {
    if (await tooMany(store, ipKey, now, MAX_AUTH)) return bad('demasiados intentos, espera unos minutos', 429);
    const nonce = randomKey(18);
    await store.putNonce(await sha256(nonce), now + NONCE_LIFE);
    return json({ nonce });
  }

  if (method === 'POST' && path === '/v1/auth/google') {
    if (await tooMany(store, ipKey, now, MAX_AUTH)) return bad('demasiados intentos, espera unos minutos', 429);
    const b = await body(request, 6000);
    if (!b) return bad('datos ilegibles');
    const v = await verifyGoogle(b.idToken, { clientIds: env.googleIds, now, keys: env.googleKeys });
    if (typeof v === 'string') return bad(v, 401);
    /* el número de un solo uso: tiene que ser uno que dio este servidor, vigente y sin usar */
    if (!v.nonce || !(await store.takeNonce(await sha256(v.nonce), now))) return bad('inicio de sesión vencido, intenta de nuevo', 401);
    const sub = await hmac(env.secret, 'google:' + v.sub);
    let account = await store.accountBySub(sub),
      fresh = false;
    if (!account) {
      account = randomKey(16);
      fresh = true;
      await store.putAccount(account, sub, now);
    }
    const session = randomKey(32);
    await store.putSession(await sha256(session), account, now + SESSION_LIFE);
    await store.sweep(now, Math.floor(now / SLOT)); // de paso, se bota lo vencido
    return json({ session, fresh, save: saveOut(await store.getSave(account)) });
  }

  /* de aquí en adelante, todo pide la llave de sesión */
  const me = await who(request, store, now);
  if (!me) return bad('sesión inválida', 401);

  if (method === 'POST' && path === '/v1/auth/logout') {
    await store.dropSession(me.hash);
    return json({ ok: true });
  }
  if (method === 'GET' && path === '/v1/save') return json(saveOut(await store.getSave(me.account)));
  if (method === 'PUT' && path === '/v1/save') {
    if (await tooMany(store, 'save:' + me.account, now, MAX_SAVES)) return bad('demasiados guardados, espera unos minutos', 429);
    const b = await body(request, MAX_SAVE + 2000);
    if (!b) return bad('datos ilegibles');
    const text = cleanSave(b.data),
      base = Math.floor(Number(b.base));
    if (!text) return bad('progreso ilegible o demasiado grande');
    if (!(base >= 0)) return bad('versión inválida');
    /* solo se guarda si nadie guardó después de la versión que el juego conocía */
    if (await store.putSave(me.account, text, base, now)) return json({ version: base + 1, at: now });
    return json({ error: 'hay un progreso más nuevo', ...saveOut(await store.getSave(me.account)) }, 409);
  }
  if (method === 'DELETE' && path === '/v1/account') {
    await store.dropAccount(me.account);
    return json({ ok: true });
  }
  return bad('no existe', 404);
}
