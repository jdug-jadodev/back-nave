# Servidor de Astrion Space

El juego está en otro proyecto: `C:\Users\Usuario\Documents\juego-nave`.

Un programa pequeño para Cloudflare (Workers + base de datos D1) que hace dos cosas:

- **Copa semanal:** guarda el mejor tiempo de cada jugador en Supervivencia y entrega la tabla de la semana.
- **Retos entre amigos:** una pista con un código de 6 letras y su propia tabla.
- **Medición de retorno:** anota en qué días abrió el juego cada instalación y muestra cuánta gente vuelve al día siguiente, a los 3, a los 7 y a los 30 días.

No guarda datos personales: cada instalación se identifica con un número al azar y un apodo que el jugador elige.

## Probar en el computador (sin publicar nada)

```
cd C:\Users\Usuario\Documents\back-nave
npm test            # las reglas, las cuentas, las compras y las consultas de la base de datos
node local.mjs      # servidor de prueba en http://localhost:8787 (los datos se borran al cerrarlo)
node local.mjs 8787 demo   # lo mismo, con seis rivales de mentira en la copa
node local.mjs 8787 --red  # además atiende a otros aparatos de la red (para probar desde el teléfono)
```

Sin `--red` el servidor de prueba solo atiende a este computador: regala comprobantes de Google de mentira y su clave de administración es `local`, así que no debe quedar a la vista de la red.

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

La clave en la dirección queda en el historial del navegador. Para lo que no sea abrir el panel a mano (los datos en `/v1/stats`, sacar a un tramposo) va mejor en la cabecera, que no queda guardada en ningún lado:

```
curl -H "Authorization: Bearer LA-CLAVE" https://giro-estelar.giro-estelar-servidor.workers.dev/v1/stats
```

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
| `wrangler.toml` | Nombre, cuenta, base de datos y el reloj de la limpieza diaria. |
| `src/cuentas.js` | Cuentas: entrar con Google, sesiones y progreso guardado. |
| `src/compras.js` | Compras: verificar con Google Play y entregar una sola vez, solo a quien compró. |
| `src/limites.js` | Cuántas veces puede un mismo cliente hacer cada cosa. |
| `migracion-2026-11-22.sql` | Paso único de la base ya publicada al esquema actual. |
| `src/tiquetes.js` | Tiquete de partida de la copa: la marca solo entra si el tiempo cabe en el reloj real. |
| `src/tope.js` | Tope de monedas: nota un progreso retocado a mano y deja a esa instalación fuera de la copa. |
| `src/precios.js` | Precios de las piezas. Lo genera el juego (`juego-nave/juego/tools/precios.mjs`): no se edita a mano. |
| `src/privacidad.js` | Política de privacidad, pública: `/privacidad` (español) y `/privacy` (inglés). La piden Google Play y AdMob. Si cambia qué datos se usan, se cambia el texto y su fecha. |

## Seguridad: qué frena el abuso

Revisión de seguridad del 2026-11-22. Lo que quedó puesto:

- **Topes por cliente** (`src/limites.js`) en todo lo que escribe: marcas (30 cada 10 min), retos creados (10 por hora), marcas en retos (30 cada 10 min), medición (10 al día), inicios de sesión (30 cada 10 min), comprobantes de compra (40 cada 10 min) e intentos con la clave de administración (20 cada 10 min). Pasado el tope contesta 429 y **no escribe nada**. El cliente es la dirección de internet; una red IPv6 entera (/64) cuenta como uno solo.
  - Ojo: en redes de celular muchas personas salen por la misma dirección. Si con público real se ve que jugadores honestos reciben 429, se suben los números en `LIMITS`. El juego no pierde nada con un 429: guarda la marca en el teléfono y la reenvía después.
