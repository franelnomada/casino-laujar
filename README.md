# 🎰 L&F Casino Club

L&F Casino Club es un casino multijugador online con fichas virtuales — nunca dinero real. Incluye Blackjack (local y online por salas), Ruleta Europea, póker y apuestas deportivas.

## Probar en local

Necesitas [Node.js](https://nodejs.org) (v18 o superior). Sin dependencias externas:

```bash
node server.js
```

- PC: http://localhost:8080
- Móvil (misma WiFi): http://TU-IP:8080

## Tests

```bash
npm test
```

## Cuentas de jugador (opcional)

Sin cuenta también se juega: en el welcome hay una tarjeta **Entrar / Crear cuenta**, y quien no la use juega como **invitado** con las fichas guardadas en su propio móvil.

- **Crear cuenta:** nombre (2–14 caracteres, letras/números/espacios) y contraseña (mínimo 6). La cuenta arranca con las fichas que tengas en ese móvil (1.000 por defecto).
- **Entrar:** desde cualquier dispositivo, con el mismo nombre y contraseña; se recuperan las fichas virtuales de la cuenta.
- **Fichas:** al estar dentro de una cuenta, cada cambio de saldo se guarda en el servidor (con un pequeño retardo, sin saturar). Al cerrar sesión se conserva el saldo del móvil, pero siguen mandando las fichas de la cuenta mientras dure la sesión. Si se juega con la misma cuenta en dos dispositivos a la vez, el último saldo guardado es el que queda.
- **Regalo semanal:** todos los lunes, miércoles y viernes a las **10:00 (Europe/Madrid)** se entregan automáticamente **1.000 fichas** a cada cuenta activa, esté conectada o no. Cada entrega queda marcada por fecha, por lo que reinicios o despliegues no la duplican; las cuentas baneadas no participan.
- **Sesión:** token de 30 días guardado en el dispositivo. Si el servidor se reinicia o el token caduca, la app vuelve sola a modo invitado sin perder las fichas locales.
- **Seguridad:** las contraseñas se guardan con hash `scrypt` y sal propia (nunca en claro) y hay bloqueo temporal de 1 minuto tras 5 intentos fallidos. Es protección básica de andar por casa: no reutilicéis una contraseña importante.
- **Dónde se guardan:** fichero JSON en el temporal del servidor (`/tmp/casino-laujar-users.json`), como las salas. Para moverlo, las variables de entorno `USERS_FILE` (ruta completa) o `DATA_DIR` (carpeta) lo cambian; con `DATA_DIR` apuntando a un disco persistente, las cuentas sobreviven a los redespliegues.
- **Réplica en Firebase (recomendado en Render):** como el disco de Render es efímero y cada redespliegue borra las cuentas, el servidor puede replicarlas en una **Realtime Database** gratuita de Firebase por REST (sin dependencias nuevas). Basta definir en Render:
  - `FIREBASE_DB_URL` = URL de la base (ej. `https://mi-proyecto-default-rtdb.europe-west1.firebasedatabase.app`)
  - y `FIREBASE_DB_SECRET` (Database secret, lo simple) o `FIREBASE_SERVICE_ACCOUNT` (el JSON completo de una cuenta de servicio con rol de base de datos, lo seguro).
  - Opcional: `FIREBASE_DB_PATH` cambia la ruta del documento de cuentas (por defecto `casino-laujar/users`).
  - Opcional: `FIREBASE_ROOMS_PATH` cambia la ruta del documento de salas (por defecto `casino-laujar/rooms`).
  - Opcional: `FIREBASE_JACKPOT_PATH` cambia la ruta del jackpot compartido (por defecto `casino-laujar/jackpot`).

  Con esto, cada cambio de cuentas/sesiones se guarda en el JSON local **y** se replica a Firebase (con 1 s de retardo); al arrancar, el servidor fusiona lo remoto con lo local sin pisar nunca lo más nuevo (`updatedAt`), así que las cuentas sobreviven a los despliegues. Si Firebase falla o no está configurado, todo sigue funcionando con el fichero local.
  **El jackpot de Book of Fran también se persiste** con el mismo mecanismo. `JACKPOT_SEED` configura su valor inicial (100 por defecto) y `JACKPOT_FILE` la ruta local completa; con `DATA_DIR` se mueve junto a cuentas y salas.
  **Las salas también se replican** con la misma configuración (documento `casino-laujar/rooms`, fusión por `lastActivity`; cada sala viaja como JSON serializado para que la base conserve arrays vacíos y valores `null`): tras un redespliegue, las salas se recuperan y los jugadores pueden reconectar con el enlace de invitación y la sesión de siempre. El estado real se consulta en `GET /api/ping` (`storage.*` para cuentas, `roomsStorage.*` para salas).
- **API:** `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/chips` (token en `Authorization: Bearer …`), `GET /api/auth/leaderboard?limit=10` (público, solo nombre y fichas, tope 25), `GET /api/transactions` (público, últimas transacciones de fichas de más reciente a más antigua, tope 200), `POST /api/slots/jackpot/pick` (token de cuenta y `box` 1–3; solo funciona con un pick pendiente real).
- **Ranking:** en el lobby, la sección **🏆 Los más ricos del casino** lista las cuentas con más fichas (con tu fila resaltada si has entrado). Botón **🔄 Actualizar** para recargarla; se recarga sola al entrar, crear cuenta o guardar fichas.

## Desplegar gratis en Render.com (paso a paso)

1. **Crea un repositorio en GitHub** (cuenta gratis) llamado, por ejemplo, `casino-laujar`.
2. **Sube este proyecto** (desde la carpeta del proyecto):
   ```bash
   git init
   git add .
   git commit -m "L&F Casino Club v1"
   git branch -M main
   git remote add origin https://github.com/franelnomada/casino-laujar.git
   git push -u origin main
   ```
3. **En Render** (https://render.com, cuenta gratis):
   - "New" → "Web Service" → conecta tu GitHub y elige el repositorio.
   - **Runtime:** Node
   - **Build command:** `npm install` (o déjalo vacío, no hay dependencias)
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Pulsa "Create Web Service". En 1-2 minutos tendrás una URL tipo `https://casino-laujar.onrender.com`.

> 🎰 **Despliegue activo:** https://casino-laujar.onrender.com

### Cosas que debes saber del plan gratuito de Render

- **El servidor se duerme** tras ~15 minutos sin visitas. La primera visita luego tarda ~1 minuto en "despertar". Para evitarlo, crea un ping automático gratis en https://cron-job.org que llame a `https://TU-APP.onrender.com/api/ping` cada 10 minutos.
- **Las salas y los balances online viven en memoria**, con copia en disco (`/tmp`) y réplica opcional en Firebase. Si está configurada (ver sección de cuentas), salas y cuentas sobreviven a los reinicios y redespliegues; si no, un redespliegue las reinicia. Es aceptable para jugar entre colegas. Las **cuentas** se guardan en un JSON en el disco temporal (`/tmp`) o en la ruta de `DATA_DIR`.

## Cómo se juega online

1. Uno crea la sala y pulsa **🔗 Copiar enlace de invitación**.
2. Lo pega en el grupo de WhatsApp/Telegram.
3. Los colegas abren el enlace, escriben su nombre y pulsan **Unirse** (el código va precargado).
4. Apuestas con fichas, "Listo ✔", y ¡a jugar!

## ⚠️ Si os "echa" de la sala a mitad de partida

**Causa típica:** Render ha reiniciado el servidor. Las salas viven en la memoria/proceso y un **redespliegue o reinicio** las borra. El cliente ahora reintenta varias veces y, si la sala se ha perdido de verdad, muestra un aviso con "🔄 Reintentar" y "🏠 Volver al lobby" en vez de expulsar en silencio.

**Consejos:**
- **Desactiva el auto-deploy mientras jugáis** (Render → tu servicio → Settings → Build & Deploy → Auto-Deploy: "Off"). Despliega manualmente con "Manual Deploy" cuando nadie esté en partida.
- El servidor guarda las salas en disco (`/tmp` y, si está configurada, Firebase) y las recupera si el **proceso se reinicia en la misma instancia** (cuelgues, OOM…). Con la réplica de Firebase activa, las salas también sobreviven a un **redespliegue** (instancia nueva con disco efímero); sin ella, sí se pierden.
- Los jugadores pueden pulsar **↩ Volver** en el lobby para reconectar si la sala sigue viva.

## Póker Texas Hold’em online

- Pulsa **Crear mesa**, elige **Póker Texas Hold’em**, selecciona el intervalo de ciegas y pulsa **Abrir mesa**. Invita con el mismo enlace/código que en blackjack.
- 2–6 jugadores, cada uno entra con sus fichas disponibles (1.000 por defecto si no hay saldo previo). El anfitrión abre la primera mano; al terminar cada mano, el servidor muestra el resultado y reparte automáticamente la siguiente tras una pausa de 5 segundos.
- Botón D y ciegas SB/BB rotan en sentido horario. En heads-up el botón pone SB y habla primero preflop; BB habla primero después del flop.
- Ciegas iniciales 10/20: se duplican cada 5, 10, 15 o 20 minutos (configurable). Se aplican al comenzar la siguiente mano; máximo nivel 11 (10.240/20.480).
- Retirarse, pasar/igualar, apostar/subir hasta un total y all-in; botes laterales, empates y devolución del exceso no igualado.
- Las cartas rivales permanecen privadas hasta showdown; las de jugadores retirados no se revelan. Al mostrar, el ganador se resalta y aparece en el centro su categoría junto con las cinco cartas exactas de la combinación ganadora.
- Reparto secuencial desde el mazo, 850 ms por carta privada y 1 s por comunitaria; controles bloqueados durante el reparto. Movimiento reducido respetado sin acortar los turnos.
- Cada turno dura 45 s: al agotarse pasa si no debe fichas o se retira. Recargar permite reconectar con la sesión del dispositivo.
- Se puede entrar entre manos. Al terminar sin dos jugadores con fichas, cread otra mesa.
- Motor: `js/poker-engine.js`; presentación: `js/poker.js`. `npm test` incluye una mano heads-up determinista, simulaciones y pruebas HTTP. No requiere dependencias nuevas.


## ⚽ Apuestas deportivas

- `franelnomada` crea eventos con mercados 1X2, diferencia de goles, resultado exacto o personalizados, y escribe sus cuotas a mano.
- Los jugadores con sesión pueden apostar hasta su saldo real. Se permiten varias apuestas en un mismo mercado; cada una congela su cuota.
- El evento se bloquea manualmente al comenzar o automáticamente al alcanzar `startsAt`. El admin elige una opción ganadora por mercado, paga `stake × odds` y las apuestas perdedoras quedan perdidas.
- Cancelar un evento devuelve el stake íntegro. Todos los movimientos aparecen en la consola de transacciones y en **Mis apuestas**.
- Persistencia: `BETTING_FILE` o `DATA_DIR` para el JSON y `FIREBASE_BETTING_PATH` para la réplica opcional (por defecto `casino-laujar/betting`).


## 🔔 Avisos de mesa (sonido y vibración)

Póker y torneo avisan de lo importante, al estilo de PokerStars. Se activa en el **primer toque** que hagas en la página (los navegadores no dejan sonar nada hasta entonces).

| Aviso | Cuándo |
|---|---|
| **«Tu turno»** | Cuando te toca decidir: dos notas cortas que suben |
| Reparto | Empieza una mano nueva |
| Iguala | Cuando igualas la apuesta |
| Sube | Cuando subes: un tono que trepa |
| Todo-in | Todo el bote: tres notas intensas |
| Se retira | Tono que baja |
| Victoria / Derrota | Al cerrar el showdown: arpegio o descenso |

- Botón **🔊 / 🔇** junto a las fichas para silenciar. La preferencia se recuerda.
- El aviso **no se repite** en cada refresco: solo suena cuando te toca de verdad.

### Limitación importante: en iPhone no hay vibración

**Safari en iOS no implementa la API de vibración del navegador** (`navigator.vibrate` no existe). No es un fallo de la web ni algo que se pueda arreglar desde la web: la app comprueba si el dispositivo puede vibrar y, si no, **avisa solo con sonido**.

| | Sonido | Vibración |
|---|---|---|
| Android (Chrome) | Sí | **Sí** |
| iPhone / iPad | Sí | **No** (limitación de iOS) |

Los sonidos tampoco suenan con el móvil en **pantalla bloqueada**: harían falta notificaciones push (un service worker y un servidor que las envíe). Si algún día quieres eso, dímelo y lo planteamos.

## 🏆 Torneos de póker

Sección propia del lobby: el admin publica el torneo y acepta a quien lo solicite; el jugador pide plaza, espera la aprobación y juega cuando la mesa arranca.

**Lo que configura el admin** (todo editable desde el panel, antes de que haya jugadores sentados):

- **Cuota de inscripción** (fichas que se cobran al aceptar) y **fichas iniciales** del reparto.
- **Cuándo arranca**, a elegir:
  - **Al alcanzar el mínimo de jugadores** (el comportamiento de siempre).
  - **En una fecha y hora concretas**: el torneo arranca solo ese día a esa hora, **haya los jugadores que haya**. No hace falta llenar la mesa ni llegar al mínimo; si a esa hora solo hay uno sentado, la mesa se queda esperando y empieza a repartir en cuanto se siente un segundo jugador (el registro sigue abierto).
  - **Solo cuando el admin lo arranque** con el botón "Arrancar ahora".
- **Ciega pequeña** (la grande es el doble) y **ante** opcional.
- **Minutos por nivel** y **nº de niveles**: las ciegas y el ante se duplican al subir de nivel (ver "Qué son los niveles" abajo).
- **Aforo**: mesas × asientos. Puedes abrir **varias mesas** (hasta 20) de hasta 9 jugadores cada una. Por ejemplo, 3 mesas de 9 = 27 jugadores. Los jugadores se reparten llenando primero las mesas que ya existen; solo se abre una nueva cuando la anterior está llena. El **mínimo para arrancar** se compara con el aforo total, no con una sola mesa.
- **Equilibrar mesas cada N niveles**: reparten jugadores de unas mesas a otras para que ninguna quede vacía o con ventaja. Con 0 (por defecto) solo ocurre cuando una mesa se queda con un jugador suelto; con 2, en los niveles 2, 4, 6… Es el equivalente al "table balancing" de PokerStars. El cambio **siempre ocurre entre manos**, nunca en mitad de una, y el jugador ve un aviso: *"🔄 Te han cambiado a la mesa 2 para repartir mejor"*.
- **Descansos**: cada N niveles la mesa se para los minutos que se indiquen.
- **Registro tardío** hasta un nivel concreto, o registro cerrado desde el principio.
- **Premios** por puesto, en % del bote o en fichas fijas. Lo que sobre tras aplicar los % se reparte entre ellos; el bote no se queda fichas.
- **Visibilidad** pública o privada (solo el admin y los invitados).

### Ausentarse (sit out)

Los dos juegos de póker (mesa normal y torneo) tienen el botón **"Ausentarse"** en el panel lateral. Está copiado del comportamiento de PokerStars:

- El ausente **sigue pagando las ciegas que le toquen**, pequeña o grande. Las fichas se le van quitando así mano a mano.
- Cuando le llega el turno, **su mano se retira sola**: no tiene que decidir nada y no puede perder más por esa mano.
- En la mesa, los demás lo ven con la etiqueta **AUSENTE**.
- Con **"Volver a la mesa"** entra de nuevo en la siguiente mano.
- Si se ausenta **todo el mundo**, la mano se reparte igualmente y se vuelve a sentar a todos (si no, la ciega grande nunca se cobraría).
- No se puede ausentar sin fichas.

### La mesa es la misma en los dos juegos

Póker normal y torneo comparten literalmente el mismo marcado y las mismas clases CSS (`pk-table`, `pk-seat`, `pk-hole`, `pk-board`, `pk-showdown`…), así que **las cartas, los asientos, el tapete y el showdown se ven igual** en los dos. También comparten el panel lateral de mandos: tus cartas en grande, atajos Mín./50 %/Bote/Máx., slider de importe, botón de subir y el de ausentarse.

La única diferencia es el marco: el torneo añade arriba la barra con nombre, ciegas y estado del torneo, y el póker normal la franja de estado al pie.

### Qué son los niveles

Son la forma de que un torneo no se eternice. El reparto de fichas es siempre el mismo, pero **la apuesta mínima sube con el tiempo**, así que nadie puede quedarse escondido esperando con 2 fichas.

Con la configuración por defecto (ciega 100, 10 min por nivel):

| Nivel | Ciega pequeña | Ciega grande | Cuentas de «con qué pierdo» |
|---|---|---|---|
| 1 | 100 | 200 | Con 1 000 fichas (~10 manos) |
| 2 | 200 | 400 | Con 1 000 fichas (~5 manos) |
| 3 | 400 | 800 | Con 1 000 fichas (~2-3 manos) |
| 4 | 800 | 1 600 | Impossible: ya te habrás quedado out |

- **Minutos por nivel**: cuánto dura cada escalón antes de subir.
- **Nº de niveles**: cuántas veces se duplican. Es el tope: pasado ese punto las ciegas ya no suben más.
- Al subir se avisa en la barra de estado y en la etiqueta de la mesa, y con **Descanso cada N niveles** la partida se para unos minutos.

Es exactamente lo que pasa en los torneos reales, y es la razón por la que "quedarse con muchas fichas" no es una estrategia ganadora.

**Cómo funciona**


1. El jugador entra en **Torneos**, pulsa **Pedir plaza** y la solicitud queda *pendiente*.
2. El admin la ve en el panel y decide: **Aceptar** (cobra la cuota y lo sienta en la mesa con las fichas iniciales) o **Rechazar**.
3. La mesa arranca sola al alcanzar el mínimo de jugadores, o el admin puede pulsar **Arrancar ahora**.
4. Se reparten manos seguidas sin anfitrión. Cada jugador gestiona su turno con **Mín. / 50 % / Bote / Máx.**, slider, **Pasar** e **igualar**, y su turno dura 45 s (si no, pasa o se retira).
5. Si hay varias mesas, cada jugador ve **solo la suya** (el título muestra "Mesa 2 de 3"), pero **todas comparten las mismas ciegas, el mismo bote y la misma clasificación**. Los niveles suben a la vez en todas.
6. Quien se queda sin fichas queda eliminado y ve su puesto; el resto sigue jugando. El torneo acaba cuando solo queda uno.
7. Al terminar (o si el admin pulsa **Finalizar y pagar**) se reparten los premios entre las cuentas y quedan registrados en la consola de transacciones.

**Detalles**

- Los eliminados siguen viéndose en la mesa, apagados y con su posición.
- Durante un descanso la barra de estado avisa de cuánto falta.
- Si el servidor se reinicia a mitad de torneo, la mesa se recupera con las mismas fichas.
- Persistencia: `TOURNAMENTS_FILE` o `DATA_DIR` para el JSON y `FIREBASE_TOURNAMENTS_PATH` para la réplica opcional (por defecto `casino-laujar/tournaments`).


```
index.html            → Welcome, lobby, blackjack, ruleta y sala online
css/style.css         → Estilos (mobile-first, tema casino)
js/app.js             → Fichas, navegación
js/auth.js            → Cuentas: registro, sesión y fichas por jugador
js/blackjack.js       → Blackjack local (hot-seat, hasta 5 jugadores)
js/roulette.js        → Ruleta europea local
js/net.js             → Cliente multijugador (salas, long-polling)
js/bj-engine.js       → Motor de blackjack del servidor (autoritativo)
js/users.js           → Cuentas del servidor (scrypt, sesiones, fichas y markers)
js/weekly-bonus.js    → Reparto automático de fichas de lunes/miércoles/viernes
js/transactions.js    → Registro de transacciones de fichas (consola del lobby)
js/tx-console.js      → Consola pública de transacciones en el lobby (cliente)
js/betting.js         → Eventos, mercados, apuestas y liquidaciones (servidor)
js/betting-client.js  → Lobby, Mis apuestas y panel deportivo (cliente)
js/firebase-rest.js   → Cliente REST de Firebase (compartido: cuentas y salas)
js/rooms-remote.js    → Réplica de salas (disco local + Firebase)
js/tournament-engine.js → Mesa de torneo (Texas Hold'em con niveles y eliminaciones)
js/tournament-store.js  → Torneos: configuración, solicitudes, cuotas y premios (servidor)
js/tournaments.js     → Listado, solicitud de plaza, mesa y panel admin (cliente)
server.js             → Servidor HTTP + API de salas y cuentas (sin dependencias)
assets/logo.png       → Logo del casino
test/                 → Tests (smoke, engine, cuentas, e2e)
```

## Nota legal

Las fichas no tienen valor monetario ni se pueden comprar. Mantenedlo así: con dinero real haría falta una licencia de juego.
