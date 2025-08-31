// Deploy with wrangler. See wrangler.toml snippet below.

// Worker entry that routes each `?room=...` to a Durable Object instance.
export default {
  async fetch(request, env) {
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const url = new URL(request.url);
    const room = url.searchParams.get('room') || 'default';
    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request); // delegate the WS session to the DO
  }
}

// Durable Object: keeps connections + small backlog per room.
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();

    // storage keys / limits
    this.KEY_BACKLOG = 'backlog';
    this.MAX_BACKLOG = 100;          // keep the last N messages
    this.MAX_AGE_MS   = 5 * 60_000;  // drop messages older than 5 minutes
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    // Load backlog, prune, and send to the new client.
    let backlog = await this.state.storage.get(this.KEY_BACKLOG) || [];
    const now = Date.now();
    backlog = backlog.filter(m => now - m.t <= this.MAX_AGE_MS);
    // Send in chronological order
    for (const m of backlog) {
      try { server.send(m.data); } catch {}
    }

    this.sockets.add(server);

    const cleanup = () => { try { this.sockets.delete(server); } catch {} };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    server.addEventListener('message', async (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : ev.data.toString();

      // OPTIONAL: ignore 'hello' traffic to reduce noise
      // Messages are encrypted by your client, but the outer structure is JSON.
      // If you want to filter by type, you can try/catch JSON parse:
      let keep = true;
      try {
        const obj = JSON.parse(data);
        // encrypted envelope from your client: { __enc: true, payload: {...} }
        // If you want to store everything encrypted without peeking, set keep=true.
        // If you USED UNENCRYPTED relay messages, you could do: keep = obj?.t !== 'hello';
      } catch {
        // Data not JSON or encrypted; keep it as-is.
      }

      if (keep) {
        backlog.push({ t: Date.now(), data });
        // Prune by age and size
        const cutoff = Date.now() - this.MAX_AGE_MS;
        backlog = backlog.filter(m => m.t >= cutoff);
        if (backlog.length > this.MAX_BACKLOG) backlog = backlog.slice(-this.MAX_BACKLOG);
        await this.state.storage.put(this.KEY_BACKLOG, backlog);
      }

      // Fan-out to other sockets
      for (const ws of this.sockets) {
        if (ws !== server) {
          try { ws.send(data); } catch {}
        }
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
