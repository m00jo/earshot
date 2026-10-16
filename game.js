'use strict';

// Earshot: one player hosts (their browser holds the game state), friends join
// over WebRTC via PeerJS. Each round a DJ pastes a YouTube link, everyone hears
// it with the picture covered, and guesses go in chat. First to WIN_SCORE wins.

const WIN_SCORE = 10;
const CHAT_KEEP = 80;
const PEER_PREFIX = 'earshot-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const $ = (sel) => document.querySelector(sel);

let peer = null;
let myId = null;
let roomCode = null;
let isHost = false;
let hostConn = null;   // client: connection to the host
let view = null;       // latest public state from the host
let mySecret = null;   // DJ only: the answer they submitted

// ---------- small helpers ----------

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('earshot-' + key);
    localStorage.setItem('earshot-' + key, value);
  } catch (e) { return null; }
}

function clean(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fatal(text) {
  $('#fatal-text').textContent = text;
  $('#fatal').hidden = false;
  stopVideo();
}

// ---------- answer matching ----------

function norm(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

// "Artist - Title" also accepts just the title.
function targets(answer) {
  const list = [answer];
  const parts = answer.split(/\s+[-–—|]\s+/);
  if (parts.length > 1) list.push(parts.slice(1).join(' '));
  return list.map(norm).filter(Boolean);
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function isCorrect(guess, answer) {
  const g = norm(guess);
  if (!g) return false;
  return targets(answer).some((a) =>
    g === a ||
    (' ' + g + ' ').includes(' ' + a + ' ') ||
    1 - levenshtein(g, a) / Math.max(g.length, a.length) >= 0.8);
}

// ---------- YouTube ----------

function parseVideo(link) {
  link = link.trim();
  if (/^[\w-]{11}$/.test(link)) return { id: link, start: null };
  let url;
  try { url = new URL(link.includes('://') ? link : 'https://' + link); } catch (e) { return null; }
  let id = null;
  if (url.hostname.endsWith('youtu.be')) id = url.pathname.slice(1, 12);
  else if (url.searchParams.get('v')) id = url.searchParams.get('v');
  else {
    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (m) id = m[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get('t') || url.searchParams.get('start');
  let start = null;
  if (t) {
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (m) start = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  return { id, start };
}

function cleanTitle(t) {
  return t
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\s*[-|]?\s*official\s+(music\s+|lyric\s+)?video\b.*$/i, '')
    .replace(/\s+\|.*$/, '')
    .trim();
}

let yt = null;
let ytApiReady = false;
let ytReady = false;
let pending = null;  // play request that arrived before the player was ready
let current = null;  // { id, start } of the clip that should be playing

window.onYouTubeIframeAPIReady = () => {
  ytApiReady = true;
  if (!$('#game').hidden) createPlayer();
};

function createPlayer() {
  if (yt || !ytApiReady) return;
  yt = new YT.Player('yt', {
    width: '100%',
    height: '100%',
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3 },
    events: {
      onReady() {
        ytReady = true;
        yt.setVolume(+$('#volume').value);
        if (pending) playVideo(pending.id, pending.start);
      },
      onError() {
        notice = "⚠️ This video can't be played here (embedding may be disabled).";
        render();
        if (view && view.phase === 'playing' && view.djId === myId) send({ t: 'error' });
      },
    },
  });
}

function playVideo(id, start) {
  current = { id, start };
  if (!ytReady) { pending = current; return; }
  pending = null;
  yt.loadVideoById({ videoId: id, startSeconds: start });
}

function stopVideo() {
  current = pending = null;
  if (ytReady) yt.stopVideo();
}

// ---------- networking ----------

// Every action, including the host's own, goes through handleMessage on the host.
function send(msg) {
  if (isHost) handleMessage(myId, msg);
  else if (hostConn && hostConn.open) hostConn.send(msg);
}

// Host -> everyone (including itself).
function sendAll(msg) {
  for (const conn of conns.values()) if (conn.open) conn.send(msg);
  onHostMessage(msg);
}

function onHostMessage(m) {
  if (m.t === 'state') {
    if (view && view.phase !== m.s.phase) notice = null;
    view = m.s;
    render();
  } else if (m.t === 'play') {
    playVideo(m.videoId, m.start);
  } else if (m.t === 'stop') {
    stopVideo();
  }
}

function createRoom(name) {
  isHost = true;
  roomCode = randomCode();
  peer = new Peer(PEER_PREFIX + roomCode);
  peer.on('open', (id) => {
    myId = id;
    S.players.push({ id, name, score: 0 });
    sys(`${name} created the room. Share the invite link!`);
    enterGame();
    broadcast();
  });
  peer.on('connection', (conn) => {
    conns.set(conn.peer, conn);
    conn.on('data', (msg) => handleMessage(conn.peer, msg));
    conn.on('close', () => playerLeft(conn.peer));
    conn.on('error', () => playerLeft(conn.peer));
  });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && !myId) {
      peer.destroy();
      S.players = [];
      createRoom(name);
    } else if (!myId) {
      landingError('Could not create a room: ' + err.type);
    }
  });
}

function joinRoom(code, name) {
  roomCode = code;
  peer = new Peer();
  peer.on('open', (id) => {
    myId = id;
    hostConn = peer.connect(PEER_PREFIX + code, { reliable: true });
    hostConn.on('open', () => {
      hostConn.send({ t: 'join', name });
      enterGame();
    });
    hostConn.on('data', onHostMessage);
    hostConn.on('close', () => fatal('The host left, so the room is closed.'));
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') landingError(`No room called ${code}. Check the code?`);
    else if (!view) landingError('Could not connect: ' + err.type);
  });
}

// ---------- host: game state ----------

const conns = new Map();  // peerId -> DataConnection
const S = { phase: 'lobby', players: [], djId: null, round: null, chat: [], winnerId: null };
let msgSeq = 0;

const playerById = (id) => S.players.find((p) => p.id === id);

function sys(text, kind = 'sys') {
  S.chat.push({ id: ++msgSeq, kind, text });
  if (S.chat.length > CHAT_KEEP) S.chat.shift();
}

function publicState() {
  const r = S.round;
  const hide = S.phase === 'playing';
  return {
    phase: S.phase,
    players: S.players,
    djId: S.djId,
    winnerId: S.winnerId,
    chat: S.chat,
    round: r && { answer: hide ? null : r.answer, winnerId: r.winnerId },
  };
}

function broadcast() {
  sendAll({ t: 'state', s: publicState() });
}

function playMsg() {
  const r = S.round;
  return { t: 'play', videoId: r.videoId, start: r.start + (Date.now() - r.startedAt) / 1000 };
}

function nextDj() {
  const i = S.players.findIndex((p) => p.id === S.djId);
  return S.players[(i + 1) % S.players.length].id;
}

function newPicking(djId) {
  S.phase = 'picking';
  S.round = null;
  S.djId = djId;
  sendAll({ t: 'stop' });
  sys(`🎧 ${playerById(djId).name} is the DJ — picking a video…`);
}

function handleMessage(from, m) {
  if (!m || typeof m !== 'object') return;
  const p = playerById(from);

  if (m.t === 'join') {
    if (p) return;
    const name = clean(m.name, 20) || 'Player';
    S.players.push({ id: from, name, score: 0 });
    sys(`${name} joined.`);
    broadcast();
    if (S.phase === 'playing' || S.phase === 'reveal' || S.phase === 'over') {
      if (S.round) conns.get(from)?.send(playMsg());
    }
    return;
  }
  if (!p) return;

  switch (m.t) {
    case 'chat':
      onChat(p, clean(m.text, 200));
      break;
    case 'start':
      if (from === myId && S.phase === 'lobby' && S.players.length >= 2) {
        newPicking(playerById(S.djId) ? S.djId : S.players[0].id);
      }
      break;
    case 'submit':
      if (S.phase === 'picking' && from === S.djId) startRound(m);
      break;
    case 'skip':
      if (S.phase === 'playing' && from === S.djId) reveal(null);
      break;
    case 'award': {
      const target = playerById(m.playerId);
      if (S.phase === 'playing' && from === S.djId && target && target.id !== S.djId) reveal(target);
      break;
    }
    case 'pass':
      // The DJ hands off when they're done with the song; the host can too, in case the DJ goes quiet.
      if (S.phase === 'reveal' && (from === S.djId || from === myId)) newPicking(nextDj());
      break;
    case 'error':
      if (S.phase === 'playing' && from === S.djId) {
        sys("⚠️ That video can't be embedded. DJ, pick another one.");
        newPicking(S.djId);
      }
      break;
    case 'restart':
      if (from === myId && S.phase === 'over') {
        S.players.forEach((pl) => { pl.score = 0; });
        S.winnerId = null;
        sys('New game!');
        newPicking(nextDj());
      }
      break;
    default:
      return;
  }
  broadcast();
}

function onChat(p, text) {
  if (!text) return;
  if (S.phase === 'playing') {
    if (p.id !== S.djId && isCorrect(text, S.round.answer)) return reveal(p);
    if (p.id === S.djId && isCorrect(text, S.round.answer)) return; // don't let the DJ spoil it
  }
  S.chat.push({ id: ++msgSeq, kind: 'chat', from: p.id, name: p.name, text, guess: S.phase === 'playing' });
  if (S.chat.length > CHAT_KEEP) S.chat.shift();
}

function startRound(m) {
  const videoId = String(m.videoId || '');
  const answer = clean(m.answer, 120);
  if (!/^[\w-]{11}$/.test(videoId) || !answer) return;
  S.round = {
    videoId,
    answer,
    start: Math.max(0, Math.floor(+m.start || 0)),
    startedAt: Date.now(),
    winnerId: null,
  };
  S.phase = 'playing';
  sys('🎵 Listen up! Type your guesses in chat.');
  sendAll(playMsg());
}

function reveal(winner) {
  const r = S.round;
  r.winnerId = winner ? winner.id : null;
  if (winner) {
    winner.score++;
    sys(`🎉 ${winner.name} got it! It was “${r.answer}”.`, 'win');
  } else {
    sys(`Nobody got it. It was “${r.answer}”.`);
  }
  if (winner && winner.score >= WIN_SCORE) {
    S.phase = 'over';
    S.winnerId = winner.id;
    sys(`🏆 ${winner.name} wins the game!`, 'win');
    return;
  }
  S.phase = 'reveal';  // the video keeps playing until the DJ passes
}

function playerLeft(id) {
  conns.delete(id);
  const i = S.players.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = S.players.splice(i, 1);
  sys(`${p.name} left.`);
  if (S.phase !== 'lobby' && S.players.length < 2) {
    S.phase = 'lobby';
    S.round = null;
    sendAll({ t: 'stop' });
    sys('Waiting for more players…');
  } else if (id === S.djId && (S.phase === 'picking' || S.phase === 'playing' || S.phase === 'reveal')) {
    newPicking(S.players[i % S.players.length].id);
  }
  broadcast();
}

// ---------- UI ----------

let notice = null;  // local-only message shown on the cover

function landingError(text) {
  $('#landing-error').textContent = text;
  $('#create').disabled = $('#join').disabled = false;
}

function enterGame() {
  $('#landing').hidden = true;
  $('#game').hidden = false;
  $('#room-code').textContent = roomCode;
  history.replaceState(null, '', '?room=' + roomCode);
  createPlayer();
  $('#chat-input').focus();
}

function render() {
  if (!view) return;
  const dj = view.players.find((p) => p.id === view.djId);
  const amDj = view.djId === myId;
  const phase = view.phase;

  // Status line + cover
  let status = '', icon = '', text = '';
  if (phase === 'lobby') {
    status = view.players.length < 2 ? 'Waiting for friends to join…' : `${view.players.length} players ready`;
    icon = '👂';
    text = isHost ? 'Start the game when everyone is here.' : 'Waiting for the host to start…';
  } else if (phase === 'picking') {
    status = amDj ? 'Your turn to DJ!' : `${dj?.name ?? 'The DJ'} is picking a video…`;
    icon = '🎧';
    text = amDj ? 'Paste a YouTube link below.' : 'Get ready to listen…';
  } else if (phase === 'playing') {
    status = amDj ? 'Your clip is playing. No guessing for you!' : 'What is this video? Guess in chat!';
    icon = '🔊';
    text = 'Listen closely…';
  } else if (phase === 'reveal' || phase === 'over') {
    const w = view.players.find((p) => p.id === view.round?.winnerId);
    status = phase === 'over'
      ? `🏆 ${view.players.find((p) => p.id === view.winnerId)?.name ?? 'Someone'} wins!`
      : (w ? `🎉 ${w.name} got it!` : 'Nobody got it.') +
        (amDj ? '' : ` Waiting for ${dj?.name ?? 'the DJ'} to pass…`);
  }
  $('#status').textContent = status;

  const showVideo = (phase === 'reveal' || phase === 'over') && view.round && !notice;
  $('#cover').hidden = !!showVideo;
  $('#cover').classList.toggle('listening', phase === 'playing');
  $('#cover-icon').textContent = notice ? '⚠️' : icon;
  $('#cover-text').textContent = notice ? notice.replace(/^⚠️\s*/, '') : text;

  // DJ panels
  $('#dj-form').hidden = !(phase === 'picking' && amDj);
  $('#dj-controls').hidden = !(phase === 'playing' && amDj);
  $('#dj-secret').textContent = mySecret ?? '';
  if (phase !== 'picking' || !amDj) $('#dj-error').textContent = '';

  // Pass to the next DJ (the DJ, or the host as a fallback)
  const djIndex = view.players.findIndex((p) => p.id === view.djId);
  const next = view.players[(djIndex + 1) % view.players.length];
  $('#pass').hidden = !(phase === 'reveal' && (amDj || isHost));
  $('#pass').textContent = next.id === myId ? 'Pass to me →' : `Pass to ${next.name} →`;

  // Host buttons
  $('#start').hidden = !(isHost && phase === 'lobby');
  $('#start').disabled = view.players.length < 2;
  $('#restart').hidden = !(isHost && phase === 'over');

  $('#chat-input').placeholder = phase === 'playing' && !amDj ? 'Type your guess…' : 'Say something…';

  // Scores
  const scores = $('#scores');
  scores.replaceChildren(...view.players.map((p) => {
    const li = el('li');
    const tags = (p.id === view.djId && phase !== 'lobby' ? ' 🎧' : '') + (p.id === myId ? ' (you)' : '');
    li.append(
      el('span', 'who' + (p.id === myId ? ' me' : ''), p.name + tags),
      el('span', 'pts', `${p.score} / ${WIN_SCORE}`),
    );
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = (100 * Math.min(p.score, WIN_SCORE) / WIN_SCORE) + '%';
    bar.append(fill);
    li.append(bar);
    return li;
  }));

  // Chat
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...view.chat.map((m) => {
    const li = el('li');
    if (m.kind !== 'chat') {
      li.className = 'sys' + (m.kind === 'win' ? ' win' : '');
      li.textContent = m.text;
      return li;
    }
    li.append(el('span', 'name', m.name + ':'), document.createTextNode(m.text));
    if (amDj && phase === 'playing' && m.guess && m.from !== myId && view.players.some((p) => p.id === m.from)) {
      const btn = el('button', 'award', '✓');
      btn.title = `Close enough — give ${m.name} the point`;
      btn.onclick = () => send({ t: 'award', playerId: m.from });
      li.append(btn);
    }
    return li;
  }));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------- wiring ----------

function wire() {
  const nameInput = $('#name');
  nameInput.value = store('name') || '';
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (roomParam) {
    $('#code').value = roomParam;
    $('#join').textContent = 'Join ' + roomParam;
  }

  function getName() {
    const name = clean(nameInput.value, 20);
    if (!name) { landingError('Enter your name first.'); nameInput.focus(); return null; }
    store('name', name);
    return name;
  }

  $('#create').onclick = () => {
    const name = getName();
    if (!name) return;
    $('#create').disabled = $('#join').disabled = true;
    $('#landing-error').textContent = 'Creating room…';
    createRoom(name);
  };
  $('#join').onclick = () => {
    const name = getName();
    const code = clean($('#code').value, 5).toUpperCase();
    if (!name) return;
    if (code.length !== 5) { landingError('Room codes are 5 characters.'); return; }
    $('#create').disabled = $('#join').disabled = true;
    $('#landing-error').textContent = 'Joining…';
    joinRoom(code, name);
  };
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') $('#join').click(); };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') (roomParam ? $('#join') : $('#create')).click(); };

  $('#copy').onclick = async () => {
    const link = location.origin + location.pathname + '?room=' + roomCode;
    try {
      await navigator.clipboard.writeText(link);
      $('#copy').textContent = 'Copied!';
    } catch (e) {
      prompt('Copy this invite link:', link);
    }
    setTimeout(() => { $('#copy').textContent = 'Copy invite link'; }, 1500);
  };

  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    if (input.value.trim()) send({ t: 'chat', text: input.value });
    input.value = '';
  };

  $('#start').onclick = () => send({ t: 'start' });
  $('#restart').onclick = () => send({ t: 'restart' });
  $('#skip').onclick = () => send({ t: 'skip' });
  $('#pass').onclick = () => send({ t: 'pass' });

  $('#replay').onclick = () => {
    if (!ytReady || !current) return;
    yt.seekTo(current.start, true);
    yt.playVideo();
  };
  $('#volume').oninput = (e) => { if (ytReady) yt.setVolume(+e.target.value); };

  // DJ form: parse the link, prefill the start time and the answer from the video title.
  let autoAnswer = '';
  $('#dj-link').oninput = async () => {
    const v = parseVideo($('#dj-link').value);
    $('#dj-error').textContent = '';
    if (!v) return;
    if (v.start != null) $('#dj-start').value = v.start;
    try {
      const res = await fetch('https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + v.id));
      if (!res.ok) return;
      const title = cleanTitle((await res.json()).title || '');
      const answer = $('#dj-answer');
      if (title && (!answer.value || answer.value === autoAnswer)) answer.value = autoAnswer = title;
    } catch (e) { /* no title prefill; the DJ types it */ }
  };
  $('#dj-form').onsubmit = (e) => {
    e.preventDefault();
    const v = parseVideo($('#dj-link').value);
    const answer = clean($('#dj-answer').value, 120);
    if (!v) { $('#dj-error').textContent = "That doesn't look like a YouTube link."; return; }
    if (!answer) { $('#dj-error').textContent = 'Type the answer players should guess.'; return; }
    mySecret = answer;
    send({ t: 'submit', videoId: v.id, answer, start: +$('#dj-start').value || 0 });
    $('#dj-link').value = $('#dj-answer').value = '';
    $('#dj-start').value = 0;
    autoAnswer = '';
  };
}

wire();
