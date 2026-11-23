/**
 * El almacén de Cloudflare (D1) es SQLite. Aquí sus consultas corren contra el SQLite que trae
 * Node, con el mismo schema.sql, y se compara cada respuesta con la del almacén en memoria:
 * los dos deben contestar exactamente lo mismo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d1Store, memoryStore } from '../src/almacenes.js';
import { fakeD1 } from './apoyo/d1.mjs';

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
  await both('putSession', 's1', 'A', 9000, 40);
  await both('putSession', 's2', 'A', 9000, 41);
  await both('putSession', 's3', 'B', 2000, 42);
  assert.deepEqual(plain(await both('session', 's1')), { account: 'A', expires: 9000, created: 40 });
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
  /* con tope: al llegar deja de contar (y de escribir) y avisa con tope + 1 */
  assert.equal(await both('bump', 'tope', 7, 2), 1);
  assert.equal(await both('bump', 'tope', 7, 2), 2);
  assert.equal(await both('bump', 'tope', 7, 2), 3, 'pasado');
  assert.equal(await both('bump', 'tope', 7, 2), 3);
  assert.equal(await both('peek', 'tope', 7), 2, 'el contador se quedó en el tope');
  assert.equal(await both('peek', 'nadie', 7), 0);
  /* limpieza: se va lo vencido y los contadores de ventanas anteriores */
  await both('putNonce', 'viejo', 100);
  await both('sweep', 3000, 8);
  assert.equal(await both('takeNonce', 'viejo', 50), false);
  assert.equal(await both('session', 's3'), null, 'sesión vencida');
  assert.ok(await both('session', 's1'));
  assert.equal(await both('bump', 'ip:1', 7), 1, 'el contador de la ventana 7 se botó');
  assert.equal(await both('bump', 'ip:1', 8), 2, 'el de la 8 no');
  /* compras */
  assert.equal(await both('purchase', 'c1'), null);
  await both('putPurchase', 'c1', 'coins_s', 'GPA.1', 500);
  await both('putPurchase', 'c1', 'coins_l', 'GPA.otra', 999); // repetida: no cambia nada
  assert.deepEqual(plain(await both('purchase', 'c1')), { product: 'coins_s', order: 'GPA.1', at: 500, delivered: 0, settled: 0, claimant: null });
  /* la compra queda a nombre del primero que la reclama, y de nadie más */
  await both('claimPurchase', 'c1', 'ana');
  await both('claimPurchase', 'c1', 'beto');
  assert.equal((await both('purchase', 'c1')).claimant, 'ana');
  await both('claimPurchase', 'noexiste', 'ana');
  await both('markPurchase', 'c1', 1, 0);
  assert.equal((await both('purchase', 'c1')).delivered, 1);
  await both('markPurchase', 'c1', 1, 1);
  assert.deepEqual(plain(await both('purchase', 'c1')), { product: 'coins_s', order: 'GPA.1', at: 500, delivered: 1, settled: 1, claimant: 'ana' });
  await both('markPurchase', 'noexiste', 1, 1);
  /* lo que es para siempre: varios reclamantes, hasta un tope */
  assert.equal(await both('addClaim', 'c2', 'ana', 1, 2), true);
  assert.equal(await both('addClaim', 'c2', 'ana', 2, 2), true, 'la misma otra vez no gasta cupo');
  assert.equal(await both('addClaim', 'c2', 'beto', 3, 2), true);
  assert.equal(await both('addClaim', 'c2', 'caro', 4, 2), false, 'ya no hay cupo');
  assert.equal(await both('addClaim', 'c2', 'beto', 5, 2), true, 'las que ya estaban siguen valiendo');
  assert.equal(await both('hasClaim', 'c2', 'ana'), true);
  assert.equal(await both('hasClaim', 'c2', 'caro'), false);
  assert.equal(await both('hasClaim', 'c9', 'ana'), false);
  /* cerrar todas las sesiones de una cuenta no toca las de otra */
  await both('putSession', 's8', 'B', 9000, 1);
  await both('putSession', 's9', 'A', 9000, 1);
  await both('dropSessions', 'A');
  assert.equal(await both('session', 's1'), null);
  assert.equal(await both('session', 's9'), null);
  assert.ok(await both('session', 's8'));
  await both('putSession', 's1', 'A', 9000, 1);
  /* borrar una cuenta no toca a las demás */
  await both('dropAccount', 'A');
  assert.equal(await both('accountBySub', 'huella-a'), null);
  assert.equal(await both('session', 's1'), null);
  assert.equal(await both('getSave', 'A'), null);
  assert.deepEqual(plain(await both('getSave', 'B')), { data: '{"b":1}', version: 1, at: 104 });
  assert.equal(await both('accountBySub', 'huella-b'), 'B');
});