- **Limpieza diaria** (`cleanup` en `src/reglas.js`, la dispara el reloj de `wrangler.toml` a las 3:17 a. m. de Colombia): bota números de un solo uso y sesiones vencidos, contadores de ventanas pasadas, copas de hace más de 8 semanas, retos sin marcas nuevas en 30 días y medición de hace más de 180 días. El panel muestra a quienes llegaron en los últimos 150 días.
- **De un envío de la medición** se anotan como mucho los 60 días más recientes.
- **El total de una tabla y el puesto de un jugador** se recuerdan 30 segundos en la memoria del servidor, para no recorrer la tabla en cada consulta. Quien acaba de anotar una marca siempre ve sus números recién contados.
- **Tamaño de lo que llega:** se mide en bytes, se rechaza por el tamaño declarado antes de leer y se deja de leer en cuanto se pasa.
- **Clave de administración:** también por cabecera, comparada por huellas (sin pistas por el tiempo que tarda), y el panel no deja escapar su dirección a otros sitios.
- **Sacar a un tramposo de las tablas** (borra sus marcas y no le guarda más; `unban` lo perdona):

  ```
  curl -X POST -H "Authorization: Bearer LA-CLAVE" -d "{\"uid\":\"EL-IDENTIFICADOR\"}" https://giro-estelar.giro-estelar-servidor.workers.dev/v1/admin/ban
  ```

  El identificador de cada marca está en la tabla `scores` (`node cf.mjs d1 execute giro-estelar --remote --command "SELECT uid, nick, time FROM scores ORDER BY time DESC LIMIT 20"`).

### Contra las trampas (2026-11-22)

Tres piezas, las tres con pruebas en `test/trampas.test.mjs`:

- **Tiquete de partida** (`src/tiquetes.js`). Al empezar una Supervivencia el juego pide un tiquete (`POST /v1/run`); la marca solo entra a la copa si llega con él. El servidor comprueba que lo firmó él para ese jugador y que el tiempo cabe en el reloj real que pasó desde que lo dio (con 15 s de holgura). Cada tiquete sirve para una sola marca. No guarda nada por tiquete: es la hora más una firma hecha con `AUTH_SECRET`. Consecuencias:
  - anotar 20 minutos exige haber esperado 20 minutos, por cada marca;
  - una partida que **empieza** sin conexión no cuenta para la copa (el juego lo dice en la pantalla de fin); si la conexión se cae después, la marca se guarda con su tiquete y entra cuando vuelve;
  - sin `AUTH_SECRET` configurado no hay tiquetes y la copa no anota nada.
- **Lista de revisión** (en el panel, debajo del retorno; en datos: `GET /v1/admin/review`). Muestra la copa de la semana con señales: «muy por encima» (3 veces la mediana de la tabla), «llegó tarde» (la marca llegó más de una hora después de terminada la partida) y «justo en el máximo». Ninguna señal prueba nada sola: es para que una persona mire. Cada fila tiene el botón **Vetar**, y abajo están los vetados con su motivo y el botón **Levantar**.
- **Tope de monedas** (`src/tope.js`). De cada cuenta se lleva cuánto vale lo que tiene (monedas + precio de sus piezas). En cada guardado, lo que subió tiene que caber en lo comprado con plata más un cupo que se llena con el reloj (1 moneda por segundo, hasta 60.000; una cuenta nueva arranca con 40.000; el primer guardado puede valer hasta 300.000). También se revisa que «sin anuncios» corresponda a una compra. Si no cuadra: el progreso **se guarda igual**, pero esa instalación queda vetada de la copa con el motivo anotado (`monedas` o `sin anuncios`). Levantar el veto desde el panel da por bueno lo que tenga.
  - Los números salen de medir el juego: una partida bien jugada rinde 60 a 100 monedas por minuto y todo el catálogo cuesta unas 209.000. Si con público real cae gente honesta, se suben `RATE`, `ROOM` o `START`.
  - **La lista de precios hay que mantenerla al día:** cada vez que el juego agrega piezas o cambia precios, correr `node tools/precios.mjs` en `juego-nave/juego` y publicar el servidor. `npm test` del juego falla si está atrasada. Una pieza que el servidor no conoce cuenta como gratis: nunca perjudica al jugador.
  - **Ojo con la app de pruebas:** ahí las compras son simuladas y el servidor no las conoce. Si con la app de pruebas se "compra" sin anuncios o muchas monedas y se guarda en una cuenta contra el servidor publicado, esa instalación queda marcada. Se levanta desde el panel.

Lo que falta, para cuando la app esté en Google Play: el **sello de app original** (Play Integrity). Es lo que de verdad cierra el paso a un juego modificado o a un programa que lo imite; no se puede probar hasta que la app exista en Play Console.

### Capa opcional: los límites de la plataforma

Los topes de arriba viven en la base de datos: cada petición permitida cuesta una escritura. Cloudflare tiene un servicio de límites (Rate Limiting para Workers) que frena **antes** de tocar la base y no gasta cuota. El servidor ya lo usa si existe: `src/worker.js` busca una conexión llamada `RATE_LIMITER` y, si está, le pregunta primero (`limit({ key })`); si no está o falla, sigue con los topes propios.

