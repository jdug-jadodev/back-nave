/**
 * El almacén de Cloudflare (D1) es SQLite. Aquí sus consultas corren contra el SQLite que trae
 * Node, con el mismo schema.sql, y se compara cada respuesta con la del almacén en memoria:
 * los dos deben contestar exactamente lo mismo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { d1Store, memoryStore } from '../src/almacenes.js';

/* lo mínimo de la interfaz de D1, sobre el SQLite de Node */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => void db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => void (await Promise.all(list.map((s) => s.run()))) };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('la base de datos real contesta igual que el almacén en memoria', async () => {
  const stores = [memoryStore(), d1Store(fakeD1())];
  const both = async (method, ...args) => {
    const [a, b] = await Promise.all(stores.map((s) => s[method](...args)));
    assert.deepEqual(plain(b ?? null), plain(a ?? null), method + ' ' + JSON.stringify(args));
    return a;
  };
  const W = '2026-11-16';
  await both('putScore', W, 'u1', 'Ana', 120, 1000);
  await both('putScore', W, 'u2', 'Beto', 200, 2000);
  await both('putScore', W, 'u3', 'Caro', 120, 3000);
  await both('putScore', W, 'u1', 'Anita', 90, 4000); // peor: no baja, pero cambia el apodo
  await both('putScore', W, 'u3', 'Caro', 300, 5000); // mejor: sube y se anota cuándo
  await both('putScore', '2026-11-09', 'u9', 'Vieja', 999, 10);

  const top = await both('top', W, 20);
  assert.deepEqual(
    top.map((r) => [r.nick, r.time]),
    [
      ['Caro', 300],
      ['Beto', 200],
      ['Anita', 120],
    ],
  );
  await both('top', W, 2);
  const mine = await both('mine', W, 'u1');
  assert.deepEqual({ time: mine.time, at: mine.at }, { time: 120, at: 1000 });
  await both('mine', W, 'nadie');
  assert.equal(await both('ahead', W, 120, 1000), 2);
  await both('ahead', W, 120, 3500);
  await both('ahead', W, 500, 1);
  assert.equal(await both('total', W), 3);
  await both('total', 'vacía');

  await both('putVisits', 'u1', 100, [100, 101, 107]);
  await both('putVisits', 'u2', 100, [100, 101]);
  await both('putVisits', 'u3', 100, [100, 130]);
  await both('putVisits', 'u4', 105, [105, 108]);
  await both('putVisits', 'u1', 100, [100, 101]); // repetido
  const cohorts = await both('cohorts', 60);
  assert.deepEqual(plain(cohorts), [
    { first: 105, n: 1, d1: 0, d3: 1, d7: 0, d30: 0 },
    { first: 100, n: 3, d1: 2, d3: 0, d7: 1, d30: 1 },
  ]);
  await both('cohorts', 1);
  assert.equal(await both('active', 101), 2);
  await both('active', 999);
});
