// DRAW BEFORE I ANSWER — authoritative 2-player server (static files + WebSocket)
// Same setup as TRICK OR CUFF: one Node process, rooms kept in memory, no database.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------------- settings (.env file is optional) ----------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_QUESTION = 300;
const MAX_DRAWING = 1_500_000; // characters of PNG data URL

// ---------------- static files ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------- AI (server only; key never reaches the browser) ----------------
const SYSTEM = 'You answer questions inside a playful two-player drawing game. Answer in 1-3 short, friendly, clear sentences. No markdown.';
const DEMO = [
  'Honestly? It depends on the snacks involved.',
  'The short answer is yes. The long answer is also yes, but slower.',
  'Scientists are still arguing about it, but a cat would say no.',
  'Probably a duck. It is usually a duck.',
  'Ask again after a nap and the answer gets clearer.',
];
const demoAnswer = q => DEMO[[...q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % DEMO.length];
const aiMode = () => (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'demo');

async function askAI(question) {
  const mode = aiMode();
  if (mode === 'demo') return { text: demoAnswer(question), demo: true };
  try {
    const ctrl = AbortSignal.timeout(25000);
    if (mode === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 250, system: SYSTEM, messages: [{ role: 'user', content: question }] }),
      });
      if (!r.ok) throw new Error('Anthropic ' + r.status + ' ' + (await r.text()));
      const d = await r.json();
      const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) throw new Error('empty answer');
      return { text, demo: false };
    }
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ctrl,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', max_tokens: 250, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }] }),
    });
    if (!r.ok) throw new Error('OpenAI ' + r.status + ' ' + (await r.text()));
    const d = await r.json();
    const text = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    if (!text) throw new Error('empty answer');
    return { text, demo: false };
  } catch (err) {
    console.error('AI request failed:', err.message);
    return { text: '(The AI request failed, so here is a demo answer.) ' + demoAnswer(question), demo: true };
  }
}

// ---------------- rooms ----------------
// stage: waiting → asking → drawing → revealing → reveal → (play again) asking …
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() { let c; do { c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(c)); return c; }
const newRound = () => ({ 1: {}, 2: {} }); // per slot: { question, drawing, answer, demo }
const other = slot => (slot === 1 ? 2 : 1);

// What one player is allowed to see right now. Built separately for each player.
function viewFor(room, p) {
  const mine = room.subs[p.slot], theirs = room.subs[other(p.slot)];
  const partner = [...room.players.values()].find(q => q.slot !== p.slot);
  const questionsOpen = room.stage === 'drawing' || room.stage === 'revealing' || room.stage === 'reveal';
  return {
    t: 'state', code: room.code, stage: room.stage, round: room.round, slot: p.slot,
    partnerJoined: !!partner, partnerOnline: !!(partner && partner.connected),
    myQuestionDone: !!mine.question, partnerQuestionDone: !!theirs.question,
    myDrawingDone: !!mine.drawing, partnerDrawingDone: !!theirs.drawing,
    partnerQuestion: questionsOpen ? theirs.question : null, // never before both have asked
    reveal: room.stage === 'reveal' ? {                     // drawings only at the reveal
      myQuestion: mine.question, drawingForMe: theirs.drawing, answerForMe: mine.answer,
      partnerQuestion: theirs.question, myDrawing: mine.drawing, answerForPartner: theirs.answer,
      demo: !!(mine.demo || theirs.demo),
    } : null,
  };
}
function pushState(room) {
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(viewFor(room, p)));
}
const fail = (ws, code, message) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'error', code, message }));

async function finishRound(room) {
  room.stage = 'revealing';
  pushState(room);
  const round = room.round;
  const [a1, a2] = await Promise.all([askAI(room.subs[1].question), askAI(room.subs[2].question)]);
  if (!rooms.has(room.code) || room.round !== round) return; // room gone or moved on
  Object.assign(room.subs[1], { answer: a1.text, demo: a1.demo });
  Object.assign(room.subs[2], { answer: a2.text, demo: a2.demo });
  room.stage = 'reveal';
  pushState(room);
}

