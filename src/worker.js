/** Entrada en Cloudflare: conecta las reglas con la base de datos D1 y la clave del panel. */
import { d1Store } from './almacenes.js';
import { handle } from './reglas.js';

export default {
  fetch: (request, env) => handle(request, { store: d1Store(env.DB), now: Date.now(), adminKey: env.ADMIN_KEY }),
};
