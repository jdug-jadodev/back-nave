-- Copa semanal: el mejor tiempo de cada jugador en cada semana (la semana se nombra por su lunes)
CREATE TABLE IF NOT EXISTS scores (
  week TEXT NOT NULL,
  uid  TEXT NOT NULL,
  nick TEXT NOT NULL,
  time INTEGER NOT NULL,   -- segundos aguantados en Supervivencia
  at   INTEGER NOT NULL,   -- cuándo se logró (para desempatar: gana quien lo hizo primero)
  started INTEGER NOT NULL DEFAULT 0, -- cuándo empezó esa partida, según su tiquete (0 = sin tiquete: los retos)
  PRIMARY KEY (week, uid)
);
-- (Una base creada antes del 2026-11-22 no tiene `started`: ver migracion-2026-11-22.sql)
CREATE INDEX IF NOT EXISTS scores_top ON scores (week, time DESC, at ASC);

-- Medición: un renglón por cada día en que una instalación abrió el juego.
-- uid es un número al azar por instalación: no hay nombres, correos ni datos del teléfono.
CREATE TABLE IF NOT EXISTS visits (
  uid   TEXT NOT NULL,
  day   INTEGER NOT NULL,  -- número de día (días desde 1970, hora de Colombia)
  first INTEGER NOT NULL,  -- el primer día de esa instalación
  PRIMARY KEY (uid, day)
);
CREATE INDEX IF NOT EXISTS visits_first ON visits (first);
CREATE INDEX IF NOT EXISTS visits_day ON visits (day);

-- Retos entre amigos: cada reto es una pista (su semilla) con un código corto para compartir.
-- Los tiempos de quienes lo juegan van en "scores", bajo la clave "r" + código.
CREATE TABLE IF NOT EXISTS duels (
  code TEXT PRIMARY KEY,   -- 6 letras o números, sin los que se confunden (0/O, 1/I/L)
  seed INTEGER NOT NULL,   -- la semilla de la pista
  uid  TEXT NOT NULL,      -- quién lo creó
  nick TEXT NOT NULL,
  at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS duels_at ON duels (at);

-- Jugadores vetados de las tablas (por hacer trampa): sus marcas no se guardan.
CREATE TABLE IF NOT EXISTS bans (
  uid TEXT PRIMARY KEY,
  at  INTEGER NOT NULL,
  why TEXT NOT NULL DEFAULT 'admin'  -- 'admin' = a mano desde el panel · 'monedas' / 'sin anuncios' = lo marcó tope.js
);

-- ---------- Cuentas: progreso guardado (ver src/cuentas.js) ----------
-- Una cuenta por persona. `sub` es una huella con secreto de su número de cuenta de Google:
-- con esta tabla sola no se sabe de quién es. No se guarda correo, nombre ni contraseña.
CREATE TABLE IF NOT EXISTS accounts (
  id  TEXT PRIMARY KEY,     -- al azar
  sub TEXT NOT NULL UNIQUE,
  at  INTEGER NOT NULL      -- cuándo se creó
);
-- Sesiones abiertas. Se guarda la huella de la llave, nunca la llave.
-- (Una base creada antes del 2026-11-22 no tiene `created`: ver migracion-2026-11-22.sql)
CREATE TABLE IF NOT EXISTS sessions (
  hash    TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  expires INTEGER NOT NULL,           -- vence si no se usa
  created INTEGER NOT NULL DEFAULT 0  -- cuándo se abrió: ninguna sesión vive más de un año
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
-- El progreso de cada cuenta: el mismo archivo que el juego guarda en el teléfono.
CREATE TABLE IF NOT EXISTS saves (
  account TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  version INTEGER NOT NULL, -- sube de a uno con cada guardado
  at      INTEGER NOT NULL
);
-- Números de un solo uso para iniciar sesión (su huella) y cuándo vencen.
CREATE TABLE IF NOT EXISTS nonces (
  hash    TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires);
-- Contadores de intentos por ventana de tiempo, para frenar el abuso.
CREATE TABLE IF NOT EXISTS limits (
  key  TEXT NOT NULL,
  slot INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (key, slot)
);
CREATE INDEX IF NOT EXISTS limits_slot ON limits (slot);

-- ---------- Compras verificadas con Google Play (ver src/compras.js) ----------
-- Una fila por compra: la huella del comprobante, qué se compró, el número de orden de Google,
-- si ya se entregó en el juego, si ya se cerró en Google y quién la reclamó (la huella del
-- identificador anónimo de la instalación). Nada de la persona ni del pago.
CREATE TABLE IF NOT EXISTS purchases (
  hash      TEXT PRIMARY KEY,
  product   TEXT NOT NULL,
  order_id  TEXT NOT NULL,
  at        INTEGER NOT NULL,           -- cuándo se pagó, según Google
  delivered INTEGER NOT NULL DEFAULT 0, -- 1 = el juego avisó que ya la entregó
  settled   INTEGER NOT NULL DEFAULT 0, -- 1 = ya se consumió o reconoció en Google
  claimant  TEXT                        -- quién la presentó primero: solo a él se le entrega
);
-- Lo que es para siempre ("sin anuncios") se puede recuperar en otro teléfono de la misma
-- persona: aquí van las instalaciones que lo han reclamado (pocas por compra).
CREATE TABLE IF NOT EXISTS claims (
  hash     TEXT NOT NULL,
  claimant TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (hash, claimant)
);
CREATE INDEX IF NOT EXISTS purchases_claimant ON purchases (claimant);
CREATE INDEX IF NOT EXISTS claims_claimant ON claims (claimant);

-- ---------- Tope de monedas (ver src/tope.js) ----------
-- Un renglón por cuenta: cuánto valía lo que tenía en su último guardado (monedas + piezas),
-- cuánto cupo le quedaba para ganar jugando y cuántas monedas llevaba compradas con plata.
CREATE TABLE IF NOT EXISTS ledgers (
  account TEXT PRIMARY KEY,
  uid     TEXT NOT NULL,              -- la instalación que guardó (a quien se veta si no cuadra)
  wealth  INTEGER NOT NULL,
  room    INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  bought  INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0  -- 1 = le levantaron el veto: su próximo guardado se da por bueno
);
CREATE INDEX IF NOT EXISTS ledgers_uid ON ledgers (uid);
