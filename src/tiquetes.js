/**
 * Tiquete de partida: la prueba de que una partida de Supervivencia empezó de verdad, y cuándo.
 *
 * Al empezar la partida el juego pide un tiquete. El servidor no guarda nada: el tiquete es la
 * hora en que se pidió más una firma hecha con el secreto del servidor, que amarra esa hora al
 * identificador de la instalación. Al terminar, la marca llega con su tiquete y el servidor
 * comprueba dos cosas:
 *
 *   - que el tiquete lo firmó él, para ese jugador (nadie puede inventarse uno ni usar el de otro);
 *   - que el tiempo que dice haber aguantado cabe en el tiempo real que pasó desde que lo pidió.
 *
 * Con eso nadie puede anotar 20 minutos sin haber esperado 20 minutos de reloj, y cada tiquete
 * sirve para una sola marca (ver putScore en almacenes.js: una marca mejor tiene que venir con
 * un tiquete más nuevo que el de la marca anterior).
 *
 * Lo que NO prueba: que durante ese rato se haya jugado. Quien modifique el juego puede pedir un
 * tiquete, esperar y mandar un tiempo inventado. Para eso están la lista de revisión del panel
 * y, cuando la app esté en la tienda, el sello de app original de Google.
 */
import { hmac } from './cuentas.js';
import { sameSecret } from './respuestas.js';

export const SLACK = 15; // segundos de holgura: lo que tarda en llegar la petición del tiquete con mala señal
export const LIFE = 8 * 86400000; // un tiquete más viejo que esto ya no sirve (la copa dura una semana)

const sign = async (secret, uid, at) => (await hmac(secret, `partida:${uid}:${at}`)).slice(0, 32);

/** El tiquete de una partida que empieza en `at` (milisegundos). */
export const ticketFor = async (secret, uid, at) => at.toString(36) + '.' + (await sign(secret, uid, at));

/** Cuándo empezó la partida de ese tiquete (milisegundos), o 0 si el tiquete no vale. */
export async function ticketStart(secret, uid, ticket, now) {
  const m = typeof ticket === 'string' ? /^([0-9a-z]{6,12})\.([0-9a-f]{32})$/.exec(ticket) : null;
  if (!m || !secret) return 0;
  const at = parseInt(m[1], 36);
  if (!(at > 0 && at <= now + 60000 && now - at <= LIFE)) return 0;
  return (await sameSecret(m[2], await sign(secret, uid, at))) ? at : 0;
}
