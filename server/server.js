// Minimal Node.js WebSocket relay (no persistence).
// Usage: NODE_ENV=production PORT=8787 node server.js
import { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

const rooms = new Map();

wss.on('connection', (ws, request, client) => {
  const params = new URL(request.url, 'http://localhost').searchParams;
  const room = params.get('room') || 'default';
  let set = rooms.get(room); if (!set) { set = new Set(); rooms.set(room, set); }
  set.add(ws);
  ws.on('message', (data) => {
    for (const sock of set) if (sock !== ws && sock.readyState === 1) try { sock.send(data); } catch {}
  });
  const clean = () => { try { set.delete(ws); } catch {} };
  ws.on('close', clean); ws.on('error', clean);
});

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
  } else {
    socket.destroy();
  }
});

const port = process.env.PORT || 8787;
server.listen(port, () => console.log('WS relay listening on :' + port));