// ---------------- sockets ----------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') return handleJoin(ws, m);
    const p = ws.player, room = ws.room;
    if (!p || !room || p.ws !== ws) return;
    const mine = room.subs[p.slot];

    if (m.t === 'question') {
      const q = String(m.text || '').trim();
      if (room.stage !== 'asking' || mine.question) return pushState(room); // late or duplicate
      if (!q) return fail(ws, 'empty', 'Type a question first.');
      if (q.length > MAX_QUESTION) return fail(ws, 'long', 'Keep it under 300 characters.');
      mine.question = q;
      if (room.subs[1].question && room.subs[2].question) room.stage = 'drawing';
      return pushState(room);
    }
    if (m.t === 'drawing') {
      const d = String(m.png || '');
      if (room.stage !== 'drawing' || mine.drawing) return pushState(room); // late or duplicate
      if (!d.startsWith('data:image/png;base64,') || d.length > MAX_DRAWING) return fail(ws, 'bad', 'That drawing could not be sent.');
      mine.drawing = d;
      if (room.subs[1].drawing && room.subs[2].drawing) return finishRound(room); // AI runs only now
      return pushState(room);
    }
    if (m.t === 'again') {
      if (room.stage !== 'reveal') return pushState(room); // second click is a no-op
      room.round++; room.subs = newRound(); room.stage = 'asking';
      return pushState(room);
    }
  });
  ws.on('close', () => {
    const p = ws.player, room = ws.room;
    if (!p || !room || p.ws !== ws) return;
    p.ws = null; p.connected = false; p.lastSeen = Date.now();
    pushState(room); // partner sees "disconnected"; the slot stays reserved
  });
});

function handleJoin(ws, m) {
  let room;
  if (m.create) {
    room = { code: newCode(), stage: 'waiting', round: 1, players: new Map(), subs: newRound() };
    rooms.set(room.code, room);
  } else {
    room = rooms.get(String(m.code || '').toUpperCase().replace(/[^A-Z]/g, ''));
    if (!room) return fail(ws, 'noroom', 'Room not found. Check the code.');
  }
  // Reconnect: the secret token gets you back your own slot (and nobody else's).
  let p = m.token ? [...room.players.values()].find(q => q.token === m.token) : null;
  if (p) { if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} } }
  else {
    const taken = new Set([...room.players.values()].map(q => q.slot));
    const slot = [1, 2].find(s => !taken.has(s));
    if (slot) {
      p = { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), slot, ws: null, connected: false, lastSeen: Date.now() };
      room.players.set(p.id, p);
    } else {
      // Both seats are taken. If one of them is offline (tab closed, phone locked, a different
      // browser or device), this visitor takes that seat over, keeping whatever it already submitted,
      // so closing a tab never locks a player out of their own room.
      const seat = [...room.players.values()].filter(q => !q.connected).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!seat) return fail(ws, 'full', 'This room already has two players online.');
      seat.token = crypto.randomBytes(16).toString('hex'); // the old saved token stops working
      p = seat;
    }
  }
  p.ws = ws; p.connected = true; p.lastSeen = Date.now();
  ws.player = p; ws.room = room;
  if (room.stage === 'waiting' && room.players.size === 2) room.stage = 'asking';
  ws.send(JSON.stringify({ t: 'joined', code: room.code, token: p.token }));
  pushState(room);
}

// keep-alive pings, and forget rooms nobody has touched for 2 hours
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} }
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const room of rooms.values()) {
    if ([...room.players.values()].every(p => !p.connected && p.lastSeen < cutoff)) rooms.delete(room.code);
  }
}, 5000); // notice dropped connections within ~10 s so their seat frees up quickly

server.listen(PORT, () => console.log(`DRAW BEFORE I ANSWER running on http://localhost:${PORT}  (AI: ${aiMode()})`));
