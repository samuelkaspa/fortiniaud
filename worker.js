/* Jogo no Cloudflare: Worker + Durable Object (contas, salvamento, amigos, grupo e emotes em tempo real).
   Os arquivos do site ficam em /public e são servidos direto pelo Cloudflare; só /api/* passa por aqui. */
import { DurableObject } from "cloudflare:workers";
import html from "./index.html";

const enc = new TextEncoder();
const hex = u8 => [...u8].map(x => x.toString(16).padStart(2, "0")).join("");
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async x => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(x)))));
const hash = async (pw, salt) => {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, k, 512)));
};
/* mesmo hash do código secreto que antes ficava no navegador (agora só o servidor confere) */
const cyrb53 = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };
const ADM_HASH = 2543653124716815;
const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/* ---------- Regras ---------- */
const nameErr = n => {
  if (typeof n !== "string" || !n) return "Nome inválido";
  if (!/^[A-Za-z0-9_]+$/.test(n)) return "Só letras, números e _";
  if ((n.match(/_/g) || []).length > 1) return "Use no máximo um _";
  if (n.length < 3 || n.length > 10) return "Use de 3 a 10 caracteres";
  return "";
};
const passErr = p => (typeof p !== "string" || p.length < 6 ? "A senha precisa ter pelo menos 6 caracteres" : p.length > 64 ? "Senha muito longa" : "");
const codeOk = c => typeof c === "string" && /^[A-Z0-9-]{4,16}$/.test(c);
const gmailOk = e => typeof e === "string" && /^[a-z0-9._+-]+@(gmail|googlemail)\.com$/i.test(e) && e.length <= 80;
const low = s => String(s).toLowerCase();
const codeFmt = c => typeof c === "string" && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c);
const clean = st => { if (!st || typeof st !== "object") return null; const o = Object.assign({}, st); delete o.acc; return o; };
const pub = a => ({ name: a.name, code: a.code, type: a.type });
const send = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const EMOTE_IDS = ["wave", "clap", "box", "twerk", "laugh", "cry", "dis", "crazy"];
const PARTY_MAX = 4, INVITE_MS = 60000, SESSION_MS = 90 * 864e5;