test('limpieza y vetos: la base de datos real contesta igual que el almacén en memoria', async () => {
  const stores = [memoryStore(), d1Store(fakeD1())];
  const both = async (method, ...args) => {
    const [a, b] = await Promise.all(stores.map((s) => s[method](...args)));
    assert.deepEqual(plain(b ?? null), plain(a ?? null), method + ' ' + JSON.stringify(args));
    return a;
  };
  /* copas viejas: se van las semanas anteriores a la fecha, no los retos (su clave empieza por "r") */
  await both('putScore', '2026-09-07', 'u1', 'Ana', 50, 10);
  await both('putScore', '2026-11-09', 'u1', 'Ana', 60, 20);
  await both('putScore', '2026-11-16', 'u1', 'Ana', 70, 30);
  await both('putDuel', 'VIEJO2', 1, 'u1', 'Ana', 1000);
  await both('putScore', 'rVIEJO2', 'u1', 'Ana', 40, 1000);
  await both('putScore', 'rVIEJO2', 'u2', 'Beto', 45, 1500);
  await both('putDuel', 'ACTIVO', 2, 'u1', 'Ana', 1000);
  await both('putScore', 'rACTIVO', 'u1', 'Ana', 40, 1000);
  await both('putScore', 'rACTIVO', 'u3', 'Caro', 90, 9000); // alguien lo jugó hace poco
  await both('putDuel', 'NUEVO2', 3, 'u2', 'Beto', 8000);
  await both('putScore', 'rNUEVO2', 'u2', 'Beto', 33, 8000);
  assert.equal(await both('dropWeeksBefore', '2026-11-09'), 1);
  assert.equal(await both('total', '2026-09-07'), 0);
  assert.equal(await both('total', '2026-11-09'), 1);
  assert.equal(await both('total', 'rVIEJO2'), 2, 'los retos no se tocan aquí');
  /* retos: se va el que es viejo y nadie ha jugado desde entonces, con sus marcas */
  assert.equal(await both('dropDuelsBefore', 5000), 1);
  assert.equal(await both('duel', 'VIEJO2'), null);
  assert.equal(await both('total', 'rVIEJO2'), 0);
  assert.ok(await both('duel', 'ACTIVO'), 'viejo pero con una marca reciente: se queda');
  assert.equal(await both('total', 'rACTIVO'), 2);
  assert.ok(await both('duel', 'NUEVO2'));
  assert.equal(await both('dropDuelsBefore', 5000), 0, 'repetirla no borra nada más');
  /* medición: se van los días anteriores, y el panel puede pedir solo a quienes llegaron desde un día */
  await both('putVisits', 'u1', 100, [100, 101, 130]);
  await both('putVisits', 'u2', 120, [120, 121]);
  assert.equal(await both('dropVisitsBefore', 101), 1);
  assert.equal(await both('active', 100), 0);
  assert.equal(await both('active', 101), 1);
  assert.deepEqual(plain(await both('cohorts', 60, 110)), [{ first: 120, n: 1, d1: 1, d3: 0, d7: 0, d30: 0 }]);
  /* vetos: el vetado, y borrar todas sus marcas */
  assert.equal(await both('banned', 'u1'), false);
  await both('ban', 'u1', 5);
  await both('ban', 'u1', 6);
  assert.equal(await both('banned', 'u1'), true);
  assert.equal(await both('banned', 'u2'), false);
  assert.equal(await both('dropScores', 'u1'), 3);
  assert.equal(await both('total', '2026-11-16'), 0);
  assert.equal(await both('total', 'rACTIVO'), 1);
  await both('unban', 'u1');
  assert.equal(await both('banned', 'u1'), false);
});

