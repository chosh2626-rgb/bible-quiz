// 인터넷 주소 만들기 (Cloudflare 무료 터널, 가입 필요 없음)
// 휴대폰 데이터(LTE·5G)로도 퀴즈에 들어올 수 있게 해 줍니다.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');
const BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function target() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  if (process.platform === 'win32') return { file: `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`, exe: 'cloudflared.exe' };
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch}.tgz`, exe: 'cloudflared', tgz: true };
  return { file: `cloudflared-linux-${arch}`, exe: 'cloudflared' };
}

async function ensureBinary(log) {
  const t = target();
  const exe = path.join(BIN_DIR, t.exe);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log('  🌐 인터넷 연결 도구를 처음 한 번 내려받는 중이에요… (1~2분 걸릴 수 있어요)');
  const res = await fetch(BASE + t.file);
  if (!res.ok) throw new Error('내려받기 실패 (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  if (t.tgz) {
    const tgz = path.join(BIN_DIR, t.file);
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', BIN_DIR]);
    fs.unlinkSync(tgz);
  } else {
    fs.writeFileSync(exe + '.part', buf);
    fs.renameSync(exe + '.part', exe);
  }
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
}

// onUrl(url) : 인터넷 주소가 준비되면 호출, onFail(msg) : 실패 시 호출
async function startTunnel(port, { onUrl, onFail, log = console.log }) {
  let exe;
  try {
    exe = await ensureBinary(log);
  } catch (e) {
    return onFail('인터넷 연결 도구를 내려받지 못했어요: ' + e.message);
  }
  let found = false;
  let restarts = 0;
  const run = () => {
    const cp = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { windowsHide: true });
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !found) { found = true; onUrl(m[0]); }
    };
    cp.stdout.on('data', onData);
    cp.stderr.on('data', onData);
    cp.on('error', (e) => onFail('인터넷 연결 도구를 실행하지 못했어요: ' + e.message));
    cp.on('exit', () => {
      if (exiting) return;
      if (found) onFail('인터넷 연결이 끊어졌어요. 다시 연결하는 중…');
      found = false;
      if (restarts++ < 5) setTimeout(run, 3000);
      else onFail('인터넷 주소를 만들지 못했어요. 같은 와이파이로 접속해 주세요.');
    });
    current = cp;
  };
  let current = null;
  let exiting = false;
  const stop = () => { exiting = true; try { current && current.kill(); } catch {} };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(0); });
  run();
  // 30초 안에 주소가 안 나오면 알려 주기 (계속 시도는 함)
  setTimeout(() => { if (!found) onFail('인터넷 주소를 만드는 중이에요… 잠시만 기다려 주세요.'); }, 30000);
}

module.exports = { startTunnel };
