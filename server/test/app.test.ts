import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { WebFmcProxy, rewrite } from '../src/webfmc/proxy.js';
import { MockSimulator } from '../src/xplane/mockSimulator.js';
import type { PauseCapability, SimSource, SimStatus } from '../src/xplane/simSource.js';
import { closedPort } from './fakeXPlane.js';

const PASSWORD = 'test-password-123';
const HOST = 'pc.tail1234.ts.net';
const ORIGIN = `https://${HOST}`;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class StubSim implements SimSource {
  readonly source = 'xplane' as const;
  paused = false;
  sent: boolean[] = [];
  connected = true;
  start() {}
  async stop() {}
  status(): SimStatus {
    return {
      source: 'xplane',
      link: this.connected ? 'connected' : 'disconnected',
      linkDetail: this.connected ? null : 'X-Plane is not running or its Web API is unavailable.',
      xplaneVersion: '12.4.3',
      apiVersion: 'v3',
      values: this.connected ? { paused: this.paused ? 1 : 0, altitudeFt: 12000 } : {},
      available: new Set(this.connected ? ['paused', 'altitudeFt'] : []),
      lastContactAt: this.connected ? Date.now() : null,
    };
  }
  pauseCapability(): PauseCapability {
    return this.connected ? { ok: true, reason: null, mode: 'on_off' } : { ok: false, reason: 'Not connected to X-Plane', mode: null };
  }
  async readPaused() {
    if (!this.connected) throw new Error('not connected');
    return this.paused;
  }
  async sendPauseCommand(target: boolean) {
    this.sent.push(target);
    this.paused = target;
    return target ? 'sim/operation/pause_on' : 'sim/operation/pause_off';
  }
  onChange() {
    return () => {};
  }
}

async function makeApp(opts: { sim?: SimSource; webfmcPort?: number; webfmcEnabled?: boolean } = {}) {
  const webfmcPort = opts.webfmcPort ?? (await closedPort());
  const config = loadConfig({
    APP_PASSWORD: PASSWORD,
    SESSION_SECRET: 's'.repeat(48),
    WEBFMC_URL: `http://127.0.0.1:${webfmcPort}`,
    WEBFMC_ENABLED: opts.webfmcEnabled === false ? 'false' : 'true',
    PAUSE_CONFIRM_TIMEOUT_MS: '500',
  });
  const sim = opts.sim ?? new StubSim();
  const built = await buildApp({ config, sim, clientDist: null });
  cleanups.push(() => built.app.close());
  return { ...built, sim };
}

const base = { host: HOST, origin: ORIGIN, 'x-xpr-request': '1', 'content-type': 'application/json' };