test('tiquetes, vetos con motivo y tope de monedas: la base de datos real contesta igual que el almacén en memoria', async () => {
  const stores = [memoryStore(), d1Store(fakeD1())];
  const both = async (method, ...args) => {
    const [a, b] = await Promise.all(stores.map((s) => s[method](...args)));
    assert.deepEqual(plain(b ?? null), plain(a ?? null), method + ' ' + JSON.stringify(args));
    return a;
  };
  const W = '2026-11-16';
  /* una marca mejor solo vale con un tiquete más nuevo que el de la marca que había */
  await both('putScore', W, 'u1', 'Ana', 100, 1000, 500);
  await both('putScore', W, 'u1', 'Ana', 600, 2000, 500); // el mismo tiquete: no
  assert.deepEqual(plain(await both('mine', W, 'u1')), { time: 100, at: 1000 });
  await both('putScore', W, 'u1', 'Ana', 600, 3000, 400); // uno más viejo: tampoco
  assert.equal((await both('mine', W, 'u1')).time, 100);
  await both('putScore', W, 'u1', 'Anita', 300, 4000, 3500); // uno nuevo: sí
  assert.deepEqual(plain(await both('top', W, 5)), [{ uid: 'u1', nick: 'Anita', time: 300, at: 4000, started: 3500 }]);
  await both('putScore', W, 'u1', 'Anita', 200, 5000, 4800); // tiquete nuevo pero peor tiempo: no baja
  assert.deepEqual(plain(await both('top', W, 5)), [{ uid: 'u1', nick: 'Anita', time: 300, at: 4000, started: 3500 }]);
  /* sin tiquete (los retos): como siempre, gana el mejor tiempo */
  await both('putScore', 'rABC', 'u1', 'Ana', 50, 10);
  await both('putScore', 'rABC', 'u1', 'Ana', 80, 20);
  assert.equal((await both('mine', 'rABC', 'u1')).time, 80);

  /* vetos con motivo, los más recientes primero; el primero que llega es el que queda */
  await both('ban', 'u7', 100, 'monedas');
  await both('ban', 'u8', 300);
  await both('ban', 'u9', 200, 'sin anuncios');
  await both('ban', 'u7', 999, 'admin');
  assert.deepEqual(plain(await both('bans', 10)), [
    { uid: 'u8', at: 300, why: 'admin' },
    { uid: 'u9', at: 200, why: 'sin anuncios' },
    { uid: 'u7', at: 100, why: 'monedas' },
  ]);
  assert.equal((await both('bans', 2)).length, 2);

  /* el renglón del tope de cada cuenta */
  assert.equal(await both('ledger', 'A'), null);
  await both('putLedger', 'A', { uid: 'u1', wealth: 500, room: 20000, at: 10, bought: 0, trusted: 0 });
  await both('putLedger', 'B', { uid: 'u2', wealth: 900, room: 100, at: 11, bought: 8000, trusted: 0 });
  await both('putLedger', 'A', { uid: 'u1', wealth: 700, room: 19000, at: 20, bought: 1200, trusted: 0 });
  assert.deepEqual(plain(await both('ledger', 'A')), { uid: 'u1', wealth: 700, room: 19000, at: 20, bought: 1200, trusted: 0 });
  await both('trustLedgers', 'u1');
  assert.equal((await both('ledger', 'A')).trusted, 1);
  assert.equal((await both('ledger', 'B')).trusted, 0, 'solo las cuentas de esa instalación');
  await both('putAccount', 'A', 'huella-a', 1);
  await both('dropAccount', 'A');
  assert.equal(await both('ledger', 'A'), null, 'borrar la cuenta se lleva su renglón');
  assert.ok(await both('ledger', 'B'));

  /* lo que ha comprado cada instalación */
  assert.deepEqual(await both('boughtBy', 'ana'), []);
  for (const [hash, product, who] of [['c1', 'coins_l', 'ana'], ['c2', 'coins_l', 'ana'], ['c3', 'no_ads', 'ana'], ['c4', 'coins_s', 'beto'], ['c5', 'coins_m', null]]) {
    await both('putPurchase', hash, product, 'GPA.' + hash, 5);
    if (who) await both('claimPurchase', hash, who);
  }
  const bought = (await both('boughtBy', 'ana')).sort((a, b) => a.product.localeCompare(b.product));
  assert.deepEqual(plain(bought), [{ product: 'coins_l', n: 2 }, { product: 'no_ads', n: 1 }]);
  assert.equal(await both('claimedBy', 'caro'), false);
  await both('addClaim', 'c3', 'caro', 6, 5);
  assert.equal(await both('claimedBy', 'caro'), true);
});

test('el esquema tiene índices para la limpieza diaria (no recorre las tablas enteras)', () => {
  const { db } = fakeD1();
  const plan = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
  for (const sql of [
    'DELETE FROM nonces WHERE expires <= 1',
    'DELETE FROM sessions WHERE expires <= 1',
    'DELETE FROM limits WHERE slot < 1',
    "DELETE FROM scores WHERE week < '2026-01-01'",
    'DELETE FROM visits WHERE day < 1',
  ])
    assert.match(plan(sql), /USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/, sql + ' → ' + plan(sql));
});
