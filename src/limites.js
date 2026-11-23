/**
 * Límites de uso: cuántas veces puede un mismo cliente hacer algo en una ventana de tiempo.
 * Frenan a quien quiera llenar la base de datos, gastar la cuota del servidor o probar
 * comprobantes a la fuerza. Al jugador normal nunca lo tocan.
 *
 * Al cliente se lo reconoce por su dirección de internet. Una dirección IPv6 se cuenta por su
 * bloque (/64): a cada casa o teléfono le dan un bloque entero, con millones de direcciones, y
 * contarlas una por una no frenaría a nadie.
 *
 * Una petición frenada no escribe nada en la base de datos: el contador deja de subir al llegar
 * al tope (ver bump en almacenes.js).
 *
 * Hay una segunda capa opcional, por delante: env.gate(clave) → false si ese cliente va
 * demasiado rápido. En Cloudflare es el servicio de límites de la plataforma (ver LEEME), que
 * frena sin tocar la base. Si no está, todo funciona igual con los contadores de aquí.
 */

const MIN = 60000;
export const UNIT = 10 * MIN; // los contadores se guardan por ventanas contadas en bloques de 10 minutos

/* Cada límite: [cuántas veces, en cuánto tiempo] */
export const LIMITS = {
  auth: [30, 10 * MIN], // inicios de sesión por cliente
  save: [120, 10 * MIN], // guardados por cuenta
  buy: [40, 10 * MIN], // comprobantes de compra por cliente
  score: [30, 10 * MIN], // marcas en la copa por cliente
  duel: [10, 60 * MIN], // retos creados por cliente
  duelScore: [30, 10 * MIN], // marcas en retos por cliente
  visits: [10, 24 * 60 * MIN], // envíos de la medición por cliente
  admin: [20, 10 * MIN], // intentos con la clave de administración
};

/* la dirección tal como se cuenta: IPv4 entera, IPv6 por su bloque /64 */
export function clientKey(ip) {
  const text = String(ip || '')
    .trim()
    .toLowerCase();
  if (!text) return 'local';
  if (!text.includes(':')) return text.slice(0, 45);
  /* una IPv4 escrita dentro de una IPv6 (::ffff:1.2.3.4) */
  const mapped = /^(?:::ffff:|0+(?::0+){4}:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return mapped[1];
  const [head, tail] = text.split('%')[0].split('::'),
    left = head ? head.split(':') : [],
    right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return (
    groups
      .slice(0, 4)
      .map((g) => (g || '0').replace(/^0+(?=.)/, '').slice(0, 4))
      .join(':') + '::/64'
  );
}

/* Cuenta un intento. Devuelve true si ese cliente (o esa cuenta) ya se pasó del tope.
   who = a quién se le cuenta; si no se da, a la dirección del cliente. */
export async function tooMany(env, name, who) {
  const [max, span] = LIMITS[name],
    key = name + ':' + (who || clientKey(env.ip));
  if (env.gate && !(await env.gate(key))) return true;
  const slot = Math.floor(env.now / span) * Math.round(span / UNIT);
  return (await env.store.bump(key, slot, max)) > max;
}
