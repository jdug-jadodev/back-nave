/**
 * Los dos almacenes del servidor. Ambos ofrecen exactamente lo mismo:
 *
 *   putScore(week, uid, nick, time, at)   guarda el tiempo si mejora el que había; el apodo siempre se actualiza
 *   top(week, limit) · mine(week, uid) · ahead(week, time, at) · total(week)
 *   putVisits(uid, first, days) · cohorts(limit) · active(day)
 *
 * memoryStore: en memoria, para las pruebas y para probar el juego en el computador.
 * d1Store: la base de datos D1 de Cloudflare (ver schema.sql).
 */

export function memoryStore() {
  const scores = new Map(); // "semana|uid" → { week, uid, nick, time, at }
  const visits = new Map(); // "uid|día" → { uid, day, first }
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
  };
}

export function d1Store(db) {
  const one = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .first();
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
  };
}
