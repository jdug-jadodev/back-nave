-- Copa semanal: el mejor tiempo de cada jugador en cada semana (la semana se nombra por su lunes)
CREATE TABLE IF NOT EXISTS scores (
  week TEXT NOT NULL,
  uid  TEXT NOT NULL,
  nick TEXT NOT NULL,
  time INTEGER NOT NULL,   -- segundos aguantados en Supervivencia
  at   INTEGER NOT NULL,   -- cuándo se logró (para desempatar: gana quien lo hizo primero)
  PRIMARY KEY (week, uid)
);
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

-- ---------- Cuentas: progreso guardado (ver src/cuentas.js) ----------
-- Una cuenta por persona. `sub` es una huella con secreto de su número de cuenta de Google:
-- con esta tabla sola no se sabe de quién es. No se guarda correo, nombre ni contraseña.
CREATE TABLE IF NOT EXISTS accounts (
  id  TEXT PRIMARY KEY,     -- al azar
  sub TEXT NOT NULL UNIQUE,
  at  INTEGER NOT NULL      -- cuándo se creó
);
-- Sesiones abiertas. Se guarda la huella de la llave, nunca la llave.
CREATE TABLE IF NOT EXISTS sessions (
  hash    TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account);
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
-- Contadores de intentos por ventana de tiempo, para frenar el abuso.
CREATE TABLE IF NOT EXISTS limits (
  key  TEXT NOT NULL,
  slot INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (key, slot)
);
