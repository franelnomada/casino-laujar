// Reglas compartidas de división; los campos del jugador representan la mano activa.
const SplitHands = {
  canSplit(p) {
    return !!(p && !p.played && p.bet > 0 && p.chips >= p.bet &&
      p.hand.length === 2 && p.hand[0].rank === p.hand[1].rank &&
      (!p.splitHands || (p.splitHands.length < 4 && p.hand[0].rank !== 'A')));
  },
  save(p) {
    if (!p.splitHands) return;
    const h = p.splitHands[p.activeHand];
    for (const key of ['hand', 'bet', 'played', 'busted', 'doubled', 'result']) h[key] = p[key];
  },
  select(p, index) {
    p.activeHand = index;
    Object.assign(p, p.splitHands[index]);
  },
  divide(p, draw, value) {
    p.chips -= p.bet;
    const aces = p.hand[0].rank === 'A';
    const moved = p.hand.pop();
    p.hand.push(draw());
    const fresh = { hand: [moved, draw()], bet: p.bet,
      played: false, busted: false, doubled: false, result: '' };
    p.played = aces || value(p.hand) === 21;
    fresh.played = aces || value(fresh.hand) === 21;
    if (!p.splitHands) {
      p.splitHands = [{ hand: [], bet: p.bet, played: false, busted: false, doubled: false, result: '' }];
      p.activeHand = 0;
    }
    this.save(p);
    p.splitHands.splice(p.activeHand + 1, 0, fresh);
  },
  next(p) {
    if (!p.splitHands) return false;
    this.save(p);
    for (let i = p.activeHand + 1; i < p.splitHands.length; i++) {
      this.select(p, i);
      if (!p.played) return true;
    }
    return false;
  },
  settle(p, dealerValue, dealerBJ, value) {
    this.save(p);
    for (const h of p.splitHands) {
      const total = value(h.hand);
      let earnings = 0;
      if (h.busted || total > 21) h.result = '💥';
      else if (dealerBJ) h.result = '😢';
      else if (dealerValue > 21 || total > dealerValue) { earnings = h.bet * 2; h.result = '🏆'; }
      else if (total === dealerValue) { earnings = h.bet; h.result = '🤝'; }
      else h.result = '😢';
      h.played = true;
      p.chips += earnings;
    }
    p.played = true;
    p.result = p.splitHands.map((h, i) => `Mano ${i + 1}: ${h.result}`).join(' · ');
  },
  reset(p) { delete p.splitHands; delete p.activeHand; }
};
if (typeof module !== 'undefined' && module.exports) module.exports = SplitHands;
