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
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
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

  assert.equal(await both('putDuel', 'ABC234', 4000000000, 'u1', 'Ana', 7000), true);
  assert.equal(await both('putDuel', 'ABC234', 5, 'u2', 'Beto', 8000), false, 'el código ya existe');
  const d = await both('duel', 'ABC234');
  assert.deepEqual(plain(d), { code: 'ABC234', seed: 4000000000, uid: 'u1', nick: 'Ana', at: 7000 });
  await both('duel', 'NOEXIS');
});

test('cuentas: la base de datos real contesta igual que el almacén en memoria', async () => {
  const stores = [memoryStore(), d1Store(fakeD1())];
  const both = async (method, ...args) => {
    const [a, b] = await Promise.all(stores.map((s) => s[method](...args)));
    assert.deepEqual(plain(b ?? null), plain(a ?? null), method + ' ' + JSON.stringify(args));
    return a;
  };
  /* números de un solo uso */
  await both('putNonce', 'n1', 5000);
  await both('putNonce', 'n2', 5000);
  assert.equal(await both('takeNonce', 'n1', 1000), true);
  assert.equal(await both('takeNonce', 'n1', 1000), false, 'ya se gastó');
  assert.equal(await both('takeNonce', 'n2', 6000), false, 'vencido');
  assert.equal(await both('takeNonce', 'n2', 1000), false, 'y al fallar por vencido también se bota');
  assert.equal(await both('takeNonce', 'nunca', 1000), false);
  /* cuentas y sesiones */
  assert.equal(await both('accountBySub', 'huella-a'), null);
  await both('putAccount', 'A', 'huella-a', 10);
  await both('putAccount', 'B', 'huella-b', 11);
  assert.equal(await both('accountBySub', 'huella-a'), 'A');
  await both('putSession', 's1', 'A', 9000);
  await both('putSession', 's2', 'A', 9000);
  await both('putSession', 's3', 'B', 2000);
  assert.deepEqual(plain(await both('session', 's1')), { account: 'A', expires: 9000 });
  await both('touchSession', 's1', 12000);
  assert.equal((await both('session', 's1')).expires, 12000);
  await both('touchSession', 'noexiste', 1);
  await both('dropSession', 's2');
  assert.equal(await both('session', 's2'), null);
  /* progreso: solo se guarda sobre la versión esperada */
  assert.equal(await both('getSave', 'A'), null);
  assert.equal(await both('putSave', 'A', '{"c":1}', 0, 100), true);
  assert.equal(await both('putSave', 'A', '{"c":9}', 0, 101), false, 'ya había versión 1');
  assert.equal(await both('putSave', 'A', '{"c":2}', 1, 102), true);
  assert.equal(await both('putSave', 'A', '{"c":9}', 1, 103), false, 'ya va en la 2');
  assert.equal(await both('putSave', 'A', '{"c":9}', 5, 103), false, 'versión que no existe');
  assert.deepEqual(plain(await both('getSave', 'A')), { data: '{"c":2}', version: 2, at: 102 });
  assert.equal(await both('putSave', 'B', '{"b":1}', 0, 104), true);
  /* contadores */
  assert.equal(await both('bump', 'ip:1', 7), 1);
  assert.equal(await both('bump', 'ip:1', 7), 2);
  assert.equal(await both('bump', 'ip:2', 7), 1);
  assert.equal(await both('bump', 'ip:1', 8), 1, 'ventana nueva');
  /* limpieza: se va lo vencido y los contadores viejos */
  await both('putNonce', 'viejo', 100);
  await both('sweep', 3000, 9);
  assert.equal(await both('takeNonce', 'viejo', 50), false);
  assert.equal(await both('session', 's3'), null, 'sesión vencida');
  assert.ok(await both('session', 's1'));
  assert.equal(await both('bump', 'ip:1', 7), 1, 'el contador de la ventana 7 se botó');
  assert.equal(await both('bump', 'ip:1', 8), 2, 'el de la 8 no');
  /* borrar una cuenta no toca a las demás */
  await both('dropAccount', 'A');
  assert.equal(await both('accountBySub', 'huella-a'), null);
  assert.equal(await both('session', 's1'), null);
  assert.equal(await both('getSave', 'A'), null);
  assert.deepEqual(plain(await both('getSave', 'B')), { data: '{"b":1}', version: 1, at: 104 });
  assert.equal(await both('accountBySub', 'huella-b'), 'B');
});
