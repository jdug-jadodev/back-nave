/**
 * Lo mínimo de la interfaz de D1 (la base de datos de Cloudflare, que es SQLite) sobre el SQLite
 * que trae Node, con el mismo schema.sql. Para probar d1Store sin Cloudflare.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { db, prepare: (sql) => statement(sql), batch: async (list) => void (await Promise.all(list.map((s) => s.run()))) };
}
