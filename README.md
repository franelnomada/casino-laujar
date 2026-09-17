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

## Desplegar gratis en Render.com (paso a paso)

1. **Crea un repositorio en GitHub** (cuenta gratis) llamado, por ejemplo, `casino-laujar`.
2. **Sube este proyecto** (desde la carpeta del proyecto):
   ```bash
   git init
   git add .
   git commit -m "Casino Laujar v1"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/casino-laujar.git
   git push -u origin main
   ```
3. **En Render** (https://render.com, cuenta gratis):
   - "New" → "Web Service" → conecta tu GitHub y elige el repositorio.
   - **Runtime:** Node
   - **Build command:** `npm install` (o déjalo vacío, no hay dependencias)
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Pulsa "Create Web Service". En 1-2 minutos tendrás una URL tipo `https://casino-laujar.onrender.com`.

### Cosas que debes saber del plan gratuito de Render

- **El servidor se duerme** tras ~15 minutos sin visitas. La primera visita luego tarda ~1 minuto en "despertar". Para evitarlo, crea un ping automático gratis en https://cron-job.org que llame a `https://TU-APP.onrender.com/api/ping` cada 10 minutos.
- **Los balances y salas viven en memoria**: si Render reinicia el servicio (cada despliegue o reinicio), las salas y fichas online se reinician. Es aceptable para jugar entre colegas; si algún día queréis persistencia real, se añade una base de datos.

## Cómo se juega online

1. Uno crea la sala y pulsa **🔗 Copiar enlace de invitación**.
2. Lo pega en el grupo de WhatsApp/Telegram.
3. Los colegas abren el enlace, escriben su nombre y pulsan **Unirse** (el código va precargado).
4. Apuestas con fichas, "Listo ✔", y ¡a jugar!

## Estructura

```
index.html            → Welcome, lobby, blackjack, ruleta y sala online
css/style.css         → Estilos (mobile-first, tema casino)
js/app.js             → Fichas, navegación
js/blackjack.js       → Blackjack local (hot-seat, hasta 5 jugadores)
js/roulette.js        → Ruleta europea local
js/net.js             → Cliente multijugador (salas, long-polling)
js/bj-engine.js       → Motor de blackjack del servidor (autoritativo)
server.js             → Servidor HTTP + API de salas (sin dependencias)
assets/logo.png       → Logo del casino
test/                 → Tests (smoke, engine, e2e)
```

## Nota legal

Las fichas no tienen valor monetario ni se pueden comprar. Mantenedlo así: con dinero real haría falta una licencia de juego.
