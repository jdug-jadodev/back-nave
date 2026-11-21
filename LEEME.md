# Servidor de Giro Estelar

El juego está en otro proyecto: `C:\Users\Usuario\Documents\juego-nave`.

Un programa pequeño para Cloudflare (Workers + base de datos D1) que hace dos cosas:

- **Copa semanal:** guarda el mejor tiempo de cada jugador en Supervivencia y entrega la tabla de la semana.
- **Medición de retorno:** anota en qué días abrió el juego cada instalación y muestra cuánta gente vuelve al día siguiente, a los 3, a los 7 y a los 30 días.

No guarda datos personales: cada instalación se identifica con un número al azar y un apodo que el jugador elige.

## Probar en el computador (sin publicar nada)

```
cd C:\Users\Usuario\Documents\back-nave
npm test            # 11 pruebas: las reglas y las consultas de la base de datos
node local.mjs      # servidor de prueba en http://localhost:8787 (los datos se borran al cerrarlo)
node local.mjs 8787 demo   # lo mismo, con seis rivales de mentira en la copa
```

Para que el juego del navegador use el servidor local, abre `demo-juego.html` (en la carpeta del juego), y en la consola del navegador escribe `localStorage.giro_api = 'http://localhost:8787'` y recarga. El panel queda en `http://localhost:8787/panel?key=local`.

## Dónde está publicado

- **Dirección:** `https://giro-estelar.giro-estelar-servidor.workers.dev`
- **Cuenta:** la de negocios de Cloudflare (no la personal). Su identificador está en `wrangler.toml` (`account_id`), así que con otra cuenta la herramienta falla en vez de publicar donde no es.
- **Base de datos:** D1 `giro-estelar`, con las tablas de `schema.sql`.
- **Publicado por primera vez:** 2026-11-20.

El juego la usa desde `API_URL`, en `juego\src\core\config.js` del proyecto del juego.

## Los comandos van con `node cf.mjs`

Este computador tiene iniciada otra cuenta de Cloudflare (la personal). Para no mezclarlas, la sesión de este proyecto se guarda aparte y todo se hace con `node cf.mjs …` en vez de `npx wrangler …`:

```
node cf.mjs whoami                                                   # con qué cuenta está
node cf.mjs login                                                    # si la sesión se venció (abre el navegador)
node cf.mjs deploy                                                   # publicar cambios (o: npm run publicar)
node cf.mjs d1 execute giro-estelar --remote --command "SELECT COUNT(*) FROM scores"
node cf.mjs tail                                                     # ver las peticiones en vivo
```

Antes de publicar un cambio: `npm test`.

## Ver si la gente vuelve

`https://giro-estelar.giro-estelar-servidor.workers.dev/panel?key=LA-CLAVE`

La clave está en el archivo `.dev.vars` de esta carpeta (renglón `ADMIN_KEY=`). Ese archivo no se sube al repositorio; si se pierde, se pone una nueva con `node cf.mjs secret put ADMIN_KEY`.

El panel muestra cuántos jugaron hoy, cuántas instalaciones hay y, de los que llegaron cada día, qué porcentaje volvió. Una raya significa que todavía no ha pasado el tiempo suficiente para saberlo.

## Volver a montarlo desde cero (otra cuenta u otro nombre)

```
node cf.mjs login
node cf.mjs d1 create giro-estelar                                   # el database_id que muestra va en wrangler.toml
node cf.mjs d1 execute giro-estelar --remote --file=schema.sql -y    # crea las tablas
node cf.mjs deploy                                                   # publica y muestra la dirección
node cf.mjs secret put ADMIN_KEY                                     # la clave del panel
```

Y en `wrangler.toml` se cambia `account_id` por el de la cuenta nueva.

## Qué hay aquí

| Archivo | Qué es |
|---|---|
| `src/reglas.js` | Las reglas: qué se acepta, cómo se ordena la tabla, cómo se calcula el retorno. No depende de Cloudflare. |
| `src/almacenes.js` | Dónde se guardan los datos: en memoria (pruebas) o en D1 (Cloudflare). |
| `src/worker.js` | La entrada en Cloudflare. |
| `schema.sql` | Las tablas de la base de datos. |
| `local.mjs` | El mismo servidor corriendo en el computador. |
| `cf.mjs` | Ejecuta la herramienta de Cloudflare con la sesión de la cuenta de negocios. |
| `wrangler.toml` | Nombre, cuenta y base de datos en Cloudflare. |

## Límites conocidos

- La semana y el día se cuentan con la hora de Colombia.
- No hay control fuerte de trampas: solo se rechazan tiempos imposibles (más de 2 horas) y datos mal formados. Alcanza entre amigos; para un público abierto habría que validar las partidas.
- La tabla es una sola para todos. Con muchos jugadores convendría partirla en grupos.
