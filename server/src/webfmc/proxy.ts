// Same-origin reverse proxy for the local WebFMC server (default 127.0.0.1:9090).
//
// Why a proxy: the phone loads this app over HTTPS (Tailscale Serve). An HTTPS
// page cannot embed http://pc:9090 (mixed content), and WebFMC's client
// hard-codes `"ws://"+location.hostname+":"+location.port+"/ws"` and
// root-absolute "/static/..." asset paths. Mounting WebFMC under /webfmc/ on
// this server makes it same-origin, so it works over HTTPS and is covered by
// the app's login.
//
// What it does (and nothing more):
//  - fixed upstream (WEBFMC_URL, loopback only), GET/HEAD only;
//  - only "/", "/static/<file>" and the "/ws" WebSocket are forwarded;
//  - in-transit rewrites of exactly three things: asset paths in index.html
//    and CSS, webpack's public path, and the WebSocket URL expression;
//  - WebFMC's own response security headers are passed through untouched.
// Nothing on disk is modified. If a future WebFMC version changes the code
// these rewrites match, status() reports "not embeddable" and the UI falls
// back to opening WebFMC directly.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { WebFmcStatus } from '../shared/api-types.js';
import { silentLogger, type Logger } from '../xplane/simSource.js';

export const WEBFMC_MOUNT = '/webfmc';

const SAFE_STATIC_PATH = /^\/static\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;

