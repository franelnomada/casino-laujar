// Texas Hold'em: lógica autoritativa, sin DOM ni temporizadores propios.
const { randomInt } = require('node:crypto');
const { ensureChat, chatFor } = require('./room-chat.js');
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function buildDeck() {
  const cards = ['♠','♥','♦','♣'].flatMap(suit => RANKS.map(rank => ({ rank, suit })));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0); if (d) return d;
  }
  return 0;
}
function five(cards) {
  const values = cards.map(c => RANKS.indexOf(c.rank) + 2).sort((a,b) => b-a);
  const groups = [...new Set(values)].map(v => [values.filter(x => x === v).length, v])
    .sort((a,b) => b[0]-a[0] || b[1]-a[1]);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const unique = [...new Set(values)];
  const straight = unique.length === 5 ? (unique[0]-unique[4] === 4 ? unique[0] : unique.join() === '14,5,4,3,2' ? 5 : 0) : 0;
  if (flush && straight) return [8, straight];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...values];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, ...groups.map(g => g[1])];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...groups.map(g => g[1])];
  if (groups[0][0] === 2) return [1, ...groups.map(g => g[1])];
  return [0, ...values];
}
function bestFive(cards) {
  let best = { score: [], cards: [] };
  for (let a=0;a<cards.length-4;a++) for(let b=a+1;b<cards.length-3;b++)
    for(let c=b+1;c<cards.length-2;c++) for(let d=c+1;d<cards.length-1;d++)
      for(let e=d+1;e<cards.length;e++) {
        const hand = [cards[a],cards[b],cards[c],cards[d],cards[e]];
        const score = five(hand);
        if (compare(score,best.score)>0) best = { score, cards: hand.map(card => ({ ...card })) };
      }
  return best;
}
function evaluate(cards) { return bestFive(cards).score; }
const LABELS = ['Carta alta','Pareja','Doble pareja','Trío','Escalera','Color','Full','Póker','Escalera de color'];
const fail = error => ({ ok: false, error });
class PokerRoom {
  constructor(code, options = {}) {
    this.code=code; this.game='poker'; this.version=1; this.players=[];
    this.phase='lobby'; this.turnId=null; this.dealerId=null; this.hostId=null;
    this.deck=[]; this.board=[]; this.handNo=0; this.pots=[]; this.events=[];
    this.eventNo=0; this.visualUntil=0; this.lastActivity=Date.now();
    this.message='Esperando al menos dos jugadores.';
    this.blindMinutes=[5,10,15,20].includes(options.blindMinutes) ? options.blindMinutes : 10;
    this.startedAt=null; this.level=0; this.smallBlind=10; this.bigBlind=20;
    this.currentBet=0; this.minRaise=20; this.pending=[]; this.turnDeadline=0; this.nextHandAt=0;
    this.chat=[]; this.chatLastSent=new Map();
  }
  touch() { this.version++; this.lastActivity=Date.now(); }
  find(id) { return this.players.find(p=>p.id===id); }
  order(after, predicate = () => true) {
    const i=this.players.findIndex(p=>p.id===after);
    return Array.from({length:this.players.length},(_,n)=>this.players[(i+n+1)%this.players.length]).filter(predicate);
  }
  addPlayer(id,name,initChips) {
    if(this.find(id)) return {ok:true};
    if(this.players.filter(p=>!p.left).length>=6) return fail('Mesa completa (6 jugadores).');
    if(!['lobby','finished'].includes(this.phase)) return fail('Espera a que termine la mano para entrar.');
    this.players=this.players.filter(p=>!p.left);
    // Respeta el saldo real del jugador, incluido el cero (antes se regalaban 2000
    // fichas de torneo cada vez, ignorando el saldo real). Default solo si no llega valor.
    const chips = (initChips != null) ? Math.max(0, initChips) : 1000;
    this.players.push({id,name:String(name||'Jugador').slice(0,12),chips,hand:[],bet:0,total:0,folded:false,allIn:false,inHand:false,left:false,result:'',actedAt:null});
    if(!this.hostId) this.hostId=id;
    this.touch(); return {ok:true};
  }
  pay(p,amount) {
    const paid=Math.min(p.chips,amount);
    p.chips-=paid; p.bet+=paid; p.total+=paid; p.allIn=p.chips===0;
  }
  event(type, target, index, now, duration=850) {
    const at=Math.max(now,this.visualUntil);
    this.events.push({id:++this.eventNo,type,target,index,at,duration});
    this.visualUntil=at+duration;
    return this.events[this.events.length-1];
  }
  start(id, now=Date.now(), deck=null) {
    if(id!==this.hostId) return fail('Solo el anfitrión abre la siguiente mano.');
    if(!['lobby','finished'].includes(this.phase) || now<this.visualUntil) return fail('La mano o el reparto aún no han terminado.');
    const alive=p=>!p.left && p.chips>0;
    if(this.players.filter(alive).length<2) return fail('Se necesitan dos jugadores con fichas.');
    if(this.startedAt===null) this.startedAt=now;
    this.level=Math.min(10,Math.floor((now-this.startedAt)/(this.blindMinutes*60000)));
    this.smallBlind=10*2**this.level; this.bigBlind=this.smallBlind*2;
    this.dealerId=this.order(this.dealerId,alive)[0].id;
    this.deck=deck ? deck.map(c=>({...c})) : buildDeck();
    this.board=[]; this.pots=[]; this.events=[]; this.visualUntil=now; this.nextHandAt=0; this.handNo++;
    this.players.forEach(p=>Object.assign(p,{hand:[],bet:0,total:0,folded:!alive(p),inHand:alive(p),allIn:false,result:'',actedAt:null}));
    const count=this.players.filter(alive).length;
    this.sbId=count===2 ? this.dealerId : this.order(this.dealerId,alive)[0].id;
    this.bbId=this.order(this.sbId,alive)[0].id;
    this.pay(this.find(this.sbId),this.smallBlind); this.pay(this.find(this.bbId),this.bigBlind);
    const order=this.order(this.dealerId,p=>p.inHand);
    for(let i=0;i<2;i++) for(const p of order) {
      p.hand.push(this.deck.pop()); this.event('hole',p.id,i,now);
    }
    this.phase='preflop'; this.currentBet=this.bigBlind; this.minRaise=this.bigBlind;
    this.pending=this.order(this.bbId,p=>p.inHand&&!p.allIn).map(p=>p.id);
    this.message='Reparto · Preflop'; this.progress(now); this.touch(); return {ok:true};
  }

