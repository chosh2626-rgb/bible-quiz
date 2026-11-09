// 성경 퀴즈 대회 서버 (외부 패키지 없이 Node.js만으로 실행)
// 내 컴퓨터에서: node server.js  →  진행자 화면 http://localhost:3000/host
// 인터넷 서버(Render 등)에서: 환경변수 HOST_PASSWORD(진행자 비밀번호)를 꼭 정해 주세요.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { startTunnel } = require('./tunnel');

const PORT = Number(process.env.PORT) || 3000;
const AGES = ['30대 미만', '40대', '50대', '60대', '70대', '80대 이상'];
const Q_FILE = path.join(__dirname, 'questions.json');
const PUB = path.join(__dirname, 'public');
// 인터넷 서버(Render 등)에서 실행 중인지
const CLOUD = !!(process.env.RENDER || process.env.CLOUD);
const HOST_PASSWORD = String(process.env.HOST_PASSWORD || '');
const HOST_TOKEN = HOST_PASSWORD ? crypto.createHash('sha256').update('quiz-host:' + HOST_PASSWORD).digest('hex') : '';

// ---------------- 상태 ----------------
let questions = loadQuestions();
// 인터넷 주소(휴대폰 데이터 접속용) 상태
const net = { publicUrl: '', status: CLOUD ? 'cloud' : process.env.TUNNEL === '0' ? 'off' : 'starting', message: '' };
const players = new Map(); // pid -> { id, name, age, score, correct, totalTime, joinedAt }
const clients = new Set(); // SSE 연결 { res, pid, role }
const game = {
  phase: 'lobby', // lobby | question | reveal
  round: 0, // 문제를 시작할 때마다 1씩 증가
  qIndex: -1,
  q: null,
  startedAt: 0,
  limit: 20,
  timer: null,
  submissions: [], // { pid, choice, elapsed, correct, points }
  used: new Set(), // 이미 낸 문제 번호
  seen: new Map(), // pid -> 이 사람 휴대폰에 문제가 전달된 시각 (공정한 시간 측정용)
};
let version = 0; // 상태가 바뀔 때마다 1씩 증가 (주기적 확인 방식용)
let cache = null; // 마지막으로 만든 상태

function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(Q_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function validQuestion(q) {
  return (
    q && typeof q.text === 'string' && q.text.trim() &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every((o) => typeof o === 'string' && o.trim()) &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length
  );
}

// ---------------- 게임 진행 ----------------
function startQuestion(index) {
  const q = questions[index];
  if (!q) return false;
  clearTimeout(game.timer);
  game.phase = 'question';
  game.round += 1;
  game.qIndex = index;
  game.q = q;
  game.limit = Math.max(5, Math.min(300, Number(q.time) || 20));
  game.startedAt = Date.now();
  game.submissions = [];
  game.seen = new Map();
  game.used.add(index);
  game.timer = setTimeout(reveal, game.limit * 1000 + 500);
  broadcast(true);
  return true;
}

function reveal() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  game.phase = 'reveal';
  const limitMs = game.limit * 1000;
  for (const s of game.submissions) {
    s.correct = s.choice === game.q.answer;
    // 정답: 500~1000점 (빠를수록 높음), 오답: 0점
    s.points = s.correct ? 1000 - Math.round(500 * Math.min(1, s.elapsed / limitMs)) : 0;
    const p = players.get(s.pid);
    if (p && s.correct) {
      p.score += s.points;
      p.correct += 1;
      p.totalTime += s.elapsed;
    }
  }
  broadcast(true);
}

function goLobby() {
  clearTimeout(game.timer);
  if (game.phase === 'question') reveal();
  game.phase = 'lobby';
  broadcast(true);
}

function resetGame(clearPlayers) {
  clearTimeout(game.timer);
  Object.assign(game, { phase: 'lobby', qIndex: -1, q: null, submissions: [], startedAt: 0 });
  game.used.clear();
  if (clearPlayers) players.clear();
  else for (const p of players.values()) Object.assign(p, { score: 0, correct: 0, totalTime: 0 });
  broadcast(true);
}

// ---------------- 순위 계산 ----------------
const cmp = (a, b) =>
  b.score - a.score || b.correct - a.correct || a.totalTime - b.totalTime || a.joinedAt - b.joinedAt;