function createGame(ctx, env) {
  const storage = ctx.storage;

  /* ---------- Banco: cada conta numa chave "a:<id>", o resto em chaves por seção ---------- */
  const db = { accounts: {}, names: {}, sessions: {}, friends: {}, reqs: {}, profiles: {}, guests: {}, admins: {}, verified: {} };
  const dirty = new Set();
  const P = (...keys) => keys.forEach(k => dirty.add(k));
  async function flush() {
    const ks = [...dirty]; dirty.clear();
    for (const k of ks) {
      if (k.startsWith("a:")) { const a = db.accounts[k.slice(2)]; if (a) await storage.put(k, a); else await storage.delete(k); }
      else await storage.put(k, db[k]);
    }
  }

  const acctByName = n => Object.values(db.accounts).find(a => low(a.name) === low(n));
  const acctByCode = c => Object.values(db.accounts).find(a => a.code === c);

  function claimName(code, name) {
    const owner = db.names[low(name)];
    if (owner && owner !== code) return false;
    for (const k of Object.keys(db.names)) if (db.names[k] === code) delete db.names[k];
    db.names[low(name)] = code; (db.profiles[code] = db.profiles[code] || {}).name = name; P("names", "profiles"); return true;
  }

  async function newSession(id) {
    const t = rnd(32);
    db.sessions[await sha(t)] = { id, at: Date.now() }; P("sessions");
    return t;
  }
  async function sessAcct(t) {
    if (typeof t !== "string") return null;
    const s = db.sessions[await sha(t)];
    return s ? db.accounts[s.id] || null : null;
  }

  const fails = {};
  const locked = k => { const f = fails[k]; return f && f.n >= 5 && Date.now() - f.t < 60000; };
  function fail(k) { const f = fails[k] || (fails[k] = { n: 0, t: 0 }); if (Date.now() - f.t > 60000) f.n = 0; f.n++; f.t = Date.now(); }

  /* ---------- Google (valida o token no servidor) ---------- */
  const gid = () => String(env.GOOGLE_CLIENT_ID || "").trim();
  async function googleVerify(credential) {
    if (!gid()) throw new Error("noconfig");
    if (typeof credential !== "string" || credential.length < 20) throw new Error("invalid");
    let r; try { r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)); } catch (e) { throw new Error("net"); }
    let j; try { j = await r.json(); } catch (e) { throw new Error("invalid"); }
    if (!r.ok || j.aud !== gid() || String(j.email_verified) !== "true" || !j.sub || !j.email) throw new Error("invalid");
    if (j.iss !== "accounts.google.com" && j.iss !== "https://accounts.google.com") throw new Error("invalid");
    return { sub: j.sub, email: low(j.email) };
  }
  const gErr = e => e.message === "noconfig" ? [503, { error: "Login com Google ainda não foi configurado no servidor" }]
    : e.message === "net" ? [503, { error: "Não foi possível falar com o Google agora. Tente de novo." }]
    : [401, { error: "Não foi possível validar o Google" }];

  /* ---------- Rotas de conta ---------- */
  const routes = {
    "GET /api/config": async () => [200, { googleClientId: gid() }],

    "POST /api/name": async b => {
      if (!codeOk(b.code) || nameErr(b.name)) return [400, { error: "Nome inválido" }];
      if (acctByCode(b.code)) return [403, { error: "Contas só trocam de nome pela conta (1000 V-Bucks)" }];
      if (!claimName(b.code, b.name)) return [409, { error: "Já existe alguém com esse nome" }];
      return [200, { ok: true }];
    },

    "POST /api/register": async b => {
      if (nameErr(b.name)) return [400, { error: nameErr(b.name) }];
      if (passErr(b.password)) return [400, { error: passErr(b.password) }];
      if (!codeOk(b.code)) return [400, { error: "Código inválido" }];
      if (b.email && !gmailOk(b.email)) return [400, { error: "Use um e-mail do Google (@gmail.com)" }];
      if (acctByName(b.name) || acctByCode(b.code)) return [409, { error: "Já existe alguém com esse nome" }];
      if (!claimName(b.code, b.name)) return [409, { error: "Já existe alguém com esse nome" }];
      const salt = rnd(16), id = "v_" + rnd(8);
      const pass = await hash(b.password, salt);
      db.accounts[id] = { id, type: "virtual", name: b.name, code: b.code, salt, pass, email: b.email ? low(b.email) : "", save: clean(b.state), ts: Date.now() };
      P("a:" + id);
      const token = await newSession(id);
      return [200, { token, account: pub(db.accounts[id]), ts: db.accounts[id].ts }];
    },

    "POST /api/login": async (b, req) => {
      const k = low(b.name || "") + "|" + (req.headers.get("CF-Connecting-IP") || "");
      if (locked(k)) return [429, { error: "Muitas tentativas. Espere 1 minuto." }];
      const a = typeof b.name === "string" && typeof b.password === "string" ? acctByName(b.name) : null;
      if (!a || a.type !== "virtual" || !eq(await hash(b.password, a.salt), a.pass)) { fail(k); return [401, { error: "Nome ou senha incorretos" }]; }
      delete fails[k];
      return [200, { token: await newSession(a.id), account: pub(a), save: a.save, ts: a.ts }];
    },

    "POST /api/google": async b => {
      let g; try { g = await googleVerify(b.credential); } catch (e) { return gErr(e); }
      let a = Object.values(db.accounts).find(x => x.type === "google" && x.sub === g.sub), created = false;
      if (!a) {
        if (nameErr(b.name) || !codeOk(b.code)) return [400, { error: "Nome inválido" }];
        if (acctByName(b.name) || acctByCode(b.code) || !claimName(b.code, b.name)) return [409, { error: "Já existe alguém com esse nome. Troque o nome no perfil e tente de novo." }];
        const id = "g_" + rnd(8);
        a = db.accounts[id] = { id, type: "google", sub: g.sub, name: b.name, code: b.code, email: g.email, save: clean(b.state), ts: Date.now() };
        created = true; P("a:" + id);
      }
      return [200, { token: await newSession(a.id), account: pub(a), created, save: created ? null : a.save, ts: a.ts }];
    },

    "POST /api/reset": async b => {
      if (passErr(b.password)) return [400, { error: passErr(b.password) }];
      let g; try { g = await googleVerify(b.credential); } catch (e) { return gErr(e); }
      const a = typeof b.name === "string" ? acctByName(b.name) : null;
      if (!a || a.type !== "virtual" || !a.email) return [400, { error: "Essa conta não tem e-mail do Google cadastrado" }];
      if (a.email !== g.email) return [403, { error: "Esse Google não é o e-mail cadastrado nessa conta" }];
      a.salt = rnd(16); a.pass = await hash(b.password, a.salt);
      for (const k of Object.keys(db.sessions)) if (db.sessions[k].id === a.id) delete db.sessions[k];
      P("a:" + a.id, "sessions"); return [200, { ok: true }];
    },

    "POST /api/save": async b => {
      const a = await sessAcct(b.token); if (!a) return [401, { error: "Sessão expirada" }];
      const st = clean(b.state); if (!st) return [400, { error: "Dados inválidos" }];
      st.name = a.name; st.code = a.code;
      a.save = st; a.ts = Date.now(); P("a:" + a.id); return [200, { ok: true, ts: a.ts }];
    },

    "POST /api/load": async b => {
      const a = await sessAcct(b.token); if (!a) return [401, { error: "Sessão expirada" }];
      return [200, { account: pub(a), save: a.save, ts: a.ts }];
    },

    "POST /api/rename": async b => {
      const a = await sessAcct(b.token); if (!a) return [401, { error: "Sessão expirada" }];
      if (nameErr(b.name)) return [400, { error: nameErr(b.name) }];
      if (low(b.name) === low(a.name)) return [400, { error: "Esse já é o seu nome" }];
      if (acctByName(b.name) || !claimName(a.code, b.name)) return [409, { error: "Já existe alguém com esse nome" }];
      a.name = b.name; if (a.save) a.save.name = b.name; (db.profiles[a.code] = db.profiles[a.code] || {}).name = b.name;
      P("a:" + a.id, "profiles"); mpNameChanged(a.code);
      return [200, { ok: true, account: pub(a) }];
    },

    "POST /api/logout": async b => {
      if (typeof b.token === "string") { delete db.sessions[await sha(b.token)]; P("sessions"); }
      return [200, { ok: true }];
    }
  };

  /* =====================================================================
     MULTIPLAYER: amigos, grupo (até 4), presença, aparência e emotes
     Tempo real por Server-Sent Events
     ===================================================================== */
  const live = {}, sids = {}, parties = {}, partyOf = {}, invites = {};
  const cleanName = n => (typeof n === "string" && !nameErr(n) ? n : "Jogador");
  const isOnline = c => !!(live[c] && live[c].sids.size);
  const isAdm = c => !!db.admins[c];

  async function identify(b) {
    if (!b) return null;
    if (typeof b.token === "string") { const a = await sessAcct(b.token); return a ? { code: a.code, name: a.name } : null; }
    if (codeOk(b.code) && typeof b.key === "string" && /^[a-f0-9]{16,64}$/.test(b.key)) {
      if (acctByCode(b.code)) return null;
      const h = await sha(b.key);
      if (!db.guests[b.code]) { db.guests[b.code] = h; P("guests"); } else if (db.guests[b.code] !== h) return null;
      return { code: b.code, name: cleanName(b.name) };
    }
    return null;
  }
  function okName(code, name) {
    if (nameErr(name)) return "";
    const o = db.names[low(name)]; return !o || o === code ? name : "";
  }
  const nameOf = c => (db.profiles[c] && db.profiles[c].name) || (live[c] && live[c].name) || "Jogador";
  const lvlOf = c => (live[c] && live[c].lvl) || (db.profiles[c] && db.profiles[c].lvl) || 0;

  function emit(code, msg) {
    const l = live[code]; if (!l) return; const data = "data: " + JSON.stringify(msg) + "\n\n";
    for (const sid of l.sids) { const s = sids[sid]; if (s && s.res) { try { s.res.write(data); } catch (e) {} } }
  }
  const friendList = c => (db.friends[c] || []).map(f => ({ code: f, name: nameOf(f), lvl: lvlOf(f), online: isOnline(f), party: partyOf[f] ? 1 : 0 }));
  const reqList = c => (db.reqs[c] || []).map(f => ({ code: f, name: nameOf(f), lvl: lvlOf(f) }));
  const pushFriends = c => { if (isOnline(c)) emit(c, { t: "friends", friends: friendList(c) }); };
  const pushReqs = c => { if (isOnline(c)) emit(c, { t: "reqs", reqs: reqList(c) }); };
  const partyView = c => {
    const p = parties[partyOf[c]]; if (!p) return null;
    return { id: p.id, leader: p.members[0], members: p.members.map(m => ({ code: m, name: nameOf(m), lvl: lvlOf(m), online: isOnline(m), adm: isAdm(m), app: (live[m] && live[m].app) || null })) };
  };
  const pushParty = p => p.members.forEach(m => emit(m, { t: "party", party: partyView(m) }));
  const presence = c => (db.friends[c] || []).forEach(pushFriends);

  function leaveParty(c) {
    const pid = partyOf[c], p = parties[pid]; if (!p) return; delete partyOf[c];
    p.members = p.members.filter(m => m !== c); emit(c, { t: "party", party: null });
    if (p.members.length <= 1) { p.members.forEach(m => { delete partyOf[m]; emit(m, { t: "party", party: null }); }); delete parties[pid]; }
    else pushParty(p);
    presence(c);
  }
  function mpNameChanged(code) { presence(code); const p = parties[partyOf[code]]; if (p) pushParty(p); }
  function mpMe(b) { const s = sids[b && b.sid]; return s && s.res ? s.code : null; }
  const mpDefs = (code, b) => {
    const l = live[code] || (live[code] = { name: "", lvl: 0, app: null, sids: new Set(), lastEmote: 0 });
    if (typeof b.name === "string") { const n = okName(code, b.name); if (n) { l.name = n; (db.profiles[code] = db.profiles[code] || {}).name = n; } }
    if (b.app && typeof b.app === "object") {
      const e = {}, st = {}, src = b.app.eq || {}, ss = b.app.sty || {};
      for (const k of ["char", "hammer", "bag"]) if (typeof src[k] === "string" && /^[a-z0-9_]{1,12}$/.test(src[k])) { e[k] = src[k]; const v = ss[src[k]]; if (Number.isInteger(v) && v >= 0 && v < 20) st[src[k]] = v; }
      l.app = { eq: e, sty: st }; const lv = parseInt(b.app.lvl, 10); l.lvl = lv >= 0 && lv <= 200 ? lv : 0; (db.profiles[code] = db.profiles[code] || {}).lvl = l.lvl;
    }
    P("profiles");
    return l;
  };

  const mproutes = {
    "POST /api/mp/connect": async b => {
      const id = await identify(b); if (!id) return [401, { error: "Identidade inválida" }];
      const l = mpDefs(id.code, Object.assign({}, b, { name: id.name })); if (!l.name) l.name = okName(id.code, id.name) || "Jogador";
      (db.profiles[id.code] = db.profiles[id.code] || {}).name = (db.profiles[id.code].name || l.name); P("profiles");
      const sid = rnd(16); sids[sid] = { code: id.code, res: null, at: Date.now() };
      setTimeout(() => { if (sids[sid] && !sids[sid].res) delete sids[sid]; }, 30000);
      return [200, { sid, me: { code: id.code, name: nameOf(id.code), adm: isAdm(id.code) } }];
    },
    "POST /api/mp/state": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      mpDefs(c, b); const p = parties[partyOf[c]]; if (p) pushParty(p); presence(c); return [200, { ok: true }];
    },
    "POST /api/mp/friend/add": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      let t = typeof b.target === "string" ? b.target.trim() : "";
      if (!codeFmt(t.toUpperCase())) t = db.names[low(t)] || Object.keys(db.profiles).find(k => db.profiles[k].name && low(db.profiles[k].name) === low(t)) || ""; else t = t.toUpperCase();
      if (!t || !(db.profiles[t] || acctByCode(t))) return [404, { error: "Jogador não encontrado" }];
      if (t === c) return [400, { error: "Esse é você mesmo" }];
      const mine = db.friends[c] = db.friends[c] || [];
      if (mine.includes(t)) return [409, { error: "Vocês já são amigos" }];
      if (mine.length >= 100) return [400, { error: "Lista de amigos cheia" }];
      const my = db.reqs[c] = db.reqs[c] || [];
      if (my.includes(t)) {
        db.reqs[c] = my.filter(x => x !== t); mine.push(t); (db.friends[t] = db.friends[t] || []).push(c); P("friends", "reqs");
        pushFriends(c); pushFriends(t); pushReqs(c); emit(t, { t: "toast", msg: nameOf(c) + " aceitou seu pedido!" }); return [200, { ok: true, status: "friends", name: nameOf(t) }];
      }
      const his = db.reqs[t] = db.reqs[t] || [];
      if (his.includes(c)) return [409, { error: "Pedido já enviado" }];
      if (his.length >= 50) return [400, { error: "Esse jogador tem pedidos demais" }];
      his.push(c); P("reqs"); pushReqs(t); emit(t, { t: "toast", msg: nameOf(c) + " quer ser seu amigo" });
      return [200, { ok: true, status: "sent", name: nameOf(t) }];
    },
    "POST /api/mp/friend/accept": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }]; const f = b.code;
      if (!(db.reqs[c] || []).includes(f)) return [404, { error: "Pedido não encontrado" }];
      db.reqs[c] = db.reqs[c].filter(x => x !== f);
      const a = db.friends[c] = db.friends[c] || [], o = db.friends[f] = db.friends[f] || [];
      if (!a.includes(f)) a.push(f); if (!o.includes(c)) o.push(c); P("friends", "reqs");
      pushFriends(c); pushFriends(f); pushReqs(c); emit(f, { t: "toast", msg: nameOf(c) + " aceitou seu pedido!" }); return [200, { ok: true }];
    },
    "POST /api/mp/friend/decline": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      db.reqs[c] = (db.reqs[c] || []).filter(x => x !== b.code); P("reqs"); pushReqs(c); return [200, { ok: true }];
    },
    "POST /api/mp/friend/remove": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }]; const f = b.code;
      db.friends[c] = (db.friends[c] || []).filter(x => x !== f); db.friends[f] = (db.friends[f] || []).filter(x => x !== c); P("friends"); pushFriends(c); pushFriends(f); return [200, { ok: true }];
    },
    "POST /api/mp/party/invite": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }]; const t = b.code;
      if (!(db.friends[c] || []).includes(t)) return [403, { error: "Só dá para convidar amigos" }];
      if (!isOnline(t)) return [409, { error: "Esse amigo está offline" }];
      if (partyOf[t]) return [409, { error: "Esse amigo já está em um grupo" }];
      let p = parties[partyOf[c]];
      if (p && p.members.length >= PARTY_MAX) return [409, { error: "Grupo cheio" }];
      if (!p) { const id = rnd(6); p = parties[id] = { id, members: [c] }; partyOf[c] = id; emit(c, { t: "party", party: partyView(c) }); }
      (invites[t] = invites[t] || {})[p.id] = { from: c, at: Date.now() };
      emit(t, { t: "invite", pid: p.id, from: { code: c, name: nameOf(c) } }); return [200, { ok: true }];
    },
    "POST /api/mp/party/join": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      const inv = invites[c] && invites[c][b.pid], p = parties[b.pid];
      if (!inv || Date.now() - inv.at > INVITE_MS || !p) return [404, { error: "Convite expirado" }];
      delete invites[c][b.pid];
      if (partyOf[c]) return [409, { error: "Você já está em um grupo" }];
      if (p.members.length >= PARTY_MAX) return [409, { error: "Grupo cheio" }];
      p.members.push(c); partyOf[c] = p.id; pushParty(p); presence(c); return [200, { ok: true }];
    },
    "POST /api/mp/party/decline": async b => { const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }]; if (invites[c]) delete invites[c][b.pid]; return [200, { ok: true }]; },
    "POST /api/mp/party/leave": async b => { const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }]; leaveParty(c); return [200, { ok: true }]; },
    "POST /api/mp/emote": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!EMOTE_IDS.includes(b.id)) return [400, { error: "Emote inválido" }];
      const l = live[c], now = Date.now(); if (now - l.lastEmote < 300) return [429, { error: "Calma!" }]; l.lastEmote = now;
      const p = parties[partyOf[c]]; if (p) p.members.forEach(m => { if (m !== c) emit(m, { t: "emote", code: c, id: b.id }); });
      return [200, { ok: true }];
    }
  };
  Object.assign(routes, mproutes);

  /* =====================================================================
     ADMIN: acesso confirmado pelo servidor + concessão da tag/permissão ADM
     1) /start  recebe o código de acesso (ou um ADM já concedido) e gera um código aleatório de 5 caracteres
     2) /confirm confere o código digitado; só então o servidor libera a sessão de admin (30 min)
     3) /players e /grant exigem essa sessão; jogador comum nunca passa
     ===================================================================== */
  const admSess = {}, admPend = {}, ADM_TTL = 30 * 60e3, CH_TTL = 2 * 60e3, CH_TRIES = 3;
  const admOk = c => { const s = admSess[c]; if (s && s.exp <= Date.now()) { delete admSess[c]; return false; } return !!s; };
  function chalCode() {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; /* letras e números, sem os que confundem (0/O, 1/I) */
    for (;;) {
      const c = [...crypto.getRandomValues(new Uint8Array(5))].map(x => A[x % 32]).join("");
      if (/[A-Z]/.test(c) && /[2-9]/.test(c)) return c; /* sempre tem letra e número */
    }
  }
  const adminRoutes = {
    "POST /api/admin/start": async (b, req) => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      const k = "adm|" + (req.headers.get("CF-Connecting-IP") || "") + "|" + c;
      if (locked(k)) return [429, { error: "Muitas tentativas. Espere 1 minuto." }];
      const raw = typeof b.code === "string" ? b.code.trim().toLowerCase() : "";
      let owner = false;
      if (raw) { if (raw.length > 64 || cyrb53(raw) !== ADM_HASH) { fail(k); return [403, { error: "Acesso negado" }]; } owner = true; }
      else if (!isAdm(c)) { fail(k); return [403, { error: "Acesso negado" }]; } /* sem código: só quem já recebeu ADM */
      delete fails[k];
      delete admSess[c];
      const val = chalCode();
      admPend[c] = { val, exp: Date.now() + CH_TTL, tries: 0, sid: b.sid, owner };
      return [200, { challenge: val, ttl: CH_TTL / 1000 }];
    },
    "POST /api/admin/confirm": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      const p = admPend[c];
      if (!p || p.sid !== b.sid || Date.now() > p.exp) { delete admPend[c]; return [410, { error: "Código expirado. Comece de novo.", reset: true }]; }
      const v = typeof b.code === "string" ? b.code.trim().toUpperCase() : "";
      if (!eq(v, p.val)) {
        if (++p.tries >= CH_TRIES) { delete admPend[c]; return [403, { error: "Código incorreto. Comece de novo.", reset: true }]; }
        return [403, { error: "Código incorreto" }];
      }
      delete admPend[c];
      admSess[c] = { exp: Date.now() + ADM_TTL, owner: p.owner };
      return [200, { ok: true, owner: p.owner, adm: isAdm(c) }];
    },
    "POST /api/admin/players": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const players = Object.keys(live).filter(isOnline).map(k => ({ code: k, name: nameOf(k), lvl: lvlOf(k), adm: isAdm(k), ver: !!db.verified[k], me: k === c }));
      return [200, { players, owner: !!admSess[c].owner }];
    },
    /* ações abaixo: só o dono (quem entrou com o código de acesso) */
    "POST /api/admin/revoke": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const t = b.code;
      if (!codeOk(t) || !isAdm(t)) return [404, { error: "Esse jogador não é ADM" }];
      delete db.admins[t]; delete admSess[t]; delete admPend[t]; P("admins");
      emit(t, { t: "adm", on: false }); emit(t, { t: "toast", msg: "Sua tag ADM foi removida" });
      const p = parties[partyOf[t]]; if (p) pushParty(p);
      return [200, { ok: true, name: nameOf(t) }];
    },
    "POST /api/admin/verify": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const t = b.code;
      if (!codeOk(t) || !isOnline(t)) return [404, { error: "Esse jogador não está mais na partida" }];
      const on = !!b.on; if (on) db.verified[t] = 1; else delete db.verified[t]; P("verified");
      emit(t, { t: "ver", on });
      return [200, { ok: true, name: nameOf(t), on }];
    },
    /* expulsar = apagar a conta e todos os dados do jogador (só o dono) */
    "POST /api/admin/kick": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const t = b.code;
      if (!codeOk(t)) return [400, { error: "Código inválido" }];
      if (t === c) return [400, { error: "Você não pode expulsar a si mesmo" }];
      const a = acctByCode(t);
      if (!a && !isOnline(t) && !db.profiles[t]) return [404, { error: "Jogador não encontrado" }];
      const name = nameOf(t);
      emit(t, { t: "kick" });
      leaveParty(t);
      if (a) { delete db.accounts[a.id]; for (const k of Object.keys(db.sessions)) if (db.sessions[k].id === a.id) delete db.sessions[k]; P("a:" + a.id, "sessions"); }
      for (const k of Object.keys(db.names)) if (db.names[k] === t) delete db.names[k];
      const hadFriends = db.friends[t] || [], hadReq = [];
      delete db.friends[t]; delete db.reqs[t];
      for (const k of Object.keys(db.friends)) if (db.friends[k].includes(t)) db.friends[k] = db.friends[k].filter(x => x !== t);
      for (const k of Object.keys(db.reqs)) if (db.reqs[k].includes(t)) { db.reqs[k] = db.reqs[k].filter(x => x !== t); hadReq.push(k); }
      delete db.profiles[t]; delete db.guests[t]; delete db.admins[t]; delete db.verified[t];
      delete admSess[t]; delete admPend[t]; delete invites[t];
      P("names", "friends", "reqs", "profiles", "guests", "admins", "verified");
      for (const sid of Object.keys(sids)) if (sids[sid].code === t) delete sids[sid];
      delete live[t];
      hadFriends.forEach(pushFriends); hadReq.forEach(pushReqs);
      return [200, { ok: true, name }];
    },
    "POST /api/admin/gift": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const t = b.code, n = Math.floor(Number(b.amount)), kind = b.kind;
      if (!codeOk(t) || !isOnline(t)) return [404, { error: "Esse jogador não está mais na partida" }];
      if (!["vb", "xp", "pxp"].includes(kind)) return [400, { error: "Tipo inválido" }];
      if (!(n >= 1 && n <= 1e6)) return [400, { error: "Quantidade de 1 a 1.000.000" }];
      emit(t, { t: "gift", kind, n });
      return [200, { ok: true, name: nameOf(t) }];
    },
    "POST /api/admin/grant": async b => {
      const c = mpMe(b); if (!c) return [401, { error: "Sem conexão" }];
      if (!admOk(c)) return [403, { error: "Painel não confirmado. Abra de novo.", reset: true }];
      if (!admSess[c].owner) return [403, { error: "Só o dono pode fazer isso" }];
      const t = b.code;
      if (!codeOk(t) || !isOnline(t)) return [404, { error: "Esse jogador não está mais na partida" }];
      if (isAdm(t)) return [409, { error: "Esse jogador já é ADM" }];
      db.admins[t] = { at: Date.now(), by: c }; P("admins");
      emit(t, { t: "adm", on: true }); emit(t, { t: "toast", msg: "Você recebeu a tag ADM" });
      const p = parties[partyOf[t]]; if (p) pushParty(p);
      return [200, { ok: true, name: nameOf(t) }];
    }
  };
  Object.assign(routes, adminRoutes);

  /* stream de eventos em tempo real (SSE) */
  function openStream(u) {
    const sid = u.searchParams.get("sid"), s = sids[sid];
    if (!s || s.res) return new Response(null, { status: 401 });
    const c = s.code, l = live[c]; let ping;
    const stream = new ReadableStream({
      start(ctrl) {
        s.res = { write: d => ctrl.enqueue(enc.encode(d)) };
        l.sids.add(sid);
        s.res.write("retry: 4000\n\n");
        emit(c, { t: "init", adm: isAdm(c), ver: !!db.verified[c], me: { code: c, name: nameOf(c) }, friends: friendList(c), reqs: reqList(c), party: partyView(c) });
        presence(c); const pp = parties[partyOf[c]]; if (pp) pushParty(pp);
        ping = setInterval(() => { try { s.res.write(": ping\n\n"); } catch (e) {} }, 20000);
      },
      cancel() {
        clearInterval(ping); l.sids.delete(sid); delete sids[sid]; s.res = null; if (l.sids.size) return;
        presence(c); const p = parties[partyOf[c]]; if (p) pushParty(p);
        setTimeout(() => { if (!isOnline(c)) leaveParty(c); }, 15000);
      }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  }

  async function body(req) {
    try {
      const t = await req.text(); if (t.length > 2e6) return null;
      const j = JSON.parse(t || "{}"); return j && typeof j === "object" ? j : null;
    } catch (e) { return null; }
  }

  async function handle(req) {
    await ready;
    const u = new URL(req.url), key = req.method + " " + u.pathname;
    if (key === "GET /api/mp/stream") return openStream(u);
    const h = routes[key]; if (!h) return send(404, { error: "Não encontrado" });
    const b = req.method === "POST" ? await body(req) : {};
    if (b === null) return send(400, { error: "Requisição inválida" });
    try { const [c, o] = await h(b, req); await flush(); return send(c, o); }
    catch (e) { return send(500, { error: "Erro no servidor" }); }
  }

  const ready = (async () => {
    for (const [k, v] of await storage.list()) {
      if (k.startsWith("a:")) db.accounts[k.slice(2)] = v;
      else if (k !== "accounts" && k in db) db[k] = v;
    }
    const old = Date.now() - SESSION_MS;
    for (const h of Object.keys(db.sessions)) if (db.sessions[h].at < old) { delete db.sessions[h]; P("sessions"); }
    await flush();
  })();

  return { handle, ready };
}

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = createGame(ctx, env);
    ctx.blockConcurrencyWhile(() => this.app.ready);
  }
  fetch(request) { return this.app.handle(request); }
}