// The exact WebSocket URL expression in WebFMC 2.4.1's app.*.js.
const WS_URL_PATTERN = /"ws:\/\/"\+window\.location\.hostname\+":"\+window\.location\.port\+"\/ws"/g;
const WS_URL_REPLACEMENT = `(window.location.protocol==="https:"?"wss://":"ws://")+window.location.host+"${WEBFMC_MOUNT}/ws"`;
// webpack runtime: `e.p="/"` (public path for e.p+"static/img/...").
const PUBLIC_PATH_PATTERN = /(\b[A-Za-z_$][\w$]*\.p=)"\/"/g;
const HTML_ASSET_PATTERN = /(\s(?:src|href)=["']?)\/static\//g;
const CSS_URL_PATTERN = /url\((["']?)\/static\//g;

export interface WebFmcProxyOptions {
  enabled: boolean;
  upstream: URL;
  directUrl: string | null;
  timeoutMs?: number;
  statusCacheMs?: number;
  logger?: Logger;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

type Kind = 'html' | 'js' | 'css' | 'other';

export class WebFmcProxy {
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly statusCacheMs: number;
  private cached: { at: number; value: Promise<WebFmcStatus> } | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  private readonly bridges = new Set<WebSocket>();

  constructor(private readonly opts: WebFmcProxyOptions) {
    this.log = opts.logger ?? silentLogger;
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.statusCacheMs = opts.statusCacheMs ?? 10_000;
  }

  get enabled() {
    return this.opts.enabled;
  }

  /** Map a request path under /webfmc to an upstream path, or null if not allowed. */
  static upstreamPathFor(requestPath: string): string | null {
    if (!requestPath.startsWith(WEBFMC_MOUNT)) return null;
    const sub = requestPath.slice(WEBFMC_MOUNT.length) || '/';
    if (sub === '/' || sub === '/index.html') return '/';
    if (sub.includes('..') || sub.includes('//') || sub.includes('\\')) return null;
    return SAFE_STATIC_PATH.test(sub) ? sub : null;
  }

  // ------------------------------------------------------------- status

  status(force = false): Promise<WebFmcStatus> {
    const now = Date.now();
    if (!force && this.cached && now - this.cached.at < this.statusCacheMs) return this.cached.value;
    const value = this.check();
    this.cached = { at: now, value };
    return value;
  }

  private async check(): Promise<WebFmcStatus> {
    const base = {
      enabled: this.opts.enabled,
      proxyPath: `${WEBFMC_MOUNT}/`,
      directUrl: this.opts.directUrl,
      checkedAt: Date.now(),
    };
    if (!this.opts.enabled) {
      return { ...base, reachable: false, embeddable: false, reason: 'WebFMC integration is disabled (WEBFMC_ENABLED=false).' };
    }

    let res: Response;
    try {
      res = await this.fetchUpstream('/');
    } catch {
      return {
        ...base,
        reachable: false,
        embeddable: false,
        reason: `WebFMC is not answering on ${this.opts.upstream.host}. It starts together with X-Plane.`,
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ...base, reachable: true, embeddable: false, reason: `WebFMC answered HTTP ${res.status}.` };
    }

    const xfo = res.headers.get('x-frame-options') ?? '';
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    if (/deny/i.test(xfo) || /frame-ancestors\s+'none'/i.test(csp)) {
      return { ...base, reachable: true, embeddable: false, reason: 'WebFMC forbids being embedded (X-Frame-Options / CSP). Open it separately instead.' };
    }

    const script = html.match(/\/static\/js\/app\.[A-Za-z0-9_.-]+\.js/);
    if (!script) {
      return { ...base, reachable: true, embeddable: false, reason: 'Unrecognised WebFMC page layout; embedding is disabled to avoid a broken panel.' };
    }
    try {
      const js = await (await this.fetchUpstream(script[0])).text();
      WS_URL_PATTERN.lastIndex = 0;
      if (!WS_URL_PATTERN.test(js)) {
        return {
          ...base,
          reachable: true,
          embeddable: false,
          reason: 'This WebFMC version builds its WebSocket address differently, so it cannot be proxied. Open it separately instead.',
        };
      }
    } catch {
      return { ...base, reachable: true, embeddable: false, reason: 'Could not inspect the WebFMC client script.' };
    }
    return { ...base, reachable: true, embeddable: true, reason: null };
  }

  // ------------------------------------------------------------- HTTP

  /** Fetch and (if needed) rewrite one allowed WebFMC resource. */
  async handle(requestPath: string, method: 'GET' | 'HEAD', ifNoneMatch?: string): Promise<ProxyResponse> {
    if (!this.opts.enabled) return textResponse(404, 'WebFMC integration is disabled.');
    const upstreamPath = WebFmcProxy.upstreamPathFor(requestPath);
    if (!upstreamPath) return textResponse(404, 'Not found');

    const kind: Kind =
      upstreamPath === '/' ? 'html' : upstreamPath.endsWith('.js') ? 'js' : upstreamPath.endsWith('.css') ? 'css' : 'other';

    let res: Response;
    try {
      res = await this.fetchUpstream(upstreamPath, kind === 'other' && ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {});
    } catch {
      return textResponse(502, 'WebFMC is not reachable. Is X-Plane (with the WebFMC plugin) running?');
    }

    const headers: Record<string, string | string[]> = {};
    for (const h of ['content-type', 'last-modified', 'x-frame-options', 'content-security-policy']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    // Our addition: only this app may frame WebFMC (WebFMC's own CSP, if any, also applies).
    headers['content-security-policy'] = [
      ...(headers['content-security-policy'] ? [headers['content-security-policy'] as string] : []),
      "frame-ancestors 'self'",
    ];
    headers['x-content-type-options'] = 'nosniff';

    if (res.status === 304) {
      await res.body?.cancel();
      return { status: 304, headers, body: Buffer.alloc(0) };
    }

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BODY_BYTES) {
      await res.body?.cancel();
      return textResponse(502, 'WebFMC response too large');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) return textResponse(502, 'WebFMC response too large');

    let body = buf;
    if (res.ok && kind !== 'other') {
      body = Buffer.from(rewrite(kind, buf.toString('utf8')), 'utf8');
      headers['cache-control'] = 'no-cache';
    } else {
      const etag = res.headers.get('etag');
      if (etag) headers.etag = etag;
      headers['cache-control'] = res.headers.get('cache-control') ?? 'public, max-age=300';
    }
    return { status: res.status, headers, body: method === 'HEAD' ? Buffer.alloc(0) : body };
  }

  private async fetchUpstream(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(new URL(path, this.opts.upstream), {
        method: 'GET',
        headers: { Accept: '*/*', ...extraHeaders },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- WebSocket

  /** Bridge an (already authenticated) upgrade request on /webfmc/ws to WebFMC's /ws. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : undefined;
    this.wss.handleUpgrade(req, socket, head, (client) => this.bridge(client, ua));
  }

  private bridge(client: WebSocket, userAgent?: string) {
    const target = new URL('/ws', this.opts.upstream);
    target.protocol = 'ws:';
    const upstream = new WebSocket(target, {
      // WebFMC (gorilla/websocket) checks that Origin matches the Host it was called on.
      origin: this.opts.upstream.origin,
      handshakeTimeout: this.timeoutMs,
      maxPayload: MAX_WS_PAYLOAD,
      // Only the User-Agent is passed on (WebFMC logs it to tell devices apart); never cookies.
      headers: userAgent ? { 'User-Agent': userAgent } : {},
    });
    this.bridges.add(client);
    const queue: Array<[WebSocket.RawData, boolean]> = [];

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING && queue.length < 100) queue.push([data, isBinary]);
    });
    upstream.on('open', () => {
      for (const [d, b] of queue.splice(0)) upstream.send(d, { binary: b });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    const closeBoth = (code: number, reason: string) => {
      const safe = code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1011;
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(safe, reason.slice(0, 100));
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));
    upstream.on('error', (err) => {
      this.log.debug(`WebFMC upstream WebSocket error: ${err.message}`);
      closeBoth(1011, 'WebFMC unavailable');
    });
    client.on('close', () => {
      this.bridges.delete(client);
      closeBoth(1000, '');
    });
    client.on('error', () => client.terminate());
  }

  close() {
    for (const c of this.bridges) c.terminate();
    this.bridges.clear();
    this.wss.close();
  }
}

export function rewrite(kind: Exclude<Kind, 'other'>, text: string): string {
  switch (kind) {
    case 'html':
      return text.replace(HTML_ASSET_PATTERN, `$1${WEBFMC_MOUNT}/static/`);
    case 'css':
      return text.replace(CSS_URL_PATTERN, `url($1${WEBFMC_MOUNT}/static/`);
    case 'js':
      return text.replace(WS_URL_PATTERN, WS_URL_REPLACEMENT).replace(PUBLIC_PATH_PATTERN, `$1"${WEBFMC_MOUNT}/"`);
  }
}

function textResponse(status: number, message: string): ProxyResponse {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    body: Buffer.from(message, 'utf8'),
  };
}