const pubPlayer = (p) => ({ name: p.name, age: p.age, score: p.score, correct: p.correct });
const pubSub = (s, showAnswer) => {
  const p = players.get(s.pid) || { name: '(나감)', age: '-' };
  return {
    name: p.name, age: p.age, elapsed: s.elapsed,
    choice: showAnswer ? s.choice : null,
    correct: showAnswer ? s.correct : null,
    points: showAnswer ? s.points : null,
  };
};

function buildState() {
  const list = [...players.values()].sort(cmp);
  const rank = new Map(); // pid -> { rank, ageRank }
  const byAge = {};
  const ageCounts = {};
  for (const a of AGES) { byAge[a] = []; ageCounts[a] = 0; }
  list.forEach((p, i) => {
    ageCounts[p.age] += 1;
    byAge[p.age].push(p);
    rank.set(p.id, { rank: i + 1, ageRank: byAge[p.age].length });
  });


  const isReveal = game.phase === 'reveal';
  const subs = game.submissions; // 제출 순서(빠른 순)
  const st = {
    phase: game.phase,
    round: game.round,
    qIndex: game.qIndex,
    total: questions.length,
    question: game.q
      ? { text: game.q.text, options: game.q.options, answer: isReveal ? game.q.answer : null,
          ref: game.q.ref || '', book: game.q.book || '', group: game.q.group || '', no: game.q.no || game.qIndex + 1 }
      : null,
    used: [...game.used],
    net,
    startedAt: game.startedAt,
    limit: game.limit,
    serverNow: Date.now(),
    playerCount: players.size,
    submitCount: subs.length,
    ages: AGES,
    ageCounts,
    // 연령대별 참가자 명단 (들어온 순서)
    roster: AGES.map((a) => ({ age: a, names: [...players.values()].filter((p) => p.age === a).map((p) => p.name) })),
    fastest: subs.slice(0, 10).map((s) => pubSub(s, isReveal)),
    rankings: {
      overall: list.slice(0, 10).map(pubPlayer),
      byAge: Object.fromEntries(AGES.map((a) => [a, byAge[a].slice(0, 10).map(pubPlayer)])),
    },
  };
  if (isReveal && game.q) {
    st.optionCounts = game.q.options.map((_, i) => subs.filter((s) => s.choice === i).length);
    const correctSubs = subs.filter((s) => s.correct);
    st.fastestCorrect = correctSubs.slice(0, 10).map((s) => pubSub(s, true));
    st.ageFastest = Object.fromEntries(
      AGES.map((a) => {
        const s = correctSubs.find((x) => players.get(x.pid)?.age === a);
        return [a, s ? pubSub(s, true) : null];
      })
    );
  }
  return { st, rank };
}

function meFor(pid, ctx) {
  const p = players.get(pid);
  if (!p) return { unknown: true };
  const idx = game.submissions.findIndex((s) => s.pid === pid);
  const s = game.submissions[idx];
  const isReveal = game.phase === 'reveal';
  return {
    name: p.name, age: p.age, score: p.score, correct: p.correct,
    rank: ctx.rank.get(pid)?.rank, ageRank: ctx.rank.get(pid)?.ageRank,
    ageTotal: ctx.st.ageCounts[p.age],
    sub: s
      ? { choice: s.choice, order: idx + 1, elapsed: s.elapsed, correct: isReveal ? s.correct : null, points: isReveal ? s.points : null }
      : null,
  };
}