/* Páginas públicas exigidas pelo Google (política de privacidade e termos) */
const CONTACT = ""; /* opcional: coloque seu e-mail entre as aspas para aparecer nas páginas */
const page = (title, body) => new Response(
  `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Fortiniaud</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:20px;line-height:1.6;color:#222;background:#fff}h1{font-size:26px}h2{font-size:18px;margin-top:26px}a{color:#3b1a8f}@media(prefers-color-scheme:dark){body{background:#14121f;color:#eee}a{color:#ffd23f}}</style></head><body><h1>${title}</h1>${body}<p><small>Última atualização: 18/11/2026</small></p></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
const contactLine = CONTACT ? `Fale com o responsável pelo jogo em <a href="mailto:${CONTACT}">${CONTACT}</a>.` : "Fale com o responsável pelo jogo, pelos canais em que você recebeu o link.";
const PRIVACY = `<p>O Fortiniaud é um jogo online. Esta página explica quais dados ele usa e por quê.</p>
<h2>Dados que guardamos</h2><ul><li>Nome de jogador e código de amigo.</li><li>Senha da conta virtual, guardada de forma criptografada (nunca em texto).</li><li>E-mail do Google, se você informar (para recuperar a senha) ou entrar com o Google. Do Google usamos só o e-mail e o identificador da conta.</li><li>Progresso do jogo: nível, itens, V-Bucks, configurações.</li><li>Lista de amigos, pedidos de amizade e grupos.</li></ul>
<h2>Para que usamos</h2><p>Somente para o jogo funcionar: entrar na conta, salvar seu progresso, mostrar amigos e grupos e recuperar a senha. Não vendemos seus dados e não os usamos para anúncios.</p>
<h2>Com quem compartilhamos</h2><p>Com ninguém, além dos serviços que fazem o jogo funcionar: o Google (para o login) e a Cloudflare (hospedagem e armazenamento).</p>
<h2>Seus direitos</h2><p>Você pode pedir a exclusão da sua conta e dos seus dados a qualquer momento. ${contactLine}</p>`;
const TERMS = `<p>Ao jogar o Fortiniaud você concorda com estas regras simples.</p>
<h2>Uso do jogo</h2><ul><li>Seja respeitoso com os outros jogadores. Nomes ofensivos podem ser removidos.</li><li>Não tente burlar, invadir ou atrapalhar o jogo.</li><li>Você é responsável por manter sua senha em segurança.</li></ul>
<h2>Itens e V-Bucks</h2><p>V-Bucks e itens são virtuais, só valem dentro do jogo e não têm valor em dinheiro.</p>
<h2>Disponibilidade</h2><p>O jogo é oferecido como está, pode mudar ou ficar fora do ar, e o progresso pode ser apagado em caso de problema técnico ou violação das regras.</p>
<h2>Contato</h2><p>${contactLine}</p>`;

/* /api/* vai para o Durable Object (contas, saves, multiplayer); o resto devolve o jogo (index.html). */
export default {
  fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p.startsWith("/api/")) return env.GAME.get(env.GAME.idFromName("main")).fetch(request);
    if (p === "/" || p === "/index.html" || p === "/fortiniaud.html")
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } });
    if (p === "/privacidade") return page("Política de Privacidade", PRIVACY);
    if (p === "/termos") return page("Termos de Serviço", TERMS);
    return new Response("Not found", { status: 404 });
  }
};
