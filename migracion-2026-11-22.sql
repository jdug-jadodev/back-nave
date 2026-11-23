-- Paso de una base creada antes del 2026-11-22 (la que ya está publicada) al esquema actual.
-- Se ejecuta UNA sola vez, ANTES de schema.sql (repetirla falla con "duplicate column", sin dañar nada):
--
--   node cf.mjs d1 execute giro-estelar --remote --file=migracion-2026-11-22.sql -y
--   node cf.mjs d1 execute giro-estelar --remote --file=schema.sql -y
--
-- No borra ni cambia datos de nadie: agrega dos columnas y le pone fecha a las sesiones que ya había.

-- Las sesiones ahora recuerdan cuándo se abrieron (ninguna vive más de un año).
ALTER TABLE sessions ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
-- A las que ya existían se les calcula: vencían 180 días después de abrirse o de renovarse.
UPDATE sessions SET created = expires - 15552000000 WHERE created = 0;

-- Las marcas de la copa ahora recuerdan cuándo empezó la partida, según su tiquete (ver src/tiquetes.js).
ALTER TABLE scores ADD COLUMN started INTEGER NOT NULL DEFAULT 0;

-- La tabla `purchases` todavía no existía en la base publicada: schema.sql la crea completa.
-- (Si alguien la creó antes con el esquema viejo, falta además:
--    ALTER TABLE purchases ADD COLUMN claimant TEXT; )
