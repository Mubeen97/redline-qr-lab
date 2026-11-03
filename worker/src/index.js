import { DurableObject } from 'cloudflare:workers';

const PAGE_ORIGIN = 'https://mubeen97.github.io';
const MAX_SIGNAL_BYTES = 96_000;
const PAIR_LIFETIME_MS = 10 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), b => b.toString(16).padStart(2, '0')).join('');
}

async function matches(a, b) {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function safeSend(socket, message) {
  try { socket.send(JSON.stringify(message)); } catch { /* disconnected peer */ }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ service: 'redline-remote-signal', status: 'ready', version: '1.0' });
    }
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'Only /ws (WebSocket) and /health are available' }, 404);
    }
    if (request.headers.get('Origin') !== (env.ALLOWED_ORIGIN || PAGE_ORIGIN)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403);
    }
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) {
      return jsonResponse({ error: 'Admin password secret not configured (minimum 16 characters)' }, 503);
    }
    const id = env.SIGNAL_ROOM.idFromName('redline-v1-single-room');
    return env.SIGNAL_ROOM.get(id).fetch(request);
  }
};

// Durable Object stores only ephemeral pairing credentials and short-lived
// login rate-limit counters. No camera frames, audio or recordings pass through it.
export class SignalRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const rawIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipKey = await digest(rawIp + ':' + this.env.ADMIN_PASSWORD);
    server.serializeAttachment({ role: null, ipKey });
    return new Response(null, { status: 101, webSocket: client });
  }

  byRole(role, exclude = null) {
    return this.ctx.getWebSockets().find(s => s !== exclude && s.deserializeAttachment()?.role === role);
  }

  async deny(socket, text) {
    safeSend(socket, { type: 'auth-error', message: text });
    socket.close(1008, 'Not authorized');
  }

  async authenticate(socket, message, attachment) {
    if (message.type !== 'auth') { await this.deny(socket, 'Authenticate first'); return; }
    if (message.role === 'admin') {
      const key = 'fails:' + attachment.ipKey;
      const now = Date.now();
      const last = await this.ctx.storage.get(key) || { count: 0, until: 0 };
      if (last.until > now && last.count >= 5) { await this.deny(socket, 'Temporarily rate-limited'); return; }
      if (typeof message.password !== 'string' || !(await matches(message.password, this.env.ADMIN_PASSWORD))) {
        const count = last.until > now ? last.count + 1 : 1;
        await this.ctx.storage.put(key, { count, until: now + AUTH_WINDOW_MS });
        await this.deny(socket, 'Incorrect password');
        return;
      }
      await this.ctx.storage.delete(key);
      const prior = this.byRole('admin', socket);
      if (prior) prior.close(4000, 'Admin signed in elsewhere');
      socket.serializeAttachment({ ...attachment, role: 'admin' });
      safeSend(socket, { type: 'authenticated' });
      if (this.byRole('device')) {
        safeSend(socket, { type: 'device-online' });
        safeSend(this.byRole('device'), { type: 'admin-online' });
      }
      return;
    }
    if (message.role === 'device') {
      if (this.byRole('device', socket)) { await this.deny(socket, 'Another test device is already paired'); return; }
      const pending = await this.ctx.storage.get('pending-pair');
      const receivedHash = typeof message.token === 'string' ? await digest(message.token) : '';
      if (!pending || pending.expires <= Date.now() || !(await matches(receivedHash, pending.tokenHash))) {
        await this.deny(socket, 'Invitation invalid or expired'); return;
      }
      await this.ctx.storage.delete('pending-pair');
      socket.serializeAttachment({ ...attachment, role: 'device' });
      safeSend(socket, { type: 'authenticated' });
      const admin = this.byRole('admin');
      if (admin) {
        safeSend(admin, { type: 'device-online' });
        safeSend(socket, { type: 'admin-online' });
      } else {
        safeSend(socket, { type: 'admin-offline' });
      }
      return;
    }
    await this.deny(socket, 'Invalid role');
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_SIGNAL_BYTES) {
      socket.close(1009, 'Message too large or invalid'); return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (!message || typeof message !== 'object') return;
    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.role) { await this.authenticate(socket, message, attachment); return; }

    if (attachment.role === 'admin' && message.type === 'create-pair') {
      const token = randomToken();
      const expires = Date.now() + PAIR_LIFETIME_MS;
      await this.ctx.storage.put('pending-pair', { tokenHash: await digest(token), expires });
      safeSend(socket, { type: 'pairing', token, expires });
      return;
    }

    const role = attachment.role;
    const allowed = role === 'device'
      ? ['offer', 'candidate', 'stop']
      : ['answer', 'candidate', 'stop'];
    if (!allowed.includes(message.type)) return;
    if (message.type === 'offer' && message.description?.type !== 'offer') return;
    if (message.type === 'answer' && message.description?.type !== 'answer') return;
    if (message.type === 'candidate' && !message.candidate) return;
    const target = this.byRole(role === 'device' ? 'admin' : 'device');
    if (!target) return;
    const forwarded = { type: message.type };
    if (message.description) forwarded.description = message.description;
    if (message.candidate) forwarded.candidate = message.candidate;
    safeSend(target, forwarded);
  }

  webSocketClose(socket) {
    const role = socket.deserializeAttachment()?.role;
    if (role === 'device' && !this.byRole('device', socket)) {
      safeSend(this.byRole('admin', socket), { type:'device-offline' });
    }
    if (role === 'admin') {
      safeSend(this.byRole('device', socket), {
        type: this.byRole('admin', socket) ? 'admin-online' : 'admin-offline'
      });
    }
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
    try { socket.close(1011, 'Connection error'); } catch { /* already closed */ }
  }
}
