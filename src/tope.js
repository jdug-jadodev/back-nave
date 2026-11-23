/**
 * Tope de monedas: notar un progreso retocado a mano.
 *
 * Las monedas y las piezas viven en el teléfono, y el juego funciona sin conexión: el servidor
 * no puede impedir que alguien con el teléfono modificado se las regale. Lo que sí puede es
 * notarlo cuando ese progreso se guarda en la cuenta, y dejar a esa instalación fuera de la copa.
 *
 * Cómo se nota. De cada cuenta se lleva un renglón (ledger) con cuánto valía lo que tenía en su
 * último guardado: monedas + lo que cuestan sus piezas (precios.js). Comprar una pieza no cambia
 * ese valor (salen monedas, entra la pieza). Lo que lo sube es jugar, y jugando se gana a un
 * ritmo limitado. En cada guardado se compara:
 *
 *   lo que subió  ≤  lo que compró con plata (el servidor lo sabe) + lo que cabía ganar jugando
 *
 * "Lo que cabía ganar" es un cupo que se va llenando con el reloj (RATE monedas por segundo)
 * hasta un máximo (ROOM), y se gasta con lo que el jugador gana. Quien juega de verdad nunca
 * lo agota. Si un guardado se pasa:
 *
 *   - el progreso se guarda igual (por si fuera un error del servidor, no se le borra nada a nadie);
 *   - la instalación queda vetada de la copa, con el motivo anotado, y aparece en el panel;
 *   - desde el panel se le puede levantar el veto: ahí se da por bueno lo que tenga.
 *
 * También se revisa "sin anuncios": si el progreso dice que lo tiene y el servidor no conoce esa
 * compra, es lo mismo.
 *
 * Límite conocido: a quién se veta lo dice el propio progreso (su identificador de instalación).
 * Un juego modificado puede mandar otro y esquivar el veto; el que retoca el archivo a mano con
 * la app original, no. Lo primero lo cierra el sello de app original de Google.
 */
import { CATALOG } from './compras.js';
import { sha256 } from './cuentas.js';
import PRICES from './precios.js';
import { validUid } from './respuestas.js';

/* Los números salen de la economía del juego (medido el 2026-11-22): una partida bien jugada
   rinde unas 60 a 100 monedas por minuto, el doble si se duplica con un anuncio; todas las
   piezas del catálogo juntas cuestan unas 209.000. Están puestos para que nadie que juegue de
   verdad se pase, ni jugando horas seguidas: el que cae es quien se regala miles de golpe. */
export const RATE = 1; // monedas que se suman al cupo por cada segundo de reloj (86.400 al día)
export const ROOM = 60000; // lo más que se acumula de cupo, por mucho que pase el tiempo
export const START = 40000; // cupo con el que arranca una cuenta (unas 8 horas seguidas del mejor jugador)
export const FIRST = 300000; // lo más que puede valer el primer guardado de una cuenta (todo el catálogo y un resto)
const DAY = 86400000;

const PRICE = new Map();
for (const [price, ids] of Object.entries(PRICES)) for (const id of ids) PRICE.set(id, +price);

/** Cuánto vale lo que hay en un progreso: sus monedas más lo que cuestan sus piezas. */
export function wealthOf(data) {
  let sum = typeof data.coins === 'number' && data.coins > 0 ? Math.floor(data.coins) : 0;
  const parts = Array.isArray(data.parts) ? new Set(data.parts) : [];
  for (const id of parts) sum += (typeof id === 'string' && PRICE.get(id)) || 0;
  return sum;
}

/**
 * ¿Cabe este guardado? old = el renglón anterior de la cuenta (o null si es su primer guardado),
 * wealth = lo que vale ahora, bought = monedas compradas con plata en total.
 * Devuelve { ok, next }: next es el renglón que queda guardado.
 */
export function judge(old, wealth, bought, now) {
  if (!old) {
    const ok = wealth <= FIRST + bought;
    return { ok, next: { wealth: ok ? wealth : FIRST + bought, room: ok ? START : 0, at: now, bought, trusted: 0 } };
  }
  const room = Math.min(ROOM, old.room + (RATE * Math.max(0, now - old.at)) / 1000),
    paid = Math.max(0, bought - old.bought),
    up = wealth - old.wealth - paid;
  /* trusted: le levantaron el veto desde el panel; lo que tenga ahora se da por bueno */
  if (old.trusted) return { ok: true, next: { wealth, room: START, at: now, bought, trusted: 0 } };
  if (up <= room) return { ok: true, next: { wealth, room: Math.floor(room - Math.max(0, up)), at: now, bought, trusted: 0 } };
  /* se pasó: queda anotado hasta donde sí cabía, así los guardados que sigan con lo mismo también se pasan */
  return { ok: false, next: { wealth: old.wealth + paid + Math.floor(room), room: 0, at: now, bought, trusted: 0 } };
}

/**
 * Revisa un progreso recién guardado. Devuelve el motivo si no cuadra ('monedas' o 'sin anuncios')
 * o '' si está bien. Si no cuadra, veta de la copa a esa instalación.
 */
export async function audit(env, account, data) {
  const { store, now } = env,
    uid = validUid(data.uid) ? data.uid : '',
    who = uid ? await sha256(uid) : '';
  let coins = 0,
    months = 0,
    forever = false;
  for (const row of who ? await store.boughtBy(who) : []) {
    const item = CATALOG[row.product];
    if (!item) continue;
    if (item.kind === 'coins') coins += item.coins * row.n;
    else if (item.kind === 'adsMonth') months += row.n;
    else if (item.kind === 'noAds') forever = true;
  }
  if (who && !forever) forever = await store.claimedBy(who); // lo recuperó en este teléfono
  const verdict = judge(await store.ledger(account), wealthOf(data), coins, now);
  await store.putLedger(account, { uid, ...verdict.next });
  let why = verdict.ok ? '' : 'monedas';
  if (!why && data.noAds === true && !forever) why = 'sin anuncios';
  /* el mes sin anuncios: no puede durar más que los meses comprados (y dos días por la hora del teléfono) */
  if (!why && typeof data.noAdsUntil === 'number' && data.noAdsUntil > now + (months * 30 + 2) * DAY) why = 'sin anuncios';
  if (why && uid && !(await store.banned(uid))) {
    await store.ban(uid, now, why);
    await store.dropScores(uid);
    if (env.cache) env.cache.clear();
  }
  return why;
}