  canRaise(p) {
    return p.actedAt===null || this.currentBet-p.actedAt>=this.minRaise;
  }
  action(id,type,amount,now=Date.now()) {
    if(type==='start') return this.start(id,now);
    const p=this.find(id);
    if(!p || p.left || id!==this.turnId || now<this.visualUntil || ['lobby','finished'].includes(this.phase)) return fail('Espera tu turno y a que termine el reparto.');
    const owed=Math.max(0,this.currentBet-p.bet);
    if(type==='fold') { p.folded=true; p.result='Retirado'; }
    else if(type==='check') {
      if(owed) return fail('Hay una apuesta pendiente: iguala o retírate.');
    } else if(type==='call') this.pay(p,owed);
    else if(type==='raise' || type==='allIn') {
      const target=type==='allIn' ? p.bet+p.chips : amount;
      if(!Number.isSafeInteger(target) || target<=p.bet || target>p.bet+p.chips) return fail('Importe inválido: indica el total de tu apuesta en esta ronda.');
      if(target<=this.currentBet) {
        if(type!=='allIn') return fail('La subida debe superar la apuesta actual.');
        this.pay(p,target-p.bet);
      } else {
        if(!this.canRaise(p) || !this.players.some(q=>q.id!==id&&q.inHand&&!q.folded&&!q.allIn)) return fail('No puedes reabrir la apuesta ahora.');
        const increase=target-this.currentBet;
        if(increase<this.minRaise && target!==p.bet+p.chips) return fail('Subida mínima hasta '+(this.currentBet+this.minRaise)+'.');
        this.pay(p,target-p.bet);
        if(increase>=this.minRaise) this.minRaise=increase;
        this.currentBet=target;
        this.pending=this.order(id,q=>q.inHand&&!q.folded&&!q.allIn).map(q=>q.id);
      }
    } else return fail('Acción de póker desconocida.');
    p.actedAt=this.currentBet;
    this.pending=this.pending.filter(x=>x!==id);
    this.message=p.name+': '+({fold:'se retira',check:'pasa',call:'iguala',raise:'sube a '+p.bet,allIn:'all-in '+p.bet}[type]);
    this.progress(now); this.touch(); return {ok:true};
  }
  progress(now) {
    const live=this.players.filter(p=>p.inHand&&!p.folded);
    if(live.length<=1) { this.finish(false,now); return; }
    this.pending=this.pending.filter(id=>{const p=this.find(id);return p&&p.inHand&&!p.folded&&!p.allIn;});
    const able=live.filter(p=>!p.allIn);
    if(able.length===1 && able[0].bet>=this.currentBet) this.pending=[];
    if(this.pending.length) {
      this.turnId=this.pending[0]; this.turnDeadline=Math.max(now,this.visualUntil)+45000; return;
    }
    this.turnId=null;
    if(this.phase==='river') { this.finish(true,now); return; }
    this.phase={preflop:'flop',flop:'turn',turn:'river'}[this.phase];
    this.deck.pop();
    const count=this.phase==='flop'?3:1;
    for(let i=0;i<count;i++) {
      this.board.push(this.deck.pop()); this.event('board','board',this.board.length-1,now,1000);
    }
    this.players.forEach(p=>{p.bet=0;p.actedAt=null;});
    this.currentBet=0;this.minRaise=this.bigBlind;
    this.pending=this.order(this.dealerId,p=>p.inHand&&!p.folded&&!p.allIn).map(p=>p.id);
    if(able.length<2) this.pending=[];
    this.progress(now);
  }

