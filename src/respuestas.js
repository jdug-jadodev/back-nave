/** Cómo contesta el servidor: siempre JSON, sin caché, y aceptando al juego desde cualquier origen. */

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-private-network': 'true',
};
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
export const bad = (why, status = 400) => json({ error: why }, status);

/* cuántos bytes ocupa un texto al enviarlo (una "é" o un "€" pesan más que una letra) */
export const bytes = (text) => new TextEncoder().encode(text).length;

/* Lo que trae la petición, si es un objeto JSON y no pasa del tamaño permitido (en bytes); si
   no, null. Lo que dice ser más grande se rechaza sin leerlo, y lo que miente sobre su tamaño
   se deja de leer en cuanto se pasa: nadie hace leer al servidor un envío enorme. */
export async function body(request, max = 4000) {
  if (Number(request.headers.get('content-length')) > max) return null;
  let text = '';
  if (request.body && request.body.getReader) {
    const reader = request.body.getReader(),
      chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        try {
          await reader.cancel();
        } catch (e) {
          /* ya se dejó de leer */
        }
        return null;
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    text = new TextDecoder().decode(all);
  } else {
    text = await request.text();
    if (bytes(text) > max) return null;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

/* el identificador anónimo de una instalación del juego (el de la copa): letras y números */
export const validUid = (uid) => typeof uid === 'string' && /^[a-z0-9]{16,40}$/.test(uid);

/* ¿dos textos secretos son iguales? Se comparan sus huellas completas, no los textos: así el
   tiempo que tarda la comparación no deja adivinar la clave letra por letra. */
export async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder(),
    [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]),
    p = new Uint8Array(x),
    q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}
