// ==========================================
//  Blackjack — utilidades de render compartidas
//  (usadas por net.js y poker.js para pintar cartas
//  de las mesas multijugador; ya no hay modo local)
// ==========================================
const Blackjack = {
  handValue(hand) {
    let total = 0, aces = 0;
    for (const card of hand) {
      if (card.rank === 'A') { total += 11; aces++; }
      else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
      else total += parseInt(card.rank, 10);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  },

  // Muestra ambos totales cuando un As todavía puede valer 1 u 11.
  handLabel(hand) {
    if (!hand.length) return '';
    const best = this.handValue(hand);
    const low = hand.reduce((total, card) => total + (card.rank === 'A' ? 1 :
      (['J', 'Q', 'K'].includes(card.rank) ? 10 : parseInt(card.rank, 10))), 0);
    return low !== best && best < 21 ? `${low} / ${best}` : String(best);
  },

  withFly(html, delay) {
    return html.replace('class="playing-card',
      'class="playing-card fly-in" style="animation-delay:' + delay.toFixed(2) + 's"');
  },

  cardHTML(card, faceDown = false) {
    if (faceDown) return '<div class="playing-card face-down"><span class="suit">♠</span></div>';
    const red = card.suit === '♥' || card.suit === '♦';
    return `<div class="playing-card${red ? ' red' : ''}">
      <div>${card.rank}</div>
      <div class="suit">${card.suit}</div>
    </div>`;
  },

  // Pinta las manos divididas (split) de un jugador en la mesa online.
  splitHTML(p, active, counts, key) {
    const prefix = key + '-split-';
    const previous = counts[prefix + 'total'] || 0;
    if (previous && p.splitHands.length === previous + 1) {
      for (let i = previous - 1; i > p.activeHand; i--) {
        counts[prefix + (i + 1)] = counts[prefix + i];
      }
      counts[prefix + p.activeHand] = 1;
      counts[prefix + (p.activeHand + 1)] = 1;
    }
    counts[prefix + 'total'] = p.splitHands.length;
    let dealt = 0;
    return '<div class="split-hands">' + p.splitHands.map((h, i) => {
      const countKey = key + '-split-' + i;
      const before = counts[countKey] === undefined ? 1 : counts[countKey];
      const cards = h.hand.map((c, n) => {
        const html = this.cardHTML(c);
        return n >= before ? this.withFly(html, 0.15 + dealt++ * 0.7) : html;
      }).join('');
      counts[countKey] = h.hand.length;
      const playing = active && p.activeHand === i && !h.played;
      return `<div class="split-hand${playing ? ' hand-active' : ''}">` +
        `<div>Mano ${i + 1}${playing ? ' ◀ Turno' : ''}</div>` +
        `<div class="cards seat-cards">${cards}</div>` +
        `<div class="score">${this.handLabel(h.hand)}</div>` +
        `<div class="bet-circle">${h.bet}</div><div class="p-result">${h.result}</div></div>`;
    }).join('') + '</div>';
  }
};
