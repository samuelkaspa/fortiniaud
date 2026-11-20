import html from './index.html';
// Servidor multiplayer do cubedax (Cloudflare Worker + Durable Object).
// Todas as salas vivem em um único Durable Object ("global"): simples e suficiente para um jogo pequeno.
const CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REL=new Set(['st','door','kn','ek','dead','win','pick','hit']);
const clean=(s,n)=>String(s==null?'':s).replace(/[<>&"'`\\]/g,'').trim().slice(0,n);
const rnd=n=>Math.floor(Math.random()*n);
const MODES=new Set(['easy','normal','hard']);
const KINDS=new Set(['coop','race','battle']);
const RK=k=>k==='race'||k==='battle';

export class Hub{
 constructor(){this.rooms=new Map();this.cs=new Set()}
 add(ws){const c={ws,room:null,s:-1,sub:false,name:'Cubedax',rec:'—',skin:'preto',ready:false};this.cs.add(c);return c}
 send(c,o){try{c.ws.send(JSON.stringify(o))}catch(e){}}
 cast(r,o,ex){for(const c of r.pl)if(c&&c!==ex)this.send(c,o)}
 count(r){return r.pl.filter(Boolean).length}
 list(){return[...this.rooms.values()].filter(r=>!r.priv&&!r.started).map(r=>({code:r.code,host:r.pl[r.host].name,n:this.count(r),max:r.max}))}
 push(){const l={t:'rooms',list:this.list()};for(const c of this.cs)if(c.sub)this.send(c,l)}
 view(r){const players=[];r.pl.forEach((c,s)=>{if(c)players.push({s,name:c.name,rec:c.rec,skin:c.skin,ready:c.ready})});return{code:r.code,priv:r.priv,mode:r.mode,kind:r.kind,rt:r.rt,rp:r.rp,max:r.max,host:r.host,started:r.started,players}}
 sync(r){r.pl.forEach(c=>{if(c)this.send(c,{t:'room',you:c.s,room:this.view(r)})})}
 plan(){// 10 tipos de mapa diferentes: cada ciclo de 10 usa todos os tipos, em ordem embaralhada
  const out=[];let last=-1;
  while(out.length<30){const a=[...Array(10).keys()];for(let i=9;i>0;i--){const j=rnd(i+1);[a[i],a[j]]=[a[j],a[i]]}
   if(a[0]===last){[a[0],a[1]]=[a[1],a[0]]}last=a[9];for(const t of a)out.push({t,s:rnd(1e6)})}
  return out.slice(0,30)}
 chk(r){const n=this.count(r);
  if(r.started&&r.retry.size&&r.retry.size>=n){r.retry.clear();this.cast(r,{t:'restart',plan:this.plan(),mode:r.mode})}
  else if(r.started&&r.retry.size)this.cast(r,{t:'retry',n:r.retry.size,of:n})}
 // ---- modo corrida: o servidor decide quem chegou primeiro e conta os pontos ----
 one(r){let t;do{t=rnd(10)}while(t===r.lt);r.lt=t;return{t,s:rnd(1e6)}}
 arm(r){const al=new Set();r.pl.forEach((c,s)=>{if(c)al.add(s)});r.rd={over:false,mo:false,alive:al};r.rdy=new Set();clearTimeout(r.rto);clearTimeout(r.bto);r.bto=0}
 // batalha: quando sobra 1 (ou 0), espera 0,7s (caso o último também caia) e fecha a rodada
 bchk(r){const d=r.rd;if(!d||d.over||r.bto||d.alive.size>1)return;
  r.bto=setTimeout(()=>{r.bto=0;if(r.rd!==d||d.over)return;const a=[...d.alive];this.rend(r,a.length===1?a[0]:-1)},700)}
 rend(r,wn){const d=r.rd;if(!d||d.over)return;d.over=true;if(wn>=0)r.score[wn]++;
  const over=wn>=0&&r.score[wn]>=r.rp;d.mo=over;
  this.cast(r,{t:'rend',w:wn,score:r.score.slice(),over,mw:over?wn:-1});
  if(!over)r.rto=setTimeout(()=>this.rnext(r),20000)}
 rnext(r){clearTimeout(r.rto);if(this.rooms.get(r.code)!==r||!r.started||!RK(r.kind)||!r.rd||!r.rd.over||r.rd.mo)return;
  r.round++;this.arm(r);this.cast(r,{t:'rnext',n:r.round,sp:this.one(r),score:r.score.slice()})}
 leave(c){const r=c.room;if(!r)return;const s=c.s;r.pl[s]=null;r.retry.delete(s);c.room=null;c.s=-1;c.ready=false;
  if(!this.count(r)){clearTimeout(r.rto);clearTimeout(r.bto);this.rooms.delete(r.code)}
  else{if(r.host===s)r.host=r.pl.findIndex(Boolean);
   if(r.started&&RK(r.kind)){
    if(this.count(r)<2){r.started=false;clearTimeout(r.rto);clearTimeout(r.bto);r.bto=0;r.pl.forEach(x=>{if(x)x.ready=false})}
    else if(r.rd){r.rd.alive.delete(s);if(!r.rd.over){if(r.kind==='battle')this.bchk(r);else if(!r.rd.alive.size)this.rend(r,-1)}else if(!r.rd.mo&&r.rdy.size>=this.count(r))this.rnext(r)}}
   this.sync(r);this.chk(r)}
  this.push()}
 drop(c){this.cs.delete(c);this.leave(c)}
 msg(c,raw){if(typeof raw!=='string'||raw.length>600)return;let m;try{m=JSON.parse(raw)}catch(e){return}
  if(!m||typeof m.t!=='string')return;const r=c.room;
  switch(m.t){
   case'ping':break;
   case'sub':c.sub=!!m.v;if(c.sub)this.send(c,{t:'rooms',list:this.list()});break;
   case'prof':c.name=clean(m.name,12)||'Cubedax';c.rec=clean(m.rec,12)||'—';c.skin=clean(m.skin,10)||'preto';if(r){this.sync(r);this.push()}break;
   case'create':{if(r)return;let code;do{code=Array.from({length:4},()=>CH[rnd(CH.length)]).join('')}while(this.rooms.has(code));
    const room={code,priv:!!m.priv,mode:'normal',max:Math.max(2,Math.min(4,+m.max||4)),host:0,started:false,pl:[c],retry:new Set(),kind:KINDS.has(m.kind)?m.kind:'coop',rt:m.kind==='battle'?60:20,rp:3,score:[0,0,0,0],round:0,rd:null,rdy:new Set(),rto:0,bto:0,lt:-1};
    this.rooms.set(code,room);c.room=room;c.s=0;c.ready=false;this.sync(room);this.push();break}
   case'join':{if(r)return;const room=this.rooms.get(clean(m.code,4).toUpperCase());
    if(!room)return this.send(c,{t:'err',m:'Sala não encontrada.'});
    if(room.started)return this.send(c,{t:'err',m:'A partida já começou.'});
    let s=-1;for(let i=0;i<room.max;i++)if(!room.pl[i]){s=i;break}
    if(s<0)return this.send(c,{t:'err',m:'Sala cheia.'});
    room.pl[s]=c;c.room=room;c.s=s;c.ready=false;this.sync(room);this.push();break}
   case'mode':if(r&&!r.started&&r.host===c.s&&MODES.has(m.v)){r.mode=m.v;this.sync(r)}break;
   case'kind':if(r&&!r.started&&r.host===c.s&&KINDS.has(m.v)){if(r.kind!==m.v)r.rt=m.v==='battle'?60:20;r.kind=m.v;this.sync(r)}break;
   case'rcfg':if(r&&!r.started&&r.host===c.s){r.rt=Math.max(5,Math.min(120,Math.round(+m.tm||r.rt)));r.rp=Math.max(1,Math.min(20,Math.round(+m.p||r.rp)));this.sync(r)}break;
   case'rready':if(r&&r.started&&RK(r.kind)&&r.rd&&r.rd.over&&!r.rd.mo){r.rdy.add(c.s);if(r.rdy.size>=this.count(r))this.rnext(r)}break;
   case'leave':this.leave(c);break;
   case'ready':if(r&&!r.started){c.ready=!!m.v;this.sync(r)}break;
   case'start':if(r&&!r.started&&r.host===c.s){
    if(this.count(r)<2||r.pl.some(x=>x&&x!==c&&!x.ready))return this.send(c,{t:'err',m:'Todos precisam estar prontos.'});
    r.started=true;r.retry.clear();this.sync(r);
    if(RK(r.kind)){r.score=[0,0,0,0];r.round=0;r.lt=-1;this.arm(r);this.cast(r,{t:'start',kind:r.kind,plan:[this.one(r)],mode:r.mode,rp:r.rp,rt:r.rt,score:r.score.slice()})}
    else this.cast(r,{t:'start',plan:this.plan(),mode:r.mode});
    this.push()}break;
   case'retry':if(r&&r.started){r.retry.add(c.s);this.chk(r)}break;
   case'back':if(r&&r.started){r.started=false;r.retry.clear();clearTimeout(r.rto);r.pl.forEach(x=>{if(x)x.ready=false});this.sync(r);this.push()}break;
   case'cardres':if(r&&r.started&&r.host===c.s){m.s=c.s;this.cast(r,m,c)}break;
   default:if(r&&r.started&&REL.has(m.t)){
    if(RK(r.kind)){const d=r.rd;if(!d||d.over)return;m.s=c.s;this.cast(r,m,c);
     if(m.t==='win'&&r.kind==='race')this.rend(r,c.s);
     else if(m.t==='dead'){d.alive.delete(c.s);if(r.kind==='battle')this.bchk(r);else if(!d.alive.size)this.rend(r,-1)}
     return}
    m.s=c.s;this.cast(r,m,c)}}}
}

export class GameHub{
 constructor(){this.hub=new Hub()}
 async fetch(req){
  if(req.headers.get('Upgrade')!=='websocket')return new Response('Use WebSocket',{status:426});
  const [cl,sv]=Object.values(new WebSocketPair());sv.accept();const c=this.hub.add(sv);
  sv.addEventListener('message',e=>{try{this.hub.msg(c,e.data)}catch(x){console.log('msg error',x&&x.stack)}});
  sv.addEventListener('close',()=>this.hub.drop(c));
  sv.addEventListener('error',()=>this.hub.drop(c));
  return new Response(null,{status:101,webSocket:cl})}
}

export default{
 async fetch(req,env){
  const u=new URL(req.url);
  if(u.pathname==='/ws')return env.HUB.get(env.HUB.idFromName('global')).fetch(req);
  return new Response(html,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-cache'}})}
};
