/**
 * Compras: verificar con Google que cada compra hecha en el juego es real antes de entregarla.
 *
 * El cobro lo hace Google Play en el teléfono (su tarjeta, su saldo): ni el juego ni este
 * servidor ven datos de pago. Lo que el teléfono recibe de Google es un comprobante de compra
 * (purchase token). El juego no entrega nada por su cuenta: le pasa el comprobante a este
 * servidor, y el servidor le pregunta a Google, con su propia credencial, si esa compra existe,
 * si es de este juego, de ese producto, y si está pagada.
 *
 * Entregar es en dos pasos, para no perder ni duplicar una compra aunque se caiga la conexión:
 *
 *   POST /v1/purchase       { productId, token, uid }
 *        → { status: 'grant', grant }   está pagada y falta entregarla: el juego la entrega
 *        → { status: 'done' }           ya se entregó antes (o es de otra instalación): no hay nada que dar
 *        → { status: 'pending' }        Google todavía no confirma el pago (pago lento)
 *        → 402 { status: 'void' }       cancelada, devuelta, o no corresponde
 *   POST /v1/purchase/done  { productId, token, uid }
 *        el juego avisa que ya la entregó; el servidor la da por entregada.
 *
 * De quién es cada compra. `uid` es el identificador anónimo de la instalación (el mismo de la
 * copa) y su huella SHA-256 es el "reclamante". La app le pasa esa misma huella a Google al
 * cobrar (obfuscatedAccountId), y Google la devuelve con la compra:
 *   - lo que se gasta (monedas, el mes sin anuncios) solo se le entrega a la instalación que lo
 *     compró: si Google dice que la compró otra, no vale; y la primera que la presenta se queda
 *     con ella (una sola instrucción en la base: dos peticiones a la vez no pueden ganarla las dos);
 *   - "sin anuncios para siempre" se puede recuperar en otro teléfono de la misma persona: hasta
 *     MAX_DEVICES instalaciones por compra.
 *
 * El servidor cierra la compra en Google (la "consume" si se puede volver a comprar; la
 * "reconoce" si es para siempre) ANTES de contestar 'grant', no cuando el juego avisa: así una
 * compra entregada nunca queda abierta (Google devuelve la plata de las que nadie cierra en 3 días).
 * Si el juego se cierra antes de avisar que la entregó, al volver la presenta de nuevo y el
 * servidor le contesta 'grant' otra vez, solo a él, hasta que avise.
 *
 * De cada compra se guarda la huella del comprobante, el producto, el número de orden de Google,
 * la huella del reclamante y si ya se entregó. Nada de la persona ni del pago.
 */
import { tooMany, UNIT } from './limites.js';
import { bad, body, json, validUid } from './respuestas.js';
import { sha256 } from './cuentas.js';

/* Lo que se vende. Las cantidades las pone el servidor: el juego entrega lo que aquí diga.
   once = se compra una sola vez y no se gasta. */
export const CATALOG = {
  coins_s: { kind: 'coins', coins: 1200 },
  coins_m: { kind: 'coins', coins: 2800 },
  coins_l: { kind: 'coins', coins: 8000 },
  no_ads_30: { kind: 'adsMonth', days: 30 },
  no_ads: { kind: 'noAds', once: true },
};
export const MAX_DEVICES = 5; // en cuántas instalaciones se puede recuperar lo que es para siempre
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/* ---------- la credencial del servidor ante Google ----------
   Una "cuenta de servicio": con su llave privada el servidor firma una solicitud y Google le da
   un pase temporal (access token) para consultar las compras. El pase se guarda mientras dure. */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text64 = (text) => b64url(new TextEncoder().encode(text));
let pass = { token: '', until: 0, who: '' };
async function accessToken(key, now, fetcher) {
  if (pass.token && pass.who === key.client_email && pass.until > now + 60000) return pass.token;
  const pem = String(key.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    signer = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
    head = text64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    claim = text64(
      JSON.stringify({
        iss: key.client_email,
        scope: SCOPE,
        aud: key.token_uri || 'https://oauth2.googleapis.com/token',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
      }),
    ),
    sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(head + '.' + claim));
  const r = await fetcher(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64url(new Uint8Array(sig)),
  });
  if (!r.ok) throw new Error('Google no dio el pase');
  const data = await r.json();
  pass = { token: data.access_token, until: now + (Number(data.expires_in) || 3600) * 1000, who: key.client_email };
  return pass.token;
}
/* una llamada a la API de compras de Google Play. action = '' (consultar), ':consume' o ':acknowledge' */
async function play(env, productId, token, action) {
  const key = env.playKey,
    bearer = await accessToken(key, env.now, env.playFetch),
    url = API + encodeURIComponent(env.playPackage) + '/purchases/products/' + encodeURIComponent(productId) + '/tokens/' + encodeURIComponent(token) + action;
  return env.playFetch(url, {
    method: action ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + bearer, ...(action ? { 'content-type': 'application/json' } : {}) },
    body: action ? '{}' : undefined,
  });
}

/* ---------- lo que se acepta ---------- */
const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 2000 && /^[A-Za-z0-9._-]+$/.test(t);
function grantOf(productId, at) {
  const p = CATALOG[productId];
  return p.kind === 'coins' ? { kind: 'coins', coins: p.coins } : p.kind === 'adsMonth' ? { kind: 'adsMonth', days: p.days, from: at } : { kind: 'noAds' };
}