async function login(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const res = await app.inject({ method: 'POST', url: '/api/session', headers: base, payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return cookie;
}

describe('authentication and request protection', () => {
  it('rejects unauthorized control requests', async () => {
    const { app, sim } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sim/pause', headers: base, payload: {} });
    expect(res.statusCode).toBe(401);
    expect((sim as StubSim).sent).toEqual([]);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const { app } = await makeApp();
    const bad = await app.inject({ method: 'POST', url: '/api/session', headers: base, payload: { password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const cookie = await login(app);
    const state = await app.inject({ method: 'GET', url: '/api/state', headers: { host: HOST, cookie } });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ source: 'xplane', link: 'connected', telemetry: { altitudeFt: 12000 } });
  });

  it('sets a Secure cookie when the request came through Tailscale Serve (HTTPS)', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...base, 'x-forwarded-proto': 'https' },
      payload: { password: PASSWORD },
    });
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  });

  it('requires a session for telemetry and the WebFMC proxy', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ url: '/api/state', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/stream', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/webfmc/', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health', headers: { host: HOST } })).statusCode).toBe(200);
  });

  it('rejects cross-origin and header-less (CSRF) control requests even with a session', async () => {
    const { app, sim } = await makeApp();
    const cookie = await login(app);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/sim/pause',
      headers: { ...base, cookie, origin: 'https://evil.example.com' },
      payload: {},
    });
    expect(evil.statusCode).toBe(403);
    const noHeader = await app.inject({
      method: 'POST',
      url: '/api/sim/pause',
      headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/json' },
      payload: {},
    });
    expect(noHeader.statusCode).toBe(403);
    const form = await app.inject({
      method: 'POST',
      url: '/api/sim/pause',
      headers: { ...base, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(form.statusCode).toBe(415);
    expect((sim as StubSim).sent).toEqual([]);
  });

  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/api/health', headers: { host: 'attacker.example' } });
    expect(res.statusCode).toBe(421);
  });

  it('rejects unexpected body fields (input validation)', async () => {
    const { app, sim } = await makeApp();
    const cookie = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sim/pause',
      headers: { ...base, cookie },
      payload: { command: 'sim/operation/quit' },
    });
    expect(res.statusCode).toBe(400);
    expect((sim as StubSim).sent).toEqual([]);
  });

  it('exposes no generic command or dataref routes', async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    for (const url of ['/api/command', '/api/sim/command', '/api/datarefs', '/api/sim/toggle']) {
      const res = await app.inject({ method: 'POST', url, headers: { ...base, cookie }, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it('sends security headers', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: '/api/health', headers: { host: HOST } });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('pause / resume routes', () => {
  it('pauses, then reports already-paused without sending another command', async () => {
    const { app, sim } = await makeApp();
    const cookie = await login(app);
    const first = await app.inject({ method: 'POST', url: '/api/sim/pause', headers: { ...base, cookie }, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, result: 'changed', paused: true });
    const second = await app.inject({ method: 'POST', url: '/api/sim/pause', headers: { ...base, cookie }, payload: {} });
    expect(second.json()).toMatchObject({ ok: true, result: 'already', paused: true });
    const resume = await app.inject({ method: 'POST', url: '/api/sim/resume', headers: { ...base, cookie }, payload: {} });
    expect(resume.json()).toMatchObject({ ok: true, result: 'changed', paused: false });
    expect((sim as StubSim).sent).toEqual([true, false]);
  });

  it('returns 503 and a clear message when X-Plane is disconnected', async () => {
    const sim = new StubSim();
    sim.connected = false;
    const { app } = await makeApp({ sim });
    const cookie = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/sim/resume', headers: { ...base, cookie }, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('marks mock data as mock', async () => {
    const mock = new MockSimulator();
    mock.start();
    cleanups.push(() => mock.stop());
    const { app } = await makeApp({ sim: mock });
    const cookie = await login(app);
    const res = await app.inject({ url: '/api/state', headers: { host: HOST, cookie } });
    expect(res.json()).toMatchObject({ source: 'mock' });
  });
});

// ---------------------------------------------------------------- WebFMC

const FAKE_INDEX =
  '<!doctype html><html><head><link rel="manifest" href="/static/manifest.json"><script defer="defer" src="/static/js/app.abc123.js"></script><link href="/static/css/app.def.css" rel="stylesheet"></head><body><div id="app"></div></body></html>';
const FAKE_JS =
  'function(){e.p="/"}();var x=e.p+"static/img/logo.svg";this.serverUrl="ws://"+window.location.hostname+":"+window.location.port+"/ws";';
const FAKE_CSS = '@font-face{src:url(/static/fonts/a.woff)}.b{background:url(data:image/png;base64,AAA)}';

async function fakeWebFmc(opts: { js?: string; xfo?: string } = {}) {
  const server: Server = createServer((req, res) => {
    const h: Record<string, string> = opts.xfo ? { 'X-Frame-Options': opts.xfo } : {};
    if (req.url === '/') return res.writeHead(200, { ...h, 'Content-Type': 'text/html' }).end(FAKE_INDEX);
    if (req.url === '/static/js/app.abc123.js') return res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(opts.js ?? FAKE_JS);
    if (req.url === '/static/css/app.def.css') return res.writeHead(200, { 'Content-Type': 'text/css' }).end(FAKE_CSS);
    if (req.url === '/static/img/logo.svg') return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg/>');
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ hello: 'webfmc', origin: req.headers.origin }));
    ws.on('message', (m) => ws.send(`echo:${m.toString()}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return (server.address() as AddressInfo).port;
}

describe('WebFMC integration', () => {
  it('reports WebFMC unavailable when nothing listens on its port', async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const status = await app.inject({ url: '/api/webfmc/status', headers: { host: HOST, cookie } });
    expect(status.json()).toMatchObject({ enabled: true, reachable: false, embeddable: false });
    expect(status.json().reason).toMatch(/not answering/);
    const page = await app.inject({ url: '/webfmc/', headers: { host: HOST, cookie } });
    expect(page.statusCode).toBe(502);
  });

  it('reports disabled when WEBFMC_ENABLED=false', async () => {
    const { app } = await makeApp({ webfmcEnabled: false });
    const cookie = await login(app);
    const status = await app.inject({ url: '/api/webfmc/status', headers: { host: HOST, cookie } });
    expect(status.json()).toMatchObject({ enabled: false, embeddable: false });
  });

  it('proxies and rewrites WebFMC so it works same-origin over HTTPS', async () => {
    const port = await fakeWebFmc();
    const { app } = await makeApp({ webfmcPort: port });
    const cookie = await login(app);

    const status = await app.inject({ url: '/api/webfmc/status', headers: { host: HOST, cookie } });
    expect(status.json()).toMatchObject({ reachable: true, embeddable: true, reason: null });

    const index = await app.inject({ url: '/webfmc/', headers: { host: HOST, cookie } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('src="/webfmc/static/js/app.abc123.js"');
    expect(index.body).toContain('href="/webfmc/static/css/app.def.css"');
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(index.headers['x-frame-options']).toBeUndefined();

    const js = await app.inject({ url: '/webfmc/static/js/app.abc123.js', headers: { host: HOST, cookie } });
    expect(js.body).toContain('e.p="/webfmc/"');
    expect(js.body).toContain('"wss://":"ws://")+window.location.host+"/webfmc/ws"');
    expect(js.body).not.toContain('"ws://"+window.location.hostname');

    const css = await app.inject({ url: '/webfmc/static/css/app.def.css', headers: { host: HOST, cookie } });
    expect(css.body).toContain('url(/webfmc/static/fonts/a.woff)');

    const img = await app.inject({ url: '/webfmc/static/img/logo.svg', headers: { host: HOST, cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.body).toBe('<svg/>');
  });

  it('refuses paths outside the WebFMC allow-list', async () => {
    const port = await fakeWebFmc();
    const { app } = await makeApp({ webfmcPort: port });
    const cookie = await login(app);
    for (const url of ['/webfmc/admin', '/webfmc/static/a%2F..%2Fb', '/webfmc/static/.hidden', '/webfmc/ws']) {
      const res = await app.inject({ url, headers: { host: HOST, cookie } });
      expect(res.statusCode, url).toBe(404);
    }
    // Dot segments (HTTP clients normally collapse these before sending).
    expect(WebFmcProxy.upstreamPathFor('/webfmc/../api/state')).toBeNull();
    expect(WebFmcProxy.upstreamPathFor('/webfmc/static/../../secret')).toBeNull();
    expect(WebFmcProxy.upstreamPathFor('/webfmc/static/..%5C..%5Cwin.ini')).toBeNull();
    expect(WebFmcProxy.upstreamPathFor('/webfmc/static/js/app.1.js')).toBe('/static/js/app.1.js');
    expect(WebFmcProxy.upstreamPathFor('/webfmc/static//x')).toBeNull();
    expect(WebFmcProxy.upstreamPathFor('/webfmcx/')).toBeNull();
  });

  it('reports not embeddable when the WebFMC client cannot be adapted', async () => {
    const port = await fakeWebFmc({ js: 'this.serverUrl=buildUrl()' });
    const { app } = await makeApp({ webfmcPort: port });
    const cookie = await login(app);
    const status = await app.inject({ url: '/api/webfmc/status', headers: { host: HOST, cookie } });
    expect(status.json()).toMatchObject({ reachable: true, embeddable: false });
  });

  it('reports not embeddable and keeps WebFMC’s own X-Frame-Options: DENY', async () => {
    const port = await fakeWebFmc({ xfo: 'DENY' });
    const { app } = await makeApp({ webfmcPort: port });
    const cookie = await login(app);
    const status = await app.inject({ url: '/api/webfmc/status', headers: { host: HOST, cookie } });
    expect(status.json()).toMatchObject({ reachable: true, embeddable: false });
    const index = await app.inject({ url: '/webfmc/', headers: { host: HOST, cookie } });
    expect(index.headers['x-frame-options']).toBe('DENY');
  });

  it('bridges the WebFMC WebSocket only for signed-in, same-origin clients', async () => {
    const port = await fakeWebFmc();
    const { app } = await makeApp({ webfmcPort: port });
    const cookie = await login(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const appPort = (app.server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${appPort}/webfmc/ws`;

    const opened = (headers: Record<string, string>) =>
      new Promise<{ ok: boolean; first?: string }>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.once('message', (m) => {
          ws.send('ping');
          ws.once('message', (m2) => {
            resolve({ ok: true, first: `${m.toString()}|${m2.toString()}` });
            ws.close();
          });
        });
        ws.once('unexpected-response', () => resolve({ ok: false }));
        ws.once('error', () => resolve({ ok: false }));
      });

    const good = await opened({ host: HOST, origin: ORIGIN, cookie });
    expect(good.ok).toBe(true);
    expect(good.first).toContain('"hello":"webfmc"');
    expect(good.first).toContain(`"origin":"http://127.0.0.1:${port}"`);
    expect(good.first).toContain('echo:ping');

    expect((await opened({ host: HOST, origin: ORIGIN })).ok).toBe(false); // no session
    expect((await opened({ host: HOST, origin: 'https://evil.example.com', cookie })).ok).toBe(false);
  });
});

describe('rewrite()', () => {
  it('leaves unrelated content untouched', () => {
    expect(rewrite('js', 'var a="/static/x";')).toBe('var a="/static/x";');
    expect(rewrite('css', '.a{color:red}')).toBe('.a{color:red}');
  });
});
