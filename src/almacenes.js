/**
 * Los dos almacenes del servidor. Ambos ofrecen exactamente lo mismo:
 *
 *   putScore(week, uid, nick, time, at, started)   guarda el tiempo si mejora el que había; el apodo siempre se
 *                           actualiza. started = cuándo empezó la partida según su tiquete (0 = sin tiquete, los
 *                           retos): con tiquete, una marca mejor solo vale si su tiquete es más nuevo que el de
 *                           la marca que había (cada tiquete sirve para una sola marca)
 *   top(week, limit) → [{ uid, nick, time, at, started }] · mine(week, uid) · ahead(week, time, at) · total(week)
 *   putVisits(uid, first, days) · cohorts(limit, since) · active(day)
 *   putDuel(code, seed, uid, nick, at) → false si el código ya existe · duel(code)
 *   ban(uid, at, why) · unban(uid) · banned(uid) · dropScores(uid) → cuántas marcas borró
 *   bans(limit) → [{ uid, at, why }], los más recientes primero (why: 'admin', 'monedas', 'sin anuncios')
 *
 * Limpieza (la corre el servidor cada día; cada una devuelve cuántas filas borró):
 *   dropWeeksBefore(week)   las copas de semanas anteriores a esa
 *   dropDuelsBefore(at)     los retos creados antes de ese momento y sin marcas nuevas desde entonces
 *   dropVisitsBefore(day)   los días de la medición anteriores a ese
 *   sweep(now, slot)        números de un solo uso y sesiones vencidos, y contadores de ventanas anteriores a `slot`
 *
 * Para las cuentas (cuentas.js):
 *   putNonce(hash, expires) · takeNonce(hash, now) → true si existía y seguía vigente (y lo gasta)
 *   accountBySub(sub) → id o null · putAccount(id, sub, at)
 *   putSession(hash, account, expires, created) · session(hash) → { account, expires, created }
 *   touchSession(hash, expires) · dropSession(hash) · dropSessions(account)
 *   getSave(account) → { data, version, at } o null
 *   putSave(account, data, base, at) → true si se guardó (solo si la versión guardada es `base`)
 *   dropAccount(account)   borra la cuenta, sus sesiones y su progreso
 *   bump(key, slot, max) → cuántos intentos van en esa ventana; al llegar al tope deja de contar
 *                           (y de escribir) y devuelve max + 1 · peek(key, slot) → cuántos van, sin contar
 *
 * Para las compras (compras.js):
 *   purchase(hash) → { product, order, at, delivered, settled, claimant } o null
 *   putPurchase(hash, product, order, at) → true si era nueva · markPurchase(hash, delivered, settled)
 *   claimPurchase(hash, claimant)   la compra queda a nombre de quien la presenta primero (y solo de él)
 *   addClaim(hash, claimant, at, max) → true si ese reclamante está (o cupo) entre los `max` de la compra
 *   hasClaim(hash, claimant)
 *
 * Para el tope de monedas (tope.js):
 *   ledger(account) → { uid, wealth, room, at, bought, trusted } o null · putLedger(account, renglón)
 *   trustLedgers(uid)       lo que tengan las cuentas de esa instalación se da por bueno en su próximo guardado
 *   boughtBy(claimant) → [{ product, n }]   cuántas compras de cada producto tiene ese reclamante
 *   claimedBy(claimant) → true si recuperó algo que es para siempre
 *
 * memoryStore: en memoria, para las pruebas y para probar el juego en el computador.
 * d1Store: la base de datos D1 de Cloudflare (ver schema.sql).
 */

