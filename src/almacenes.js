/**
 * Los dos almacenes del servidor. Ambos ofrecen exactamente lo mismo:
 *
 *   putScore(week, uid, nick, time, at)   guarda el tiempo si mejora el que había; el apodo siempre se actualiza
 *   top(week, limit) · mine(week, uid) · ahead(week, time, at) · total(week)
 *   putVisits(uid, first, days) · cohorts(limit) · active(day)
 *   putDuel(code, seed, uid, nick, at) → false si el código ya existe · duel(code)
 *
 * Para las cuentas (cuentas.js):
 *   putNonce(hash, expires) · takeNonce(hash, now) → true si existía y seguía vigente (y lo gasta)
 *   accountBySub(sub) → id o null · putAccount(id, sub, at)
 *   putSession(hash, account, expires) · session(hash) · touchSession(hash, expires) · dropSession(hash)
 *   getSave(account) → { data, version, at } o null
 *   putSave(account, data, base, at) → true si se guardó (solo si la versión guardada es `base`)
 *   dropAccount(account)   borra la cuenta, sus sesiones y su progreso
 *   bump(key, slot) → cuántos intentos van en esa ventana · sweep(now, slot)   bota lo vencido
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
  const ofWeek = (week) => [...scores.values()].filter((s) => s.week === week);
  const order = (a, b) => b.time - a.time || a.at - b.at;
  return {
    async putScore(week, uid, nick, time, at) {
      const key = week + '|' + uid,
        old = scores.get(key);
      if (!old) scores.set(key, { week, uid, nick, time, at });
      else {
        old.nick = nick;
        if (time > old.time) Object.assign(old, { time, at });
      }
    },
    async top(week, limit) {
      return ofWeek(week)
        .sort(order)
        .slice(0, limit)
        .map(({ uid, nick, time }) => ({ uid, nick, time }));
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
    async cohorts(limit) {
      const by = new Map();
      for (const v of visits.values()) {
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
    async putSession(hash, account, expires) {
      sessions.set(hash, { account, expires });
    },
    async session(hash) {
      const s = sessions.get(hash);
      return s ? { account: s.account, expires: s.expires } : null;
    },
    async touchSession(hash, expires) {
      if (sessions.has(hash)) sessions.get(hash).expires = expires;
    },
    async dropSession(hash) {
      sessions.delete(hash);
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
      for (const [hash, s] of sessions) if (s.account === account) sessions.delete(hash);
    },
    async bump(key, slot) {
      const k = key + '|' + slot,
        n = (limits.get(k) || 0) + 1;
      limits.set(k, n);
      return n;
    },
    async sweep(now, slot) {
      for (const [hash, expires] of nonces) if (expires <= now) nonces.delete(hash);
      for (const [hash, s] of sessions) if (s.expires <= now) sessions.delete(hash);
      for (const k of limits.keys()) if (+k.split('|').pop() < slot - 1) limits.delete(k);
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
    async putScore(week, uid, nick, time, at) {
      await db
        .prepare(
          `INSERT INTO scores (week, uid, nick, time, at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (week, uid) DO UPDATE SET
             nick = excluded.nick,
             at = CASE WHEN excluded.time > scores.time THEN excluded.at ELSE scores.at END,
             time = MAX(scores.time, excluded.time)`,
        )
        .bind(week, uid, nick, time, at)
        .run();
    },
    async top(week, limit) {
      const r = await db
        .prepare('SELECT uid, nick, time FROM scores WHERE week = ?1 ORDER BY time DESC, at ASC LIMIT ?2')
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
    async cohorts(limit) {
      const r = await db
        .prepare(
          `SELECT first,
                  COUNT(DISTINCT uid) AS n,
                  COUNT(DISTINCT CASE WHEN day = first + 1 THEN uid END) AS d1,
                  COUNT(DISTINCT CASE WHEN day = first + 3 THEN uid END) AS d3,
                  COUNT(DISTINCT CASE WHEN day = first + 7 THEN uid END) AS d7,
                  COUNT(DISTINCT CASE WHEN day = first + 30 THEN uid END) AS d30
           FROM visits GROUP BY first ORDER BY first DESC LIMIT ?1`,
        )
        .bind(limit)
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
    async putSession(hash, account, expires) {
      await run('INSERT INTO sessions (hash, account, expires) VALUES (?1, ?2, ?3)', hash, account, expires);
    },
    async session(hash) {
      return (await one('SELECT account, expires FROM sessions WHERE hash = ?1', hash)) || null;
    },
    async touchSession(hash, expires) {
      await run('UPDATE sessions SET expires = ?2 WHERE hash = ?1', hash, expires);
    },
    async dropSession(hash) {
      await run('DELETE FROM sessions WHERE hash = ?1', hash);
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
      await run('DELETE FROM accounts WHERE id = ?1', account);
    },
    async bump(key, slot) {
      const r = await one(
        'INSERT INTO limits (key, slot, n) VALUES (?1, ?2, 1) ON CONFLICT (key, slot) DO UPDATE SET n = n + 1 RETURNING n',
        key,
        slot,
      );
      return r.n;
    },
    async sweep(now, slot) {
      await run('DELETE FROM nonces WHERE expires <= ?1', now);
      await run('DELETE FROM sessions WHERE expires <= ?1', now);
      await run('DELETE FROM limits WHERE slot < ?1', slot - 1);
    },
  };
}
