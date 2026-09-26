// ================================================
//  Ruleta europea: dibujo SVG, fisica de giro y arrastre
//  Sin dependencias. El numero ganador SIEMPRE lo decide
//  el servidor (roulette-engine.js): aqui solo se dibuja.
// ================================================
(function (global) {
  'use strict';

  // Orden real de la European wheel: el 0 abre la secuencia.
  const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const SLOTS = ORDER.length;                 // 37 (o 38 con doble cero)
  const STEP = 360 / SLOTS;

  // --- Geometria del dibujo (viewBox 0 0 400 400) ---
  const CX = 200, CY = 200;
  const R_FELT = 198;      // borde exterior de fieltro
  const R_METAL = 191;     // aro metalico exterior
  const R_SEC_OUT = 174;   // borde exterior de los sectores
  const R_SEC_IN = 112;    // borde interior de los sectores
  const R_NUM = 143;       // radio del centro de los numeros
  const R_CONE = 109;      // cono central
  const R_TRACK = 182;     // canalon por donde corre la bola
  const R_SETTLE = 143;    // radio donde la bola se asienta en el sector
  const R_BALL = 7.5;

  // --- Sintesis de la animacion ---
  const MIN_TURNS = 4;         // vueltas minimas para un giro creible
  const MAX_TURNS = 7;
  const BALL_RATIO = 1.55;     // la bola sale despedida al reves al arrastrar
  const DEFAULT_DUR = 5200;    // ms de un giro disparado por el boton

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const easeInOutQuad = (p) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  // Angulo 0 = las 12 en punto; los grados crecen en sentido horario.
  const pol = (r, deg) => [CX + r * Math.sin(deg * Math.PI / 180), CY - r * Math.cos(deg * Math.PI / 180)];

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  const Wheel = {
    host: null, svg: null, rotor: null, ballNode: null, label: null,
    rotation: 0,        // grados del rotor (acumulado, sin normalizar)
    ballAngle: 0,       // grados de la bola (capa independiente del rotor)
    ballRadius: R_SETTLE,
    spin: null,         // { dir, dur, x0, dR, m, target, number, bx0, bdR }
    raf: 0,
    mounted: false,
    drag: null,
    opts: {},
  };

  // ---- Defini: metal, fieltro, madera, dorado y grano ------------------
  function buildDefs(svg) {
    const defs = el('defs');
    const add = (markup) => {
      const wrap = el('g');
      wrap.innerHTML = markup;
      while (wrap.firstChild) defs.appendChild(wrap.firstChild);
    };
    add('<linearGradient id="rlw-metal" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#8d949c"/><stop offset=".16" stop-color="#e8edf2"/>'
      + '<stop offset=".38" stop-color="#aeb6bf"/><stop offset=".55" stop-color="#5c646d"/>'
      + '<stop offset=".78" stop-color="#d3dae1"/><stop offset="1" stop-color="#6b737c"/></linearGradient>');
    add('<radialGradient id="rlw-felt" cx=".38" cy=".3" r=".85">'
      + '<stop offset="0" stop-color="#1d6b45"/><stop offset=".6" stop-color="#0e452a"/>'
      + '<stop offset="1" stop-color="#062417"/></radialGradient>');
    add('<radialGradient id="rlw-wood" cx=".4" cy=".32" r=".8">'
      + '<stop offset="0" stop-color="#8a5a30"/><stop offset=".45" stop-color="#5d3a1c"/>'
      + '<stop offset="1" stop-color="#2b190a"/></radialGradient>');
    add('<linearGradient id="rlw-gold" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#f7e3a1"/><stop offset=".45" stop-color="#d4af37"/>'
      + '<stop offset="1" stop-color="#8a6a16"/></linearGradient>');
    add('<radialGradient id="rlw-dome" cx=".42" cy=".3" r=".78">'
      + '<stop offset="0" stop-color="#fff" stop-opacity=".30"/>'
      + '<stop offset=".45" stop-color="#fff" stop-opacity=".06"/>'
      + '<stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>');
    add('<radialGradient id="rlw-ball" cx=".35" cy=".3" r=".75">'
      + '<stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#e9edf1"/>'
      + '<stop offset=".8" stop-color="#9aa3ad"/><stop offset="1" stop-color="#5c646d"/></radialGradient>');
    // Grano del fieltro: filtro estatico, se rasteriza una sola vez.
    add('<filter id="rlw-grain" x="-8%" y="-8%" width="116%" height="116%">'
      + '<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" seed="7" result="n"/>'
      + '<feColorMatrix in="n" type="saturate" values="0" result="g"/>'
      + '<feComponentTransfer in="g"><feFuncA type="linear" slope=".22"/></feComponentTransfer>'
      + '<feComposite operator="in" in2="SourceGraphic"/></filter>');
    svg.appendChild(defs);
  }

  // ---- Marco fijo: fieltro exterior + aro metalico --------------------
  function buildFrame(svg) {
    const frame = el('g', { class: 'rlw-frame' });
    frame.appendChild(el('circle', { cx: CX, cy: CY, r: R_FELT, fill: 'url(#rlw-felt)' }));
    frame.appendChild(el('circle', { cx: CX, cy: CY, r: R_FELT, fill: '#fff', filter: 'url(#rlw-grain)', opacity: '.85' }));
    frame.appendChild(el('circle', { cx: CX, cy: CY, r: R_METAL, fill: 'url(#rlw-metal)' }));
    frame.appendChild(el('circle', { cx: CX, cy: CY, r: R_METAL, fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': '1.5' }));
    // Separadores radiales del canalon, como en las ruletas reales
    for (let i = 0; i < SLOTS; i++) {
      const [x, y] = pol(R_TRACK + 1, i * STEP);
      frame.appendChild(el('line', {
        x1: CX, y1: CY, x2: x.toFixed(2), y2: y.toFixed(2),
        stroke: 'rgba(0,0,0,.18)', 'stroke-width': '1',
      }));
    }
    svg.appendChild(frame);
  }

  // ---- Rotor: sectores, numeros, aro interior y cono central -----------
  function buildRotor(svg) {
    const rotor = el('g', { class: 'rlw-rotor' });
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: R_SEC_OUT + 2, fill: '#2a2f36' }));

    for (let i = 0; i < SLOTS; i++) {
      const n = ORDER[i];
      const a0 = i * STEP, a1 = a0 + STEP;
      const [x0, y0] = pol(R_SEC_OUT, a0);
      const [x1, y1] = pol(R_SEC_OUT, a1);
      const [x2, y2] = pol(R_SEC_IN, a1);
      const [x3, y3] = pol(R_SEC_IN, a0);
      const fill = n === 0 ? '#0f7a3d' : (RED.has(n) ? '#c22a24' : '#16181b');
      rotor.appendChild(el('path', {
        d: 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
           'A' + R_SEC_OUT + ' ' + R_SEC_OUT + ' 0 0 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
           'L' + x2.toFixed(2) + ' ' + y2.toFixed(2) +
           'A' + R_SEC_IN + ' ' + R_SEC_IN + ' 0 0 0 ' + x3.toFixed(2) + ' ' + y3.toFixed(2) + 'Z',
        fill: fill, stroke: 'rgba(255,255,255,.22)', 'stroke-width': '.8',
      }));

      // Numero orientado radialmente, como en una ruleta de casino
      const mid = a0 + STEP / 2;
      const holder = el('g', { transform: 'rotate(' + mid.toFixed(3) + ' ' + CX + ' ' + CY + ')' });
      const [tx, ty] = pol(R_NUM, 0);
      const text = el('text', {
        x: tx.toFixed(2), y: ty.toFixed(2), class: 'rlw-num',
        fill: '#f4f1ea', 'text-anchor': 'middle', 'dominant-baseline': 'central',
      });
      text.textContent = String(n);
      holder.appendChild(text);
      rotor.appendChild(holder);
    }

    // Aro interior metalico, cono de madera y cubo central
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: R_SEC_IN + 2, fill: 'url(#rlw-metal)' }));
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: R_CONE, fill: 'url(#rlw-wood)' }));
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: R_CONE, fill: 'url(#rlw-dome)' }));
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: 23, fill: 'url(#rlw-metal)' }));
    rotor.appendChild(el('circle', { cx: CX, cy: CY, r: 9, fill: '#2b190a', stroke: 'rgba(0,0,0,.5)', 'stroke-width': '1' }));
    svg.appendChild(rotor);
    return rotor;
  }

  // ---- Capa de la bola: independiente del rotor ------------------------
  function buildBall(svg) {
    const layer = el('g', { class: 'rlw-ball-layer' });
    const ball = el('circle', { cx: CX, cy: CY, r: R_BALL, fill: 'url(#rlw-ball)', class: 'rlw-ball' });
    layer.appendChild(ball);
    svg.appendChild(layer);

    // Indicador fijo a las 12 en punto: define el sector ganador
    const ptr = el('g', { class: 'rlw-pointer' });
    const [px, py] = pol(R_SEC_OUT + 9, 0);
    ptr.appendChild(el('polygon', {
      points: [px.toFixed(2) + ',' + (py - 4).toFixed(2) + ' ' +
        (px - 9).toFixed(2) + ',' + (py + 12).toFixed(2) + ' ' +
        (px + 9).toFixed(2) + ',' + (py + 12).toFixed(2)],
      fill: 'url(#rlw-gold)', stroke: 'rgba(0,0,0,.45)', 'stroke-width': '1',
    }));
    svg.appendChild(ptr);

    // Numero que quedo bajo el indicador, grabado en el cono de madera
    const label = el('text', { x: CX, y: (CY + 66), class: 'rlw-label', 'text-anchor': 'middle' });
    label.textContent = '';
    svg.appendChild(label);
    return { layer, ball, label };
  }


  // ---- Cinematica --------------------------------------------------------
  function norm(deg) { return ((deg % 360) + 360) % 360; }

  // Numero del sector que queda bajo el indicador con esa rotacion.
  function numberAt(rotation) {
    const mid = norm(-rotation);
    const i = Math.round(mid / STEP - 0.5);
    return ORDER[((i % SLOTS) + SLOTS) % SLOTS];
  }

  // Curva de Hermite normalizada: g(0)=0, g(1)=1, g'(1)=0 (frena sin corte)
  // y g'(0)=m, donde m es la velocidad normalizada de entrada. Permite
  // recalcular el destino a mitad de giro sin dar un tirón visible.
  function hermite(q, m) {
    if (q <= 0) return 0;
    if (q >= 1) return 1;
    return (2 * q * q * q - 3 * q * q + 1) + q * (q - 1) * (q - 1) * m;
  }
  // Derivada de hermite respecto a q (para reconstruir la velocidad real).
  function hermiteD(q, m) {
    if (q <= 0) return m;
    if (q >= 1) return 0;
    return (6 * q * q - 6 * q) + ((q - 1) * (q - 1) * (3 * q - 2)) * m;
  }

  // Giro que la rueda debe terminar para dejar el sector n bajo el indicador.
  function rotationFor(n) {
    const i = ORDER.indexOf(n);
    if (i < 0) return Wheel.rotation;
    const mid = i * STEP + STEP / 2;   // angulo del centro del sector dentro del rotor
    let r = -(mid % 360);
    if (r < 0) r += 360;
    return r;
  }

  // Recorrido angular de la bola para acabar bajo el indicador (angulo 0),
  // yendo en sentido contrario a la rueda. Siempre es un multiplo de 360
  // grados, asi que el punto de llegada es EXACTO.
  function ballSpan(angle, dir, turns) {
    const want = -dir * turns * 360;              // recorrido ideal
    const k = Math.round((angle - want) / 360);   // ajuste al multiplo exacto
    return -360 * k;
  }

  // ---- Bucle de animacion ------------------------------------------------
  function frame(now) {
    Wheel.raf = requestAnimationFrame(frame);
    if (!Wheel.spin) return;
    const s = Wheel.spin;
    // Progreso por reloj de pared, no sumando dt: asi el giro dura lo mismo
    // a 30 fps que a 144 fps y no se ralentiza si el navegador pierde frames.
    s.elapsed = now - s.t0;
    const q = clamp(s.elapsed / s.dur, 0, 1);

    // Rueda
    Wheel.rotation = s.x0 + s.dR * hermite(q, s.m);
    // Bola: opuesta a la rueda, mas rapida, cayendo en espiral al centro
    Wheel.ballAngle = s.bx0 + s.bdR * hermite(q, s.bm);
    const fall = easeInOutQuad(clamp((q - 0.35) / 0.65, 0, 1));
    const wobble = (1 - fall) * Math.sin(now / 22) * 0.7;
    Wheel.ballRadius = R_TRACK - (R_TRACK - R_SETTLE) * fall + wobble;

    draw();
    if (q >= 1) {
      Wheel.rotation = s.target;
      Wheel.ballAngle = 0;
      Wheel.ballRadius = R_SETTLE;
      Wheel.spin = null;
      draw();
      highlight(s.number);
      if (Wheel.opts.onSettle) Wheel.opts.onSettle(s.number);
    }
  }

  // Arranca un giro, o recalcula el destino si ya habia uno en marcha.
  // targetRot: rotacion final deseada (no un numero).
  function startSpin(targetRot, dur, number) {
    const s = Wheel.spin;
    const now = performance.now();
    if (s) {
      // Continuidad: se conservan posicion y velocidad; solo cambia el destino.
      const q = clamp(s.elapsed / s.dur, 0, 1);
      const x = s.x0 + s.dR * hermite(q, s.m);
      const v = s.dR * hermiteD(q, s.m) / s.dur;          // deg/ms
      const dR = targetRot - x;
      s.x0 = x; s.dR = dR; s.dur = dur; s.t0 = now; s.elapsed = 0;
      s.m = dR === 0 ? 0 : clamp(v * dur / dR, 0, 3.2);
      // La bola vuelve a encajar con el indicador (angulo 0), en multiplo de vueltas.
      const bdR = ballSpan(Wheel.ballAngle, s.dir, 3 + Math.random() * 4);
      s.bx0 = Wheel.ballAngle; s.bdR = bdR; s.bm = 0;
      s.target = targetRot;
      if (number != null) s.number = number;
      return;
    }

    const dir = Wheel.ballAngle > 0 ? -1 : 1;   // la bola marca el sentido
    const from = Wheel.rotation;
    const turns = MIN_TURNS + Math.random() * (MAX_TURNS - MIN_TURNS);
    const span = dir * turns * 360;
    const finalRot = targetRot != null ? targetRot : norm(from + span);
    const spin = {
      x0: from, dR: finalRot - from, dur: dur || DEFAULT_DUR, t0: now, elapsed: 0, dir: dir,
      m: 0, target: finalRot, number: number != null ? number : numberAt(finalRot),
      bx0: Wheel.ballAngle, bdR: ballSpan(Wheel.ballAngle, dir, 3 + Math.random() * 4), bm: 0,
    };
    Wheel.spin = spin;
    if (!Wheel.raf) Wheel.raf = requestAnimationFrame(frame);
  }

  // ---- Pintado frame a frame (transform, sin repintar el SVG) ---------
  function draw() {
    if (Wheel.rotor) {
      Wheel.rotor.setAttribute('transform',
        'rotate(' + Wheel.rotation.toFixed(3) + ' ' + CX + ' ' + CY + ')');
    }
    if (Wheel.ballNode) {
      const [bx, by] = pol(Wheel.ballRadius, Wheel.ballAngle);
      Wheel.ballNode.setAttribute('cx', bx.toFixed(2));
      Wheel.ballNode.setAttribute('cy', by.toFixed(2));
    }
  }

  // Resalta en la mesa de apuestas el sector que ha salido.
  function highlight(n) {
    if (n == null) return;
    const cells = document.querySelectorAll('#net-roulette-table .rl-cell');
    for (const cell of cells) {
      const isWinner = cell.getAttribute('data-bet') === 'n' + n;
      cell.classList.toggle('win-highlight', isWinner);
    }
    if (Wheel.label) {
      Wheel.label.textContent = String(n);
      Wheel.label.setAttribute('fill', n === 0 ? '#7ef0a6' : (RED.has(n) ? '#ff8b82' : '#f0e6c8'));
    }
  }

  // ---- Arrastre con inercia (raton y dedo via Pointer Events) ----------
  function angleAt(ev) {
    const box = Wheel.svg.getBoundingClientRect();
    const scale = 400 / box.width;
    const x = (ev.clientX - box.left) * scale - CX;
    const y = (ev.clientY - box.top) * scale - CY;
    // Mismo criterio de angulo que pol(): 0 arriba, sentido horario.
    return Math.atan2(x, -y) * 180 / Math.PI;
  }

  function onDown(ev) {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    if (Wheel.spin) {                       // el jugador toma el control
      Wheel.spin = null;
    }
    Wheel.drag = { a: angleAt(ev), samples: [{ a: angleAt(ev), t: performance.now() }] };
    Wheel.svg.classList.add('is-dragging');
    try { Wheel.svg.setPointerCapture(ev.pointerId); } catch (e) { /* no critico */ }
  }

  function onMove(ev) {
    const d = Wheel.drag;
    if (!d) return;
    ev.preventDefault();
    const a = angleAt(ev);
    let delta = a - d.a;
    if (delta > 180) delta -= 360;          // cruce del angulo 0
    if (delta < -180) delta += 360;
    d.a = a;
    d.samples.push({ a: a, t: performance.now() });
    while (d.samples.length > 2 && performance.now() - d.samples[0].t > 110) d.samples.shift();

    // La rueda sigue al dedo; la bola sale despedida en sentido contrario.
    Wheel.rotation += delta;
    Wheel.ballAngle -= delta * BALL_RATIO;
    Wheel.ballRadius = R_TRACK;
    Wheel.ballAngle = norm(Wheel.ballAngle);
    draw();
  }

  function onUp(ev) {
    const d = Wheel.drag;
    if (!d) return;
    Wheel.drag = null;
    Wheel.svg.classList.remove('is-dragging');
    try { Wheel.svg.releasePointerCapture(ev.pointerId); } catch (e) { /* no critico */ }
    if (d.samples.length < 2) return;

    // Velocidad angular del gesto (deg/ms) sobre la ultima fracción de segundo.
    const first = d.samples[0], last = d.samples[d.samples.length - 1];
    const dt = last.t - first.t;
    let v = dt > 8 ? (last.a - first.a) / dt : 0;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    if (Math.abs(v) < 0.12) return;         // gesto lento: no es un flick

    // La fuerza del flick decide la duracion del giro (mas rapido = mas corto).
    const speed = Math.abs(v);             // deg/ms
    const dur = clamp(4200 / (speed * 55), 1500, 5200);
    startSpin(null, dur, null);
    if (Wheel.opts.onFlick) Wheel.opts.onFlick(v);
  }

  function bindPointer() {
    const svg = Wheel.svg;
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('dragstart', (e) => e.preventDefault());
  }

  // ---- API publica -------------------------------------------------------
  Wheel.mount = function (host, opts) {
    if (!host || Wheel.mounted) return Wheel;
    Wheel.host = host;
    Wheel.opts = opts || {};
    const svg = el('svg', { viewBox: '0 0 400 400', class: 'roulette-svg', role: 'img' });
    svg.setAttribute('aria-label', 'Ruleta europea de 37 sectores');
    buildDefs(svg);
    buildFrame(svg);
    Wheel.rotor = buildRotor(svg);
    const parts = buildBall(svg);
    Wheel.ballNode = parts.ball;
    Wheel.label = parts.label;
    Wheel.svg = svg;
    host.appendChild(svg);
    bindPointer();
    Wheel.mounted = true;
    Wheel.raf = requestAnimationFrame(frame);
    return Wheel;
  };

  // Alinea sin animacion (al entrar en la mesa o al recibir un estado).
  Wheel.setNumber = function (n) {
    if (n == null) return;
    const prev = Wheel.spin;
    if (!prev) {
      Wheel.rotation = rotationFor(n);
      Wheel.ballAngle = 0;
      Wheel.ballRadius = R_SETTLE;
      draw();
    }
    highlight(n);
  };

  // Gira hasta n. Si ya hay un giro en marcha, ancla el final a n sin cortes.
  Wheel.spinTo = function (n, dur) {
    if (n == null) return;
    if (Wheel.spin) startSpin(rotationFor(n), dur || 2400, n);
    else startSpin(rotationFor(n), dur || DEFAULT_DUR, n);
  };

  Wheel.isSpinning = function () { return !!Wheel.spin; };
  Wheel.currentNumber = function () { return numberAt(Wheel.rotation); };
  Wheel.ORDER = ORDER;

  global.RouletteWheel = Wheel;
}) (typeof window !== 'undefined' ? window : globalThis);
