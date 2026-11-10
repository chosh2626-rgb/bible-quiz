// 전도회 성경 퀴즈 대회 서버: 화면(index.html)을 내보내고, 진행자와 휴대폰 사이의 메시지를 중계한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, createWebSocketStream } = require('ws');
const aedes = require('aedes')();

const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(page);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/mqtt' });
wss.on('connection', (socket) => aedes.handle(createWebSocketStream(socket)));

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('성경 퀴즈 서버 시작: 포트 ' + port));