export function memoryStore() {
  const scores = new Map(); // "semana|uid" → { week, uid, nick, time, at }
  const visits = new Map(); // "uid|día" → { uid, day, first }
  const duels = new Map(); // código → { code, seed, uid, nick, at }
  const accounts = new Map(); // id → { id, sub, at }
  const sessions = new Map(); // huella de la llave → { account, expires }
  const saves = new Map(); // cuenta → { data, version, at }
  const nonces = new Map(); // huella → cuándo vence
  const limits = new Map(); // "clave|ventana" → intentos
  const bought = new Map(); // huella del comprobante → { product, order, at, delivered, settled, claimant }
  const claims = new Map(); // huella del comprobante → reclamantes (lo que es para siempre, en varios teléfonos)
  const bans = new Map(); // uid vetado de las tablas → { at, why }
  const ledgers = new Map(); // cuenta → { uid, wealth, room, at, bought, trusted }
  const ofWeek = (week) => [...scores.values()].filter((s) => s.week === week);
  const order = (a, b) => b.time - a.time || a.at - b.at;
  return {
    async putScore(week, uid, nick, time, at, started = 0) {
      const key = week + '|' + uid,
        old = scores.get(key);
      if (!old) scores.set(key, { week, uid, nick, time, at, started });
      else {
        old.nick = nick;
        if (time > old.time && (!started || started > old.started)) Object.assign(old, { time, at, started });
      }
    },
    async top(week, limit) {
      return ofWeek(week)
        .sort(order)
        .slice(0, limit)
        .map(({ uid, nick, time, at, started }) => ({ uid, nick, time, at, started }));
    },
    async mine(week, uid) {
      const s = scores.get(week + '|' + uid);
      return s ? { time: s.time, at: s.at } : null;
    },
    async ahead(week, time, at) {
      return ofWeek(week).filter((s) => s.time > time || (s.time === time && s.at < at)).length;
    },
    async total(week) {
      return ofWeek(week).length;
    },
    async putVisits(uid, first, days) {
      for (const day of days) if (!visits.has(uid + '|' + day)) visits.set(uid + '|' + day, { uid, day, first });
    },
    async cohorts(limit, since = 0) {
      const by = new Map();
      for (const v of visits.values()) {
        if (v.first < since) continue;
        if (!by.has(v.first)) by.set(v.first, { first: v.first, all: new Set(), 1: new Set(), 3: new Set(), 7: new Set(), 30: new Set() });
        const c = by.get(v.first);
        c.all.add(v.uid);
        for (const k of [1, 3, 7, 30]) if (v.day === v.first + k) c[k].add(v.uid);
      }
      return [...by.values()]
        .sort((a, b) => b.first - a.first)
        .slice(0, limit)
        .map((c) => ({ first: c.first, n: c.all.size, d1: c[1].size, d3: c[3].size, d7: c[7].size, d30: c[30].size }));
    },
    async active(day) {
      return new Set([...visits.values()].filter((v) => v.day === day).map((v) => v.uid)).size;
    },
    async putDuel(code, seed, uid, nick, at) {
      if (duels.has(code)) return false;
      duels.set(code, { code, seed, uid, nick, at });
      return true;
    },
    async duel(code) {
      return duels.get(code) || null;
    },
    async ban(uid, at, why = 'admin') {
      if (!bans.has(uid)) bans.set(uid, { at, why });
    },
    async bans(limit) {
      return [...bans]
        .map(([uid, b]) => ({ uid, at: b.at, why: b.why }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
    async unban(uid) {
      bans.delete(uid);
    },
    async banned(uid) {
      return bans.has(uid);
    },
    async dropScores(uid) {
      let n = 0;
      for (const [key, sc] of scores) if (sc.uid === uid && scores.delete(key)) n++;
      return n;
    },
    async dropWeeksBefore(week) {
      let n = 0;
      for (const [key, sc] of scores) if (sc.week < week && scores.delete(key)) n++;
      return n;
    },
    async dropDuelsBefore(at) {
      let n = 0;
      for (const d of [...duels.values()]) {
        if (d.at >= at || ofWeek('r' + d.code).some((sc) => sc.at >= at)) continue;
        for (const sc of ofWeek('r' + d.code)) scores.delete(sc.week + '|' + sc.uid);
        duels.delete(d.code);
        n++;
      }
      return n;
    },
    async dropVisitsBefore(day) {
      let n = 0;
      for (const [key, v] of visits) if (v.day < day && visits.delete(key)) n++;
      return n;
    },
    async putNonce(hash, expires) {
      nonces.set(hash, expires);
    },
    async takeNonce(hash, now) {
      const ok = nonces.has(hash) && nonces.get(hash) > now;
      nonces.delete(hash);
      return ok;
    },
    async accountBySub(sub) {
      for (const a of accounts.values()) if (a.sub === sub) return a.id;
      return null;
    },
    async putAccount(id, sub, at) {
      accounts.set(id, { id, sub, at });
    },
    async putSession(hash, account, expires, created) {
      sessions.set(hash, { account, expires, created });
    },
    async session(hash) {
      const s = sessions.get(hash);
      return s ? { account: s.account, expires: s.expires, created: s.created } : null;
    },
    async touchSession(hash, expires) {
      if (sessions.has(hash)) sessions.get(hash).expires = expires;
    },
    async dropSession(hash) {
      sessions.delete(hash);
    },
    async dropSessions(account) {
      for (const [hash, s] of sessions) if (s.account === account) sessions.delete(hash);
    },
    async getSave(account) {
      const s = saves.get(account);
      return s ? { data: s.data, version: s.version, at: s.at } : null;
    },
    async putSave(account, data, base, at) {
      const old = saves.get(account);
      if ((old ? old.version : 0) !== base) return false;
      saves.set(account, { data, version: base + 1, at });
      return true;
    },
    async dropAccount(account) {
      accounts.delete(account);
      saves.delete(account);
      ledgers.delete(account);
      for (const [hash, s] of sessions) if (s.account === account) sessions.delete(hash);
    },
    async bump(key, slot, max = Infinity) {
      const k = key + '|' + slot,
        n = limits.get(k) || 0;
      if (n >= max) return max + 1;
      limits.set(k, n + 1);
      return n + 1;
    },
    async peek(key, slot) {
      return limits.get(key + '|' + slot) || 0;
    },
    async purchase(hash) {
      const p = bought.get(hash);
      return p ? { ...p } : null;
    },
    async putPurchase(hash, product, order, at) {
      if (bought.has(hash)) return false;
      bought.set(hash, { product, order, at, delivered: 0, settled: 0, claimant: null });
      return true;
    },
    async claimPurchase(hash, claimant) {
      const p = bought.get(hash);
      if (p && p.claimant === null) p.claimant = claimant;
    },
    async addClaim(hash, claimant, at, max) {
      const list = claims.get(hash) || new Set();
      if (!list.has(claimant) && list.size < max) list.add(claimant);
      claims.set(hash, list);
      return list.has(claimant);
    },
    async hasClaim(hash, claimant) {
      return !!claims.get(hash)?.has(claimant);
    },
    async markPurchase(hash, delivered, settled) {
      const p = bought.get(hash);
      if (p) Object.assign(p, { delivered: delivered ? 1 : 0, settled: settled ? 1 : 0 });
    },
    async ledger(account) {
      const l = ledgers.get(account);
      return l ? { ...l } : null;
    },
    async putLedger(account, l) {
      ledgers.set(account, { uid: l.uid, wealth: l.wealth, room: l.room, at: l.at, bought: l.bought, trusted: l.trusted ? 1 : 0 });
    },
    async trustLedgers(uid) {
      for (const l of ledgers.values()) if (l.uid === uid) l.trusted = 1;
    },
    async boughtBy(claimant) {
      const n = {};
      for (const p of bought.values()) if (p.claimant === claimant) n[p.product] = (n[p.product] || 0) + 1;
      return Object.entries(n).map(([product, count]) => ({ product, n: count }));
    },
    async claimedBy(claimant) {
      return [...claims.values()].some((list) => list.has(claimant));
    },
    async sweep(now, slot) {
      for (const [hash, expires] of nonces) if (expires <= now) nonces.delete(hash);
      for (const [hash, s] of sessions) if (s.expires <= now) sessions.delete(hash);
      for (const k of limits.keys()) if (+k.split('|').pop() < slot) limits.delete(k);
    },
  };
}

export function d1Store(db) {
  const one = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .first();
  /* ejecuta y devuelve cuántas filas cambió */
  const run = async (sql, ...args) =>
    (
      await db
        .prepare(sql)
        .bind(...args)
        .run()
    ).meta.changes;
  return {
    /* las tres columnas de la marca cambian juntas o ninguna (todas miran la fila como estaba) */
    async putScore(week, uid, nick, time, at, started = 0) {
      const BETTER = 'excluded.time > scores.time AND (excluded.started = 0 OR excluded.started > scores.started)';
      await db
        .prepare(
          `INSERT INTO scores (week, uid, nick, time, at, started) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (week, uid) DO UPDATE SET
             nick = excluded.nick,
             at = CASE WHEN ${BETTER} THEN excluded.at ELSE scores.at END,
             started = CASE WHEN ${BETTER} THEN excluded.started ELSE scores.started END,
             time = CASE WHEN ${BETTER} THEN excluded.time ELSE scores.time END`,
        )
        .bind(week, uid, nick, time, at, started)
        .run();
    },
    async top(week, limit) {
      const r = await db
        .prepare('SELECT uid, nick, time, at, started FROM scores WHERE week = ?1 ORDER BY time DESC, at ASC LIMIT ?2')
        .bind(week, limit)
        .all();
      return r.results;
    },
    async mine(week, uid) {
      return (await one('SELECT time, at FROM scores WHERE week = ?1 AND uid = ?2', week, uid)) || null;
    },
    async ahead(week, time, at) {
      const r = await one(
        'SELECT COUNT(*) AS n FROM scores WHERE week = ?1 AND (time > ?2 OR (time = ?2 AND at < ?3))',
        week,
        time,
        at,
      );
      return r.n;
    },
    async total(week) {
      return (await one('SELECT COUNT(*) AS n FROM scores WHERE week = ?1', week)).n;
    },
    async putVisits(uid, first, days) {
      const insert = db.prepare('INSERT OR IGNORE INTO visits (uid, day, first) VALUES (?1, ?2, ?3)');
      await db.batch(days.map((day) => insert.bind(uid, day, first)));
    },
    async cohorts(limit, since = 0) {
      const r = await db
        .prepare(
          `SELECT first,
                  COUNT(DISTINCT uid) AS n,
                  COUNT(DISTINCT CASE WHEN day = first + 1 THEN uid END) AS d1,
                  COUNT(DISTINCT CASE WHEN day = first + 3 THEN uid END) AS d3,
                  COUNT(DISTINCT CASE WHEN day = first + 7 THEN uid END) AS d7,
                  COUNT(DISTINCT CASE WHEN day = first + 30 THEN uid END) AS d30
           FROM visits WHERE first >= ?2 GROUP BY first ORDER BY first DESC LIMIT ?1`,
        )
        .bind(limit, since)
        .all();
      return r.results;
    },
    async active(day) {
      return (await one('SELECT COUNT(DISTINCT uid) AS n FROM visits WHERE day = ?1', day)).n;
    },
    async putDuel(code, seed, uid, nick, at) {
      if (await one('SELECT code FROM duels WHERE code = ?1', code)) return false;
      await db
        .prepare('INSERT INTO duels (code, seed, uid, nick, at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(code, seed, uid, nick, at)
        .run();
      return true;
    },
    async duel(code) {
      return (await one('SELECT code, seed, uid, nick, at FROM duels WHERE code = ?1', code)) || null;
    },
    async ban(uid, at, why = 'admin') {
      await run('INSERT OR IGNORE INTO bans (uid, at, why) VALUES (?1, ?2, ?3)', uid, at, why);
    },
    async bans(limit) {
      return (await db.prepare('SELECT uid, at, why FROM bans ORDER BY at DESC LIMIT ?1').bind(limit).all()).results;
    },
    async unban(uid) {
      await run('DELETE FROM bans WHERE uid = ?1', uid);
    },
    async banned(uid) {
      return !!(await one('SELECT uid FROM bans WHERE uid = ?1', uid));
    },
    async dropScores(uid) {
      return run('DELETE FROM scores WHERE uid = ?1', uid);
    },
    /* las claves de los retos empiezan por "r" y las de las semanas son fechas: comparar como
       texto con una fecha solo toca semanas */
    async dropWeeksBefore(week) {
      return run('DELETE FROM scores WHERE week < ?1', week);
    },
    async dropDuelsBefore(at) {
      const OLD = `at < ?1 AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.week = 'r' || duels.code AND s.at >= ?1)`;
      await run(`DELETE FROM scores WHERE week IN (SELECT 'r' || code FROM duels WHERE ${OLD})`, at);
      /* sin marcas ya, un reto viejo es justo el que no tiene ninguna */
      return run(`DELETE FROM duels WHERE at < ?1 AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.week = 'r' || duels.code)`, at);
    },
    async dropVisitsBefore(day) {
      return run('DELETE FROM visits WHERE day < ?1', day);
    },
    async putNonce(hash, expires) {
      await run('INSERT OR REPLACE INTO nonces (hash, expires) VALUES (?1, ?2)', hash, expires);
    },
    async takeNonce(hash, now) {
      const ok = (await run('DELETE FROM nonces WHERE hash = ?1 AND expires > ?2', hash, now)) === 1;
      if (!ok) await run('DELETE FROM nonces WHERE hash = ?1', hash);
      return ok;
    },
    async accountBySub(sub) {
      const r = await one('SELECT id FROM accounts WHERE sub = ?1', sub);
      return r ? r.id : null;
    },
    async putAccount(id, sub, at) {
      await run('INSERT INTO accounts (id, sub, at) VALUES (?1, ?2, ?3)', id, sub, at);
    },
    async putSession(hash, account, expires, created) {
      await run('INSERT INTO sessions (hash, account, expires, created) VALUES (?1, ?2, ?3, ?4)', hash, account, expires, created);
    },
    async session(hash) {
      return (await one('SELECT account, expires, created FROM sessions WHERE hash = ?1', hash)) || null;
    },
    async touchSession(hash, expires) {
      await run('UPDATE sessions SET expires = ?2 WHERE hash = ?1', hash, expires);
    },
    async dropSession(hash) {
      await run('DELETE FROM sessions WHERE hash = ?1', hash);
    },
    async dropSessions(account) {
      await run('DELETE FROM sessions WHERE account = ?1', account);
    },
    async getSave(account) {
      return (await one('SELECT data, version, at FROM saves WHERE account = ?1', account)) || null;
    },
    /* guardar es una sola instrucción que solo cambia algo si la versión es la esperada: dos
       teléfonos guardando a la vez no se pisan */
    async putSave(account, data, base, at) {
      if (base === 0)
        return (await run('INSERT OR IGNORE INTO saves (account, data, version, at) VALUES (?1, ?2, 1, ?3)', account, data, at)) === 1;
      return (
        (await run('UPDATE saves SET data = ?2, version = version + 1, at = ?4 WHERE account = ?1 AND version = ?3', account, data, base, at)) === 1
      );
    },
    async dropAccount(account) {
      await run('DELETE FROM sessions WHERE account = ?1', account);
      await run('DELETE FROM saves WHERE account = ?1', account);
      await run('DELETE FROM ledgers WHERE account = ?1', account);
      await run('DELETE FROM accounts WHERE id = ?1', account);
    },
    /* una sola instrucción: cuenta el intento, y si ya va en el tope no cambia nada (no hay
       escritura) y no devuelve fila */
    async bump(key, slot, max = 1e9) {
      const r = await one(
        'INSERT INTO limits (key, slot, n) VALUES (?1, ?2, 1) ON CONFLICT (key, slot) DO UPDATE SET n = n + 1 WHERE n < ?3 RETURNING n',
        key,
        slot,
        max,
      );
      return r ? r.n : max + 1;
    },
    async peek(key, slot) {
      const r = await one('SELECT n FROM limits WHERE key = ?1 AND slot = ?2', key, slot);
      return r ? r.n : 0;
    },
    async purchase(hash) {
      return (
        (await one('SELECT product, order_id AS "order", at, delivered, settled, claimant FROM purchases WHERE hash = ?1', hash)) || null
      );
    },
    async putPurchase(hash, product, order, at) {
      return (await run('INSERT OR IGNORE INTO purchases (hash, product, order_id, at) VALUES (?1, ?2, ?3, ?4)', hash, product, order, at)) === 1;
    },
    /* solo cambia algo si nadie la reclamó antes: dos peticiones a la vez no pueden quedarse las dos con ella */
    async claimPurchase(hash, claimant) {
      await run('UPDATE purchases SET claimant = ?2 WHERE hash = ?1 AND claimant IS NULL', hash, claimant);
    },
    async addClaim(hash, claimant, at, max) {
      await run(
        `INSERT OR IGNORE INTO claims (hash, claimant, at)
         SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM claims WHERE hash = ?1) < ?4`,
        hash,
        claimant,
        at,
        max,
      );
      return !!(await one('SELECT 1 AS ok FROM claims WHERE hash = ?1 AND claimant = ?2', hash, claimant));
    },
    async hasClaim(hash, claimant) {
      return !!(await one('SELECT 1 AS ok FROM claims WHERE hash = ?1 AND claimant = ?2', hash, claimant));
    },
    async markPurchase(hash, delivered, settled) {
      await run('UPDATE purchases SET delivered = ?2, settled = ?3 WHERE hash = ?1', hash, delivered ? 1 : 0, settled ? 1 : 0);
    },
    async ledger(account) {
      return (await one('SELECT uid, wealth, room, at, bought, trusted FROM ledgers WHERE account = ?1', account)) || null;
    },
    async putLedger(account, l) {
      await run(
        `INSERT INTO ledgers (account, uid, wealth, room, at, bought, trusted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (account) DO UPDATE SET uid = excluded.uid, wealth = excluded.wealth, room = excluded.room,
           at = excluded.at, bought = excluded.bought, trusted = excluded.trusted`,
        account,
        l.uid,
        l.wealth,
        l.room,
        l.at,
        l.bought,
        l.trusted ? 1 : 0,
      );
    },
    async trustLedgers(uid) {
      await run('UPDATE ledgers SET trusted = 1 WHERE uid = ?1', uid);
    },
    async boughtBy(claimant) {
      return (await db.prepare('SELECT product, COUNT(*) AS n FROM purchases WHERE claimant = ?1 GROUP BY product').bind(claimant).all()).results;
    },
    async claimedBy(claimant) {
      return !!(await one('SELECT 1 AS ok FROM claims WHERE claimant = ?1 LIMIT 1', claimant));
    },
    async sweep(now, slot) {
      await run('DELETE FROM nonces WHERE expires <= ?1', now);
      await run('DELETE FROM sessions WHERE expires <= ?1', now);
      await run('DELETE FROM limits WHERE slot < ?1', slot);
    },
  };
}