**Quedó configurado en `wrangler.toml`** (bloque `[[ratelimits]]`, 40 peticiones por minuto por cliente y ruta), con el formato tomado de la documentación de Cloudflare el 2026-11-22; todavía no se ha publicado ni probado en Cloudflare. Es aproximado y cuenta por región, así que no reemplaza los topes de la base de datos: los protege. Si al publicar Cloudflare rechaza el bloque, se puede quitar y el servidor sigue funcionando. Una regla de límite en el cortafuegos (WAF) sería otra capa más, pero necesita un dominio propio.

## Límites conocidos y riesgos aceptados

- La semana y el día se cuentan con la hora de Colombia.
- **La tabla todavía se puede falsear, con paciencia.** Con el tiquete ya no se anota un tiempo de un tirón, pero quien modifique el juego puede pedir un tiquete, esperar ese rato y mandar un tiempo que no jugó (hasta el máximo de 2 horas). Para eso están la lista de revisión y el veto; lo cierra el sello de app original. Tampoco se reservan apodos: dos jugadores pueden llamarse igual. Los retos entre amigos no piden tiquete.
- **Las monedas y las piezas siguen viviendo en el teléfono.** El juego funciona sin conexión y el servidor no puede impedir que alguien con el teléfono modificado se las ponga. El tope de monedas lo nota cuando ese progreso se guarda en una cuenta, y solo cuando es de golpe: quien se regale poco a poco, dentro del cupo, pasa. A quién se veta lo dice el propio progreso (su identificador de instalación): un juego modificado puede mandar otro. Y quien no usa cuenta no pasa por aquí.
- La tabla es una sola para todos. Con muchos jugadores convendría partirla en grupos.
- No hay registro de eventos: un abuso se nota en el panel o en la cuota de Cloudflare, no en una alerta.

## Cuentas: guardar el progreso del jugador

Las reglas están en `src/cuentas.js` (léelo: arriba explica todo el recorrido). Resumen:

- Se entra solo con Google. El servidor no ve ni guarda contraseñas, correos ni nombres.
- De la persona guarda una huella con secreto de su número de cuenta de Google; de la sesión, la huella de la llave; y el progreso (el mismo archivo que el juego guarda en el teléfono).
- Guardar exige la versión que el juego conocía: si otro teléfono guardó después, contesta 409 con lo que hay, y el juego le pregunta al jugador con cuál se queda.
- `DELETE /v1/account` borra la cuenta, sus sesiones y su progreso. Además de la llave de sesión pide un comprobante de Google recién sacado, de esa misma cuenta (`{ idToken }`, con un número de un solo uso nuevo): con una llave robada no se puede borrar. Si falta o no corresponde, contesta 403 y no borra.
- `POST /v1/auth/logout-all` cierra la sesión en todos los teléfonos de la cuenta.
- Una sesión vence a los 6 meses sin usarse y, en todo caso, al año de abrirse: ahí se vuelve a entrar con Google.

**Mientras no estén configurados `AUTH_SECRET` y `GOOGLE_CLIENT_ID`, las cuentas contestan 503 y todo lo demás funciona igual.**

Para encenderlas (una sola vez):

1. En Google Cloud (con la cuenta de negocios): crear un proyecto, configurar la pantalla de consentimiento, y crear dos credenciales de OAuth:
   - una de tipo **Aplicación web** → su identificador de cliente es el `GOOGLE_CLIENT_ID`;
   - una de tipo **Android** con el paquete `com.giroestelar` y la huella SHA-1 de la firma de la app.
2. Crear las tablas nuevas: `node cf.mjs d1 execute giro-estelar --remote --file schema.sql`
3. El secreto del servidor (un texto largo al azar): `node cf.mjs secret put AUTH_SECRET`. Hay una copia de respaldo en `.dev.vars` (renglón `AUTH_SECRET=`), que no se sube al repositorio; conviene tener otra en un gestor de contraseñas, porque si se pierde no hay cómo recuperarlo.
4. El identificador de Google, en `wrangler.toml`:  `[vars]` · `GOOGLE_CLIENT_ID = "…apps.googleusercontent.com"`
5. `npm run publicar`
6. En el juego: el mismo identificador en `app/cuenta.properties` (`googleClientId=`), compilar e instalar.

Si el `AUTH_SECRET` se cambia, las cuentas existentes dejan de encontrarse (cada persona quedaría con una cuenta nueva y vacía): no se cambia.