  finish(showdown,now) {
    this.turnId=null;this.pending=[];this.turnDeadline=0;this.showdown=showdown;
    const contributors=this.players.filter(p=>p.total>0);
    const levels=[...new Set(contributors.map(p=>p.total))].sort((a,b)=>a-b);
    let previous=0; this.pots=[];
    const scores=new Map(this.players.filter(p=>p.inHand&&!p.folded).map(p=>[p.id,showdown?evaluate([...p.hand,...this.board]):[0]]));
    const survivors=this.players.filter(p=>p.inHand&&!p.folded);
    for(const level of levels) {
      const group=contributors.filter(p=>p.total>=level);
      const amount=(level-previous)*group.length;previous=level;
      if(group.length===1) { group[0].chips+=amount; this.pots.push({amount,winners:[group[0].id],refund:true});continue; }
      const eligible=survivors.length===1 ? survivors : group.filter(p=>!p.folded);
      if(!eligible.length) { group.forEach(p=>p.chips+=amount/group.length);continue; }
      let best=[];
      eligible.forEach(p=>{if(compare(scores.get(p.id),best)>0)best=scores.get(p.id);});
      const winners=this.order(this.dealerId,p=>eligible.includes(p)&&compare(scores.get(p.id),best)===0);
      const each=Math.floor(amount/winners.length);let odd=amount%winners.length;
      winners.forEach(p=>{const win=each+(odd-->0?1:0);p.chips+=win;p.result=(p.result?p.result+' · ':'')+'Gana '+win;});
      this.pots.push({amount,winners:winners.map(p=>p.id),refund:false});
    }
    this.phase='finished';
    const reveal=this.event('showdown','table',0,now,1200);
    this.nextHandAt=reveal.at+reveal.duration+4000;
    this.message='Mano resuelta. '+this.players.filter(p=>p.result.startsWith('Gana')).map(p=>p.name+': '+p.result).join(' · ');
    this.touch();
  }
  removePlayer(id,now=Date.now()) {
    const p=this.find(id);if(!p)return {ok:true,chips:null};
    p.left=true;
    if(p.inHand&&!['lobby','finished'].includes(this.phase)) {
      if(!p.allIn)p.folded=true;
      this.pending=this.pending.filter(x=>x!==id);this.progress(now);
    }
    if(id===this.hostId)this.hostId=(this.players.find(q=>!q.left)||{}).id||null;
    this.touch();return {ok:true,chips:p.chips};
  }
  tick(now=Date.now()) {
    if(this.phase==='finished' && this.nextHandAt && now>=this.nextHandAt) {
      const host=this.find(this.hostId);
      const enough=this.players.filter(p=>!p.left&&p.chips>0).length>=2;
      if(host&&!host.left&&enough) this.start(host.id,now);
      else this.nextHandAt=0;
      return;
    }
    if(this.turnId && now>=this.turnDeadline && now>=this.visualUntil) {
      const p=this.find(this.turnId);
      this.action(p.id,p.bet>=this.currentBet?'check':'fold',null,now);
    }
  }
  stateFor(id,now=Date.now()) {
    const p=this.find(id);const live=this.players.filter(q=>q.inHand&&!q.folded&&!q.allIn);
    const canAct=!!(p&&!p.left&&this.turnId===id&&now>=this.visualUntil);
    // Solo la combinación del destinatario, por calle, sin datos de los rivales.
    // El cliente elige la última calle cuyo reparto ya se ve completo.
    const privateHand = p && !p.left && p.inHand && p.hand.length === 2 ? {
      playerId: id,
      labels: Array.from({length: this.board.length + 1}, (_, count) => count < 3 ?
        (p.hand[0].rank === p.hand[1].rank ? 'Pareja' : 'Carta alta') :
        LABELS[evaluate([...p.hand, ...this.board.slice(0, count)])[0]])
    } : null;
    return {game:this.game,code:this.code,version:this.version,phase:this.phase,handNo:this.handNo,privateHand,
      hostId:this.hostId,dealerId:this.dealerId,sbId:this.sbId,bbId:this.bbId,turnId:this.turnId,
      message:this.message,chat:chatFor(this),board:this.board,events:this.events,serverNow:now,visualUntil:this.visualUntil,
      showdown:this.phase==='finished'&&this.showdown,nextHandAt:this.nextHandAt,
      turnDeadline:this.turnDeadline,smallBlind:this.smallBlind,bigBlind:this.bigBlind,level:this.level,
      nextBlindAt:this.startedAt===null||this.level>=10?null:this.startedAt+(this.level+1)*this.blindMinutes*60000,
      blindMinutes:this.blindMinutes,pot:this.players.reduce((n,q)=>n+q.total,0),pots:this.pots,
      currentBet:this.currentBet,minRaiseTo:this.currentBet+this.minRaise,
      toCall:p?Math.min(p.chips,Math.max(0,this.currentBet-p.bet)):0,
      maxRaiseTo:p?p.bet+p.chips:0,canAct,
      canRaise:!!(p&&this.canRaise(p)&&live.some(q=>q.id!==id)&&p.bet+p.chips>this.currentBet),
      players:this.players.filter(q=>!q.left||q.inHand).map(q=>({id:q.id,name:q.name,chips:q.chips,bet:q.bet,total:q.total,
        folded:q.folded,allIn:q.allIn,inHand:q.inHand,left:q.left,result:q.result,
        cards:(q.id===id||(this.phase==='finished'&&this.showdown&&!q.folded))?q.hand:q.hand.map(()=>null),
        handName:this.phase==='finished'&&this.showdown&&q.inHand&&!q.folded?LABELS[evaluate([...q.hand,...this.board])[0]]:'',
        bestHand:this.phase==='finished'&&this.showdown&&q.inHand&&!q.folded?bestFive([...q.hand,...this.board]).cards:[]}))};
  }
}
module.exports={PokerRoom,buildDeck,evaluate,bestFive,compare};
