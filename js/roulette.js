// ==============================
//  Ruleta Europea
// ==============================
const Roulette = {
  RED: new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]),
  chip: 25,
  bets: {},   // { betId: amount }
  spinning: false,

  setChip(amount) {
    this.chip = amount;
    document.querySelectorAll('.roulette-side .chip').forEach(c => c.style.outline = 'none');
    event.currentTarget.style.outline = '3px solid var(--gold-light)';
  },

  message(text) {
    document.getElementById('rl-message').textContent = text;
  },

  betIdLabel(id) {
    if (id.startsWith('n')) return 'Pleno ' + id.slice(1);
    const map = {
      red: 'Rojo', black: 'Negro', even: 'Par', odd: 'Impar',
      low: '1-18', high: '19-36',
      dozen1: '1ª Docena', dozen2: '2ª Docena', dozen3: '3ª Docena',
      col1: 'Columna 1', col2: 'Columna 2', col3: 'Columna 3'
    };
    return map[id] || id;
  },

  placeBet(id) {
    if (this.spinning) return;
    if (!App.takeChips(this.chip)) {
      this.message('¡No tienes suficientes fichas!');
      App.checkBankrupt();
      return;
    }
    this.bets[id] = (this.bets[id] || 0) + this.chip;
    this.renderBets();
    this.message('');
  },

  clearBets() {
    if (this.spinning) return;
    for (const amount of Object.values(this.bets)) App.giveChips(amount);
    this.bets = {};
    this.renderBets();
    this.message('');
  },

  totalBets() {
    return Object.values(this.bets).reduce((a, b) => a + b, 0);
  },

  renderBets() {
    document.querySelectorAll('#roulette-table .bet-stack').forEach(e => e.remove());
    document.getElementById('rl-total').textContent = this.totalBets();
    for (const [id, amount] of Object.entries(this.bets)) {
      const cell = document.querySelector(`[data-bet="${id}"]`);
      if (!cell) continue;
      const stack = document.createElement('div');
      stack.className = 'bet-stack';
      stack.textContent = amount;
      cell.appendChild(stack);
    }
  },

  spin() {
    if (this.spinning) return;
    if (this.totalBets() <= 0) { this.message('Coloca alguna apuesta en la mesa.'); return; }
    this.spinning = true;

    const n = Math.floor(Math.random() * 37); // 0-36
    // Animación decorativa de la ruleta
    const wheel = document.getElementById('roulette-wheel-wrap');
    const match = wheel.style.transform.match(/rotate\((-?[\d.]+)deg\)/);
    const currentDeg = match ? parseFloat(match[1]) : 0;
    wheel.style.transform = `rotate(${currentDeg + 1440 + Math.random() * 360}deg)`;

    this.message('La bola rueda… 🎡');
    setTimeout(() => this.resolve(n), 1800);
  },

  resolve(n) {
    const color = n === 0 ? 'verde' : (this.RED.has(n) ? 'rojo' : 'negro');
    const resultEl = document.getElementById('roulette-result');
    resultEl.textContent = n;
    resultEl.style.color = n === 0 ? '#2ecc71' : (this.RED.has(n) ? '#e74c3c' : '#ecf0f1');

    document.querySelectorAll('#roulette-table .rl-cell').forEach(c => c.classList.remove('win-highlight'));
    const winCell = document.querySelector(`[data-bet="n${n}"]`);
    if (winCell) winCell.classList.add('win-highlight');

    let totalReturn = 0;
    for (const [id, amount] of Object.entries(this.bets)) {
      totalReturn += this.payoutFor(id, n, amount);
    }

    this.bets = {};
    this.renderBets();
    if (totalReturn > 0) {
      App.giveChips(totalReturn);
      this.message(`🎯 Salió el ${n} (${color}). Recuperas ${totalReturn} fichas.`);
    } else {
      this.message(`🎯 Salió el ${n} (${color}). Sin suerte esta vez…`);
    }
    this.spinning = false;
    App.checkBankrupt();
  },

  // Devuelve lo que se devuelve al jugador (apuesta incluida) o 0
  payoutFor(id, n, amount) {
    const win = (mult) => amount + amount * mult; // mult = ganancia neta
    if (id.startsWith('n')) {
      return parseInt(id.slice(1), 10) === n ? win(35) : 0;
    }
    if (n === 0) return 0; // el 0 solo gana en el pleno
    switch (id) {
      case 'red':    return this.RED.has(n) ? win(1) : 0;
      case 'black':  return !this.RED.has(n) ? win(1) : 0;
      case 'even':   return n % 2 === 0 ? win(1) : 0;
      case 'odd':    return n % 2 === 1 ? win(1) : 0;
      case 'low':    return n <= 18 ? win(1) : 0;
      case 'high':   return n >= 19 ? win(1) : 0;
      case 'dozen1': return n <= 12 ? win(2) : 0;
      case 'dozen2': return (n >= 13 && n <= 24) ? win(2) : 0;
      case 'dozen3': return n >= 25 ? win(2) : 0;
      case 'col1':   return n % 3 === 1 ? win(2) : 0;
      case 'col2':   return n % 3 === 2 ? win(2) : 0;
      case 'col3':   return n % 3 === 0 ? win(2) : 0;
      default: return 0;
    }
  },

  buildTable() {
    const table = document.getElementById('roulette-table');
    let html = '<div class="rl-grid">';

    // Cero (a la izquierda, ocupa las 3 filas)
    html += '<div class="rl-cell zero-cell" data-bet="n0" onclick="Roulette.placeBet(\'n0\')">0</div>';

    // Números: 3 filas (fila superior: 3, 6, 9... 36)
    for (let row = 2; row >= 0; row--) {
      for (let col = 1; col <= 12; col++) {
        const n = col * 3 - row;
        const color = this.RED.has(n) ? 'red-cell' : 'black-cell';
        html += `<div class="rl-cell ${color}" data-bet="n${n}" onclick="Roulette.placeBet('n${n}')">${n}</div>`;
      }
    }
    html += '</div>';

    // Apuestas externas
    const outside = [
      ['dozen1', '1ª 12'], ['dozen2', '2ª 12'], ['dozen3', '3ª 12'],
      ['low', '1-18'], ['even', 'PAR'], ['red', 'ROJO'],
      ['black', 'NEGRO'], ['odd', 'IMPAR'], ['high', '19-36'],
      ['col1', 'COL 1'], ['col2', 'COL 2'], ['col3', 'COL 3']
    ];
    html += '<div class="rl-outside">';
    for (const [id, label] of outside) {
      const redStyle = id === 'red' ? ' style="background:var(--red)"' : '';
      const blackStyle = id === 'black' ? ' style="background:#1c1c1c"' : '';
      html += `<div class="rl-cell"${redStyle}${blackStyle} data-bet="${id}" onclick="Roulette.placeBet('${id}')">${label}</div>`;
    }
    html += '</div>';

    table.innerHTML = html;
  }
};
