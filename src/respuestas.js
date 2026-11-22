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
/* lo que trae la petición, si es un objeto JSON y no pasa del tamaño permitido; si no, null */
export async function body(request, max = 4000) {
  const text = await request.text();
  if (text.length > max) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}
