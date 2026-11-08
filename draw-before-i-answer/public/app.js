// DRAW BEFORE I ANSWER — browser client (WebSocket connection, screens, drawing canvas)
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    sget: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    sdel: k => { try { sessionStorage.removeItem(k); } catch {} },
  };
  const tokenKey = code => 'dbia:token:' + code;
  const VIEWS = ['home', 'waiting', 'ask', 'draw', 'revealing', 'reveal', 'connecting', 'fatal'];
  function show(view) { for (const v of VIEWS) $(v).hidden = v !== view; $('bar').hidden = view === 'home'; }
  const setError = msg => { $('error').textContent = msg || ''; };

  // ---------------- connection ----------------
  let ws = null, code = null, state = null, retry = 0, dead = false;

  function connect(join) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => { retry = 0; sock.send(JSON.stringify(join())); };
    sock.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'joined') {
        code = m.code;
        store.set(tokenKey(code), m.token); // anonymous session token: lets you reconnect to your own slot
        if (new URLSearchParams(location.search).get('room') !== code) history.replaceState(null, '', '/?room=' + code);
      } else if (m.t === 'state') {
        setError(''); render(m);
      } else if (m.t === 'error') {
        if (['noroom', 'full'].includes(m.code)) return fatal(m.message);
        setError(m.message); unlockButtons();
      }
    };
    sock.onclose = () => {
      if (dead || !code || sock !== ws) return; // an older, replaced connection: ignore
      $('codeChip').textContent = code + ' · reconnecting';
      setTimeout(() => connect(rejoin), Math.min(5000, 500 * 2 ** retry++)); // back off, then try again
    };
  }
  const rejoin = () => ({ t: 'join', code, token: store.get(tokenKey(code)) });
  const send = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else setError('Reconnecting… try again in a second.'); };
  function fatal(msg) { dead = true; try { ws.close(); } catch {} $('fatalMsg').textContent = msg; show('fatal'); }

  // ---------------- home ----------------
  $('createBtn').onclick = () => { $('createBtn').disabled = true; show('connecting'); connect(() => ({ t: 'join', create: true })); };
  $('showJoinBtn').onclick = () => { $('joinForm').hidden = false; $('createBtn').hidden = $('showJoinBtn').hidden = true; $('joinInput').focus(); };
  $('backBtn').onclick = () => { $('joinForm').hidden = true; $('createBtn').hidden = $('showJoinBtn').hidden = false; };
  $('joinForm').onsubmit = e => {
    e.preventDefault();
    const raw = $('joinInput').value.trim();
    const m = raw.match(/room=([A-Za-z]+)/);
    const c = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z]/g, '');
    if (!c) return ($('homeError').textContent = 'Enter a room code or link.');
    location.href = '/?room=' + c;
  };

  // ---------------- screens ----------------
  let shownRound = null;
  function render(s) {
    const newRound = s.round !== shownRound;
    state = s; shownRound = s.round;
    $('codeChip').textContent = s.code;
    $('offline').hidden = !(s.partnerJoined && !s.partnerOnline && s.stage !== 'waiting');
    unlockButtons();

    if (s.stage === 'waiting') {
      const link = `${location.origin}/?room=${s.code}`;
      $('bigCode').textContent = s.code; $('shareLink').textContent = link;
      return show('waiting');
    }
    if (s.stage === 'asking') {
      if (newRound) { $('askInput').value = ''; $('askBtn').disabled = true; }
      $('askForm').hidden = s.myQuestionDone; $('askWait').hidden = !s.myQuestionDone;
      return show('ask');
    }
    if (s.stage === 'drawing') {
      $('theirQuestion').textContent = s.partnerQuestion;
      canvasForRound(s.code, s.round);
      setLocked(s.myDrawingDone);
      $('tools').hidden = s.myDrawingDone; $('drawWait').hidden = !s.myDrawingDone;
      return show('draw');
    }
    if (s.stage === 'revealing') return show('revealing');
    if (s.stage === 'reveal' && s.reveal) {
      const r = s.reveal;
      $('demoBanner').hidden = !r.demo;
      for (const el of document.querySelectorAll('.ai-label')) el.textContent = r.demo ? 'Demo answer' : 'AI answer';
      $('rMyQ').textContent = r.myQuestion; $('rMyA').textContent = r.answerForMe;
      $('rTheirQ').textContent = r.partnerQuestion; $('rTheirA').textContent = r.answerForPartner;
      $('rDrawForMe').src = r.drawingForMe; $('rDrawForMe').alt = 'Drawing answering: ' + r.myQuestion;
      $('rMyDraw').src = r.myDrawing; $('rMyDraw').alt = 'Your drawing answering: ' + r.partnerQuestion;
      return show('reveal');
    }
  }
  function unlockButtons() {
    $('askBtn').disabled = !$('askInput').value.trim();
    $('submitDrawBtn').disabled = !hasInk; $('submitDrawBtn').textContent = 'Submit Drawing';
    $('againBtn').disabled = false;
  }

  // waiting room: copy / share link
  $('copyBtn').onclick = async () => {
    const link = $('shareLink').textContent;
    try {
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) await navigator.share({ title: 'Draw Before I Answer', url: link });
      else { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Link copied!'; setTimeout(() => ($('copyBtn').textContent = 'Copy invite link'), 2000); }
    } catch {}
  };

  // ask
  $('askInput').oninput = () => { $('askBtn').disabled = !$('askInput').value.trim(); };
  $('askForm').onsubmit = e => {
    e.preventDefault();
    const text = $('askInput').value.trim();
    if (!text) return;
    $('askBtn').disabled = true; // the server also ignores a second question
    send({ t: 'question', text });
  };

  // play again
  $('againBtn').onclick = () => { $('againBtn').disabled = true; send({ t: 'again' }); };

  // ---------------- drawing canvas (Pointer Events: mouse + finger) ----------------
  const canvas = $('canvas'), ctx = canvas.getContext('2d'), SIZE = 800;
  let tool = 'pen', hasInk = false, locked = false, drawing = false, last = null, draftKey = null;

  function fillWhite() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE); }
  function canvasForRound(c, round) {
    const key = `dbia:draft:${c}:${round}`;
    if (key === draftKey) return;
    draftKey = key; fillWhite(); hasInk = false; setTool('pen');
    const saved = store.sget(key); // a refresh doesn't wipe a drawing in progress
    if (saved) { const img = new Image(); img.onload = () => { ctx.drawImage(img, 0, 0, SIZE, SIZE); hasInk = true; unlockButtons(); }; img.src = saved; }
  }
  function setLocked(v) { locked = v; canvas.classList.toggle('locked', v); }
  function setTool(t) { tool = t; $('penBtn').classList.toggle('on', t === 'pen'); $('eraserBtn').classList.toggle('on', t === 'eraser'); canvas.classList.toggle('eraser', t === 'eraser'); }
  function point(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * SIZE, y: (e.clientY - r.top) / r.height * SIZE }; }
  function strokeTo(p) {
    const from = last || p;
    ctx.strokeStyle = tool === 'pen' ? '#000' : '#fff';
    ctx.lineWidth = tool === 'pen' ? 8 : 48;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke(); // +0.01 so a tap leaves a dot
    last = p;
  }
  canvas.addEventListener('pointerdown', e => {
    if (locked) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    drawing = true; last = null; strokeTo(point(e));
    if (tool === 'pen' && !hasInk) { hasInk = true; unlockButtons(); }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing || locked) return;
    e.preventDefault();
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) strokeTo(point(ev));
  });
  function endStroke() { if (!drawing) return; drawing = false; last = null; store.sset(draftKey, canvas.toDataURL('image/png')); }
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(t, endStroke);
  // stop the page from scrolling while drawing on phones (extra guard for iOS Safari)
  for (const t of ['touchstart', 'touchmove']) canvas.addEventListener(t, e => e.preventDefault(), { passive: false });

  $('penBtn').onclick = () => setTool('pen');
  $('eraserBtn').onclick = () => setTool('eraser');
  $('clearBtn').onclick = () => { fillWhite(); hasInk = false; store.sdel(draftKey); unlockButtons(); };
  $('submitDrawBtn').onclick = () => {
    if (!hasInk) return;
    $('submitDrawBtn').disabled = true; $('submitDrawBtn').textContent = 'Sending…';
    send({ t: 'drawing', png: canvas.toDataURL('image/png') });
  };

  // ---------------- start ----------------
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    code = roomParam.toUpperCase().replace(/[^A-Z]/g, '');
    show('connecting');
    connect(rejoin); // with a saved token you get your slot back; without one you take the free slot
  } else show('home');

  // phones pause background tabs: reconnect right away when the page comes back
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && code && !dead && (!ws || ws.readyState > 1)) connect(rejoin);
  });
})();
