# 🎰 Casino Laujar

Casino multijugador online de los ludópatas de Laujar de Andarax. Blackjack (local y online por salas) y Ruleta Europea, con fichas virtuales — nunca dinero real.

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
- **Sesión:** token de 30 días guardado en el dispositivo. Si el servidor se reinicia o el token caduca, la app vuelve sola a modo invitado sin perder las fichas locales.
- **Seguridad:** las contraseñas se guardan con hash `scrypt` y sal propia (nunca en claro) y hay bloqueo temporal de 1 minuto tras 5 intentos fallidos. Es protección básica de andar por casa: no reutilicéis una contraseña importante.
- **Dónde se guardan:** fichero JSON en el temporal del servidor (`/tmp/casino-laujar-users.json`), como las salas. Para moverlo, las variables de entorno `USERS_FILE` (ruta completa) o `DATA_DIR` (carpeta) lo cambian; con `DATA_DIR` apuntando a un disco persistente, las cuentas sobreviven a los redespliegues.
- **Réplica en Firebase (recomendado en Render):** como el disco de Render es efímero y cada redespliegue borra las cuentas, el servidor puede replicarlas en una **Realtime Database** gratuita de Firebase por REST (sin dependencias nuevas). Basta definir en Render:
  - `FIREBASE_DB_URL` = URL de la base (ej. `https://mi-proyecto-default-rtdb.europe-west1.firebasedatabase.app`)
  - y `FIREBASE_DB_SECRET` (Database secret, lo simple) o `FIREBASE_SERVICE_ACCOUNT` (el JSON completo de una cuenta de servicio con rol de base de datos, lo seguro).
  - Opcional: `FIREBASE_DB_PATH` cambia la ruta del documento de cuentas (por defecto `casino-laujar/users`).
  - Opcional: `FIREBASE_ROOMS_PATH` cambia la ruta del documento de salas (por defecto `casino-laujar/rooms`).

  Con esto, cada cambio de cuentas/sesiones se guarda en el JSON local **y** se replica a Firebase (con 1 s de retardo); al arrancar, el servidor fusiona lo remoto con lo local sin pisar nunca lo más nuevo (`updatedAt`), así que las cuentas sobreviven a los despliegues. Si Firebase falla o no está configurado, todo sigue funcionando con el fichero local.
  **Las salas también se replican** con la misma configuración (documento `casino-laujar/rooms`, fusión por `lastActivity`; cada sala viaja como JSON serializado para que la base conserve arrays vacíos y valores `null`): tras un redespliegue, las salas se recuperan y los jugadores pueden reconectar con el enlace de invitación y la sesión de siempre. El estado real se consulta en `GET /api/ping` (`storage.*` para cuentas, `roomsStorage.*` para salas).
- **API:** `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/chips` (token en `Authorization: Bearer …`), `GET /api/auth/leaderboard?limit=10` (público, solo nombre y fichas, tope 25), `GET /api/transactions` (público, últimas transacciones de fichas de más reciente a más antigua, tope 200).
- **Ranking:** en el lobby, la sección **🏆 Los más ricos del casino** lista las cuentas con más fichas (con tu fila resaltada si has entrado). Botón **🔄 Actualizar** para recargarla; se recarga sola al entrar, crear cuenta o guardar fichas.

## Desplegar gratis en Render.com (paso a paso)

1. **Crea un repositorio en GitHub** (cuenta gratis) llamado, por ejemplo, `casino-laujar`.
2. **Sube este proyecto** (desde la carpeta del proyecto):
   ```bash
   git init
   git add .
   git commit -m "Casino Laujar v1"
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


## Estructura

```
index.html            → Welcome, lobby, blackjack, ruleta y sala online
css/style.css         → Estilos (mobile-first, tema casino)
js/app.js             → Fichas, navegación
js/auth.js            → Cuentas: registro, sesión y fichas por jugador
js/blackjack.js       → Blackjack local (hot-seat, hasta 5 jugadores)
js/roulette.js        → Ruleta europea local
js/net.js             → Cliente multijugador (salas, long-polling)
js/bj-engine.js       → Motor de blackjack del servidor (autoritativo)
js/users.js           → Cuentas del servidor (scrypt, sesiones, JSON)
js/transactions.js    → Registro de transacciones de fichas (consola del lobby)
js/tx-console.js      → Consola pública de transacciones en el lobby (cliente)
js/firebase-rest.js   → Cliente REST de Firebase (compartido: cuentas y salas)
js/rooms-remote.js    → Réplica de salas (disco local + Firebase)
server.js             → Servidor HTTP + API de salas y cuentas (sin dependencias)
assets/logo.png       → Logo del casino
test/                 → Tests (smoke, engine, cuentas, e2e)
```

## Nota legal

Las fichas no tienen valor monetario ni se pueden comprar. Mantenedlo así: con dinero real haría falta una licencia de juego.