/* Google rechazó ese comprobante hace poco: se recuerda unos minutos para no volver a
   preguntarle por lo mismo (cada pregunta gasta de la cuota de consultas a Google). */
const voidKey = (productId, hash) => 'void:' + productId + ':' + hash;
const voidSlot = (now) => Math.floor(now / UNIT);
const VOID = () => json({ status: 'void', error: 'Google no reconoce esa compra' }, 402);

/* cerrar la compra en Google; true si quedó cerrada */
async function settle(env, productId, token, once) {
  try {
    return (await play(env, productId, token, once ? ':acknowledge' : ':consume')).ok;
  } catch (e) {
    return false;
  }
}

/* ---------- rutas ---------- */
/** env = { store, now, ip, playKey, playPackage, playFetch }. Devuelve la respuesta, o null si la ruta no es de compras. */
export async function purchases(request, env, path) {
  if (path !== '/v1/purchase' && path !== '/v1/purchase/done') return null;
  if (request.method !== 'POST') return bad('no existe', 404);
  if (!env.playKey || !env.playKey.private_key || !env.playPackage) return bad('compras sin configurar', 503);
  const { store, now } = env;
  if (await tooMany(env, 'buy')) return bad('demasiados intentos, espera unos minutos', 429);
  const b = await body(request, 4000);
  if (!b) return bad('datos ilegibles');
  if (typeof b.productId !== 'string' || !Object.prototype.hasOwnProperty.call(CATALOG, b.productId)) return bad('producto desconocido');
  if (!validToken(b.token)) return bad('comprobante ilegible');
  if (!validUid(b.uid)) return bad('identificador inválido');
  const product = CATALOG[b.productId],
    once = !!product.once,
    hash = await sha256(b.token),
    claimant = await sha256(b.uid);

  if (path === '/v1/purchase/done') {
    const row = await store.purchase(hash);
    if (!row || row.product !== b.productId) return bad('compra desconocida', 404);
    /* solo quien la reclamó puede darla por entregada */
    if (!(once ? await store.hasClaim(hash, claimant) : row.claimant === claimant)) return bad('esa compra no es de este teléfono', 403);
    let settled = row.settled;
    /* normalmente ya quedó cerrada en Google al entregarla; si no, se intenta ahora */
    if (!settled && (await settle(env, b.productId, b.token, once))) settled = 1;
    if (!row.delivered || settled !== row.settled) await store.markPurchase(hash, 1, settled);
    return json({ ok: true });
  }

  /* preguntarle a Google por esa compra (salvo que la acabe de rechazar) */
  if ((await store.peek(voidKey(b.productId, hash), voidSlot(now))) > 0) return VOID();
  const reject = async () => {
    await store.bump(voidKey(b.productId, hash), voidSlot(now), 1);
    return VOID();
  };
  let info;
  try {
    const r = await play(env, b.productId, b.token, '');
    if (r.status === 400 || r.status === 404 || r.status === 410) return await reject();
    if (!r.ok) return bad('no se pudo verificar con Google', 502);
    info = await r.json();
  } catch (e) {
    return bad('no se pudo verificar con Google', 502);
  }
  if (!info || typeof info !== 'object') return bad('no se pudo verificar con Google', 502);
  /* purchaseState: 0 pagada · 1 cancelada · 2 pendiente */
  if (info.purchaseState === 2) return json({ status: 'pending' });
  if (info.purchaseState !== 0) return await reject();
  /* Google ya revisa que el comprobante sea de ese producto; si además lo dice, tiene que coincidir */
  if (typeof info.productId === 'string' && info.productId && info.productId !== b.productId) return await reject();
  /* lo que se gasta es de la instalación que lo compró, según Google */
  const buyer = typeof info.obfuscatedExternalAccountId === 'string' ? info.obfuscatedExternalAccountId : '';
  if (!once && buyer && buyer !== claimant) return json({ status: 'void', error: 'esa compra es de otra instalación' }, 402);

  const at = Number(info.purchaseTimeMillis) || now;
  const fresh = await store.putPurchase(hash, b.productId, String(info.orderId || '').slice(0, 80), at);
  /* una compra que Google ya da por gastada y que aquí no constaba: es vieja, no se entrega */
  if (fresh && !once && info.consumptionState === 1) {
    await store.markPurchase(hash, 1, 1);
    return json({ status: 'done' });
  }
  await store.claimPurchase(hash, claimant);
  const row = await store.purchase(hash);
  if (!row || row.product !== b.productId) return json({ status: 'void' }, 402);

  if (once) {
    /* para siempre: se puede recuperar en otro teléfono, pero no repartir sin fin */
    if (!(await store.addClaim(hash, claimant, now, MAX_DEVICES)))
      return json({ status: 'void', error: 'esa compra ya se usó en demasiados teléfonos' }, 402);
  } else {
    if (row.claimant !== claimant) return json({ status: 'done' }); // la reclamó otra instalación
    if (row.delivered) return json({ status: 'done' });
  }
  /* se cierra en Google antes de entregar; si Google no deja, no se entrega todavía (se reintenta) */
  if (!row.settled) {
    const closed = once ? info.acknowledgementState === 1 : info.consumptionState === 1;
    if (!closed && !(await settle(env, b.productId, b.token, once))) return bad('no se pudo cerrar la compra con Google', 502);
    await store.markPurchase(hash, row.delivered, 1);
  }
  return json({ status: 'grant', grant: grantOf(b.productId, at) });
}