// 참가자에게는 꼭 필요한 정보만 보냄 (인원이 많아도 가볍게)
function playerBase(st) {
  return { v: version, phase: st.phase, round: st.round, qIndex: st.qIndex, question: st.question,
    startedAt: st.startedAt, limit: st.limit, playerCount: st.playerCount };
}
function playerPayload(pid, ctx) {
  if (game.phase === 'question' && players.has(pid) && !game.seen.has(pid)) game.seen.set(pid, Date.now());
  return { ...ctx.pb, serverNow: Date.now(), me: meFor(pid, ctx) };
}
function writeTo(c, ctx) {
  const payload = c.role === 'host' ? { ...ctx.st, serverNow: Date.now() } : playerPayload(c.pid, ctx);
  c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function currentCtx() {
  if (!cache || cache.v !== version) {
    const ctx = buildState();
    ctx.pb = playerBase(ctx.st);
    cache = { v: version, ctx };
  }
  return cache.ctx;
}

let bTimer = null;
function broadcast(now = false) {
  if (now) {
    clearTimeout(bTimer); bTimer = null;
    version += 1;
    const ctx = currentCtx();
    for (const c of clients) { try { writeTo(c, ctx); } catch {} }
    return;
  }
  if (bTimer) return;
  bTimer = setTimeout(() => broadcast(true), clients.size > 100 ? 400 : 150); // 제출이 몰릴 때 묶어서 전송
}

// ---------------- HTTP ----------------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
// 와이파이 주소(192.168.x.x)를 가장 먼저 보여 줌
function lanIPs() {
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address).sort((a, b) => score(a) - score(b));
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
}
function sendFile(res, full) {
  const ext = path.extname(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(full).pipe(res);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // 인터넷을 거쳐 들어온 요청(터널·인터넷 서버)은 진행자 비밀번호가 있어야 진행자 기능을 쓸 수 있음
    const remote = CLOUD || !!req.headers['cf-connecting-ip'] || !!req.headers['x-forwarded-for'];
    const hostOnly = p === '/host' || p === '/host.html' || (p.startsWith('/api/host/') && p !== '/api/host/login') ||
      (p === '/api/questions' && req.method !== 'GET') || (p === '/api/events' && url.searchParams.get('role') === 'host');
    if (remote && hostOnly && !(HOST_TOKEN && cookie(req, 'qh') === HOST_TOKEN)) {
      if (p === '/host' || p === '/host.html') return sendFile(res, path.join(PUB, 'login.html'));
      return json(res, 403, { error: '진행자 로그인이 필요해요.' });
    }
    if (p === '/api/host/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!HOST_TOKEN) return json(res, 400, { error: '진행자 비밀번호(HOST_PASSWORD)가 정해져 있지 않아요. 진행자 컴퓨터에서만 열 수 있어요.' });
      if (String(b.password || '') !== HOST_PASSWORD) return json(res, 401, { error: '비밀번호가 맞지 않아요.' });
      res.setHeader('Set-Cookie', `qh=${HOST_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${CLOUD ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    // --- 주기적 확인 방식 (실시간 연결이 어려운 휴대폰용) ---
    if (p === '/api/poll') {
      const pid = url.searchParams.get('pid');
      const ctx = currentCtx();
      if (Number(url.searchParams.get('v')) === version && players.has(pid) &&
          !(game.phase === 'question' && !game.seen.has(pid))) return json(res, 200, { same: 1 });
      return json(res, 200, playerPayload(pid, ctx));
    }

    // --- 실시간 이벤트 (SSE) ---
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, pid: url.searchParams.get('pid'), role: url.searchParams.get('role') === 'host' ? 'host' : 'player' };
      clients.add(c);
      writeTo(c, currentCtx());
      const hb = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(hb); clients.delete(c); });
      return;
    }

    // --- 참가자 API ---
    if (p === '/api/join' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 20);
      if (!name || !AGES.includes(b.age)) return json(res, 400, { error: '이름과 연령대를 모두 선택해 주세요.' });
      const id = crypto.randomUUID();
      players.set(id, { id, name, age: b.age, score: 0, correct: 0, totalTime: 0, joinedAt: Date.now() });
      broadcast();
      return json(res, 200, { id });
    }
    if (p === '/api/leave' && req.method === 'POST') {
      const b = await readBody(req);
      players.delete(b.pid);
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/answer' && req.method === 'POST') {
      const b = await readBody(req);
      const now = Date.now();
      if (!players.has(b.pid)) return json(res, 400, { error: '참가 정보가 없어요. 다시 입장해 주세요.' });
      if (game.phase !== 'question' || b.round !== game.round) return json(res, 400, { error: '지금은 제출할 수 없어요.' });
      if (now - game.startedAt > game.limit * 1000 + 1500) return json(res, 400, { error: '시간이 지났어요.' });
      // 걸린 시간 = 이 사람 휴대폰에 문제가 전달된 때부터 (인터넷 속도 차이 보정)
      const elapsed = Math.max(0, Math.min(now - game.startedAt, now - (game.seen.get(b.pid) || game.startedAt)));
      if (game.submissions.some((s) => s.pid === b.pid)) return json(res, 400, { error: '이미 제출했어요.' });
      const choice = Number(b.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= game.q.options.length) return json(res, 400, { error: '답을 골라 주세요.' });
      game.submissions.push({ pid: b.pid, choice, elapsed, correct: null, points: 0 });
      const order = game.submissions.length;
      if (order >= players.size) reveal(); // 모두 제출하면 바로 정답 공개
      else broadcast();
      return json(res, 200, { ok: true, order, elapsed });
    }

    // --- 진행자 API ---
    if (p === '/api/info') return json(res, 200, { ips: CLOUD ? [] : lanIPs(), port: PORT, net, cloud: CLOUD });
    if (p === '/api/questions' && req.method === 'GET') return json(res, 200, questions);
    if (p === '/api/questions' && req.method === 'PUT') {
      const b = await readBody(req);
      if (!Array.isArray(b) || !b.every(validQuestion)) return json(res, 400, { error: '문제 형식이 올바르지 않아요.' });
      questions = b.map((q) => ({
        ...q, text: q.text.trim(), options: q.options.map((o) => o.trim()), answer: q.answer,
        time: Number(q.time) || 30, ref: String(q.ref || '').trim(), book: String(q.book || '').trim(),
      }));
      game.used.clear();
      fs.writeFileSync(Q_FILE, JSON.stringify(questions, null, 2));
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/host/start' && req.method === 'POST') {
      const b = await readBody(req);
      return startQuestion(Number(b.index)) ? json(res, 200, { ok: true }) : json(res, 400, { error: '문제가 없어요.' });
    }
    if (p === '/api/host/reveal' && req.method === 'POST') { reveal(); return json(res, 200, { ok: true }); }
    if (p === '/api/host/lobby' && req.method === 'POST') { goLobby(); return json(res, 200, { ok: true }); }
    if (p === '/api/host/reset' && req.method === 'POST') {
      const b = await readBody(req);
      resetGame(!!b.clearPlayers);
      return json(res, 200, { ok: true });
    }

    // --- 정적 파일 ---
    let file = p === '/' ? 'join.html' : p === '/host' ? 'host.html' : p.slice(1);
    const full = path.normalize(path.join(PUB, file));
    if (!full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('페이지를 찾을 수 없어요');
    }
    sendFile(res, full);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: '서버 오류' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`\n⚠️  퀴즈 프로그램이 이미 켜져 있어요. 브라우저에서 http://localhost:${PORT}/host 를 열어 주세요.\n`);
  else console.error(e);
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  console.log('\n🧚 성경 퀴즈 대회가 시작되었어요!\n');
  if (CLOUD) {
    console.log(`  인터넷 서버 모드 (포트 ${PORT}) · 진행자 비밀번호 ${HOST_PASSWORD ? '설정됨 ✅' : '없음 ⚠️  HOST_PASSWORD를 정해 주세요'}`);
    return;
  }
  console.log(`  진행자 화면 :  http://localhost:${PORT}/host`);
  for (const ip of lanIPs()) console.log(`  와이파이 참가 주소 :  http://${ip}:${PORT}/`);
  console.log('\n  ※ 이 검은 창을 닫으면 퀴즈가 꺼져요. 대회가 끝날 때까지 열어 두세요.');
  if (net.status !== 'off') {
    startTunnel(PORT, {
      onUrl: (u) => {
        Object.assign(net, { publicUrl: u + '/', status: 'ready', message: '' });
        console.log(`\n  📱 인터넷 참가 주소 (데이터·와이파이 모두 가능) :  ${u}/\n`);
        broadcast(true);
      },
      onFail: (msg) => {
        if (net.status === 'ready' && !/끊어/.test(msg)) return;
        Object.assign(net, { status: /중이에요|중…/.test(msg) ? 'starting' : 'failed', message: msg });
        if (/끊어/.test(msg)) net.publicUrl = '';
        console.log('  ⚠️  ' + msg);
        broadcast(true);
      },
    });
  }
  // 진행자 화면을 자동으로 열기 (끄려면 NO_OPEN=1)
  if (!process.env.NO_OPEN) {
    const url = `http://localhost:${PORT}/host`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
});