Para probar en el computador no hace falta nada de eso: `node local.mjs` trae un "Google" de mentira (ver el comentario al comienzo de `local.mjs`).

## Compras: verificar con Google Play

Las reglas están en `src/compras.js` (arriba explica el recorrido). En resumen: el teléfono cobra con Google Play y recibe un comprobante; el juego se lo pasa a este servidor junto con el identificador anónimo de la instalación (`uid`); el servidor le pregunta a Google si está pagado, cierra la compra en Google y contesta qué entregar; el juego avisa cuando ya lo entregó. Las cantidades las pone el servidor.

- **Cada compra es de una sola instalación:** la primera que la presenta (y, si la app le dijo a Google quién compraba, tiene que ser esa). A cualquier otra se le contesta que no hay nada que dar.
- **"Sin anuncios para siempre"** se puede recuperar en otro teléfono de la misma persona, hasta en 5 instalaciones por compra.
- **La compra se cierra en Google antes de entregarla**, no cuando el juego avisa. Consecuencia para el juego: una compra de monedas ya cerrada deja de aparecer entre las compras abiertas del teléfono, así que el juego debe guardar el comprobante antes de presentarlo y volver a presentarlo al abrir si no alcanzó a entregarlo (el servidor le sigue contestando `grant`, solo a él, hasta que avise con `/v1/purchase/done`).
- Un comprobante que Google rechaza se recuerda unos minutos, para no volver a preguntarle por lo mismo.

**Mientras no exista el secreto `PLAY_SERVICE_ACCOUNT`, las compras contestan 503 y todo lo demás funciona igual.**

Para encenderlas:

1. En Google Cloud (el proyecto "Nave"): activar la API "Google Play Android Developer API"; crear una **cuenta de servicio** y descargar su llave en formato JSON.
2. En Play Console → "Usuarios y permisos": invitar el correo de esa cuenta de servicio con permiso para ver datos financieros y gestionar pedidos.
3. Crear las tablas (ver "Publicar lo que está pendiente", abajo: primero la migración, luego `schema.sql`).
4. Guardar la llave como secreto (el archivo JSON completo, sin subirlo a ningún repositorio):
   `node cf.mjs secret put PLAY_SERVICE_ACCOUNT < ruta\la-llave.json`
5. `npm run publicar`

Para probar en el computador no hace falta nada de eso: `node local.mjs` trae un "Google Play" de mentira (`/test/store`), y en el navegador se activa con `localStorage.giro_store = 'prueba'`.

## Publicar lo que está pendiente

**Publicado el 2026-11-23**: migración, tablas nuevas y código (compras, arreglos de seguridad, tiquete de partida, lista de revisión, tope de monedas y política de privacidad). Antes se sacó una copia de la base (`Documents\giro-estelar-llavesespaldo-base-2026-11-23.sql`, fuera del repositorio). Comprobado en vivo: `/privacidad` y `/privacy`, el tiquete de partida, el rechazo de marcas sin tiquete, el panel con su clave, el límite de la plataforma y el reloj de la limpieza. **La migración ya está aplicada: no se vuelve a correr.** Falta `PLAY_SERVICE_ACCOUNT` (sin él las compras no se pueden verificar).

Lo que sigue es el procedimiento, para la próxima vez que haya cambios:

En este orden:

```
npm test
# (la migración migracion-2026-11-22.sql ya se aplicó el 2026-11-23: no repetir)
node cf.mjs d1 execute giro-estelar --remote --file=schema.sql -y                  # tablas e índices nuevos (no toca lo que ya hay)
node cf.mjs deploy                                                                 # publica el código y el reloj de la limpieza diaria
```

- La migración no borra ni cambia datos de nadie. Si se ejecuta dos veces, la segunda falla con "duplicate column name" y no daña nada.
- Si se publica el código sin la migración, las cuentas fallan (el código espera la columna nueva): los dos pasos van juntos.
- El juego publicado antes de estos cambios no manda `uid` en las compras ni el comprobante al borrar la cuenta: hay que publicar la app nueva junto con el servidor. Lo demás (copa, retos, medición, entrar y guardar) sigue funcionando con la app vieja.
- La app vieja tampoco pide tiquete de partida: con el servidor nuevo sus marcas de la copa no entran. Otra razón para publicar las dos cosas juntas.
- Antes de publicar: `node tools/precios.mjs --check` en `juego-nave/juego` (la lista de precios al día).
- Después de publicar: en el panel de Cloudflare, mirar que el reloj ("Cron Triggers") aparezca en el Worker.
