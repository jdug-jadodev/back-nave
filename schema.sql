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
