// HTTP application: API, live state stream, WebFMC proxy and the built client.
//
// Request pipeline:
//   1. Host allow-list (DNS-rebinding protection)          → 421
//   2. Mutating requests: same-origin + custom header + JSON  → 403 / 415
//   3. Session cookie required for everything except health/login → 401
//   4. Route handlers (only fixed, allow-listed sim actions exist)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { LoginThrottle, SESSION_COOKIE, SessionManager, parseCookies, serializeSessionCookie } from './auth.js';
import { APP_CSP, COMMON_SECURITY_HEADERS, RateLimiter, isAllowedHost, isHttpsRequest, isSameOrigin } from './security.js';
import type { ApiError, PauseAction, PauseResponse, PublicState, SessionInfo } from './shared/api-types.js';
import { FlightMemory, buildCduMirror, buildPublicState } from './telemetry.js';
import { WEBFMC_MOUNT, WebFmcProxy } from './webfmc/proxy.js';
import { PauseController } from './xplane/pauseController.js';
import type { Logger, SimSource } from './xplane/simSource.js';

export interface BuildAppOptions {
  config: AppConfig;
  sim: SimSource;
  clientDist?: string | null;
  logger?: FastifyBaseLogger | false;
  /** Overridable for tests. */
  pauseController?: PauseController;
  webfmc?: WebFmcProxy;
}

export interface BuiltApp {
  app: FastifyInstance;
  pause: PauseController;
  webfmc: WebFmcProxy;
}

const CSRF_HEADER = 'x-xpr-request';
const MAX_STREAM_CLIENTS = 20;
const STREAM_INTERVAL_MS = 1000;

const PUBLIC_API_ROUTES = new Set(['/api/health', '/api/session']);

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config, sim } = opts;

  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    bodyLimit: 4 * 1024,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    // Reject unknown body fields instead of silently stripping them.
    ajv: { customOptions: { removeAdditional: false } },
    return503OnClosing: true,
  });

  const log: Logger = adaptLogger(app.log);
  const sessions = new SessionManager(config.appPassword, config.sessionSecret, config.sessionTtlMs);
  const loginThrottle = new LoginThrottle();
  const controlLimiter = new RateLimiter(30, 60_000);
  const pause = opts.pauseController ?? new PauseController(sim, { confirmTimeoutMs: config.pauseConfirmTimeoutMs, logger: log });
  const webfmc =
    opts.webfmc ??
    new WebFmcProxy({ enabled: config.webfmcEnabled, upstream: config.webfmcUrl, directUrl: config.webfmcDirectUrl, logger: log });

  // Remembers the flight's highest altitude (FF777 T/D: cruise vs descent), fed on every sim update.
  const flight = new FlightMemory();
  flight.observe(sim.status());
  const stopObserving = sim.onChange(() => flight.observe(sim.status()));
  app.addHook('onClose', async () => stopObserving());

  const currentState = (): PublicState =>
    buildPublicState(sim.status(), sim.pauseCapability(), pause.inFlight(), Date.now(), config.telemetryStaleMs, flight);

  const sessionExpiry = (req: { headers: FastifyRequest['headers'] }): number | null =>
    sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  const cookieSecure = (req: FastifyRequest) =>
    config.cookieSecure === 'always' ? true : config.cookieSecure === 'never' ? false : isHttpsRequest(req.headers);

  // ------------------------------------------------------------------ hooks

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
      log.warn(`Rejected request for unexpected host "${req.headers.host ?? ''}"`);
      return sendError(reply, 421, 'bad_host', 'This server does not answer to that host name.');
    }

    const path = req.url.split('?')[0] ?? '/';
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';

    if (mutating) {
      if (!isSameOrigin(req.headers)) return sendError(reply, 403, 'bad_origin', 'Cross-origin request refused.');
      if (req.headers[CSRF_HEADER] !== '1') return sendError(reply, 403, 'csrf', 'Missing request header.');
      const ct = req.headers['content-type'] ?? '';
      if (req.headers['content-length'] !== '0' && !ct.startsWith('application/json')) {
        return sendError(reply, 415, 'content_type', 'Expected application/json.');
      }
    }

    const needsAuth =
      (path.startsWith('/api/') && !PUBLIC_API_ROUTES.has(path)) || path === WEBFMC_MOUNT || path.startsWith(`${WEBFMC_MOUNT}/`);
    if (needsAuth && sessionExpiry(req) === null) {
      return sendError(reply, 401, 'unauthorized', 'Sign in required.');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(COMMON_SECURITY_HEADERS)) reply.header(k, v);
    const path = req.url.split('?')[0] ?? '/';
    if (!(path === WEBFMC_MOUNT || path.startsWith(`${WEBFMC_MOUNT}/`))) {
      reply.header('Content-Security-Policy', APP_CSP);
      reply.header('X-Frame-Options', 'DENY');
    }
    if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ------------------------------------------------------------------ session

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/session', async (req): Promise<SessionInfo> => {
    const exp = sessionExpiry(req);
    return { authenticated: exp !== null, expiresAt: exp };
  });

  app.post<{ Body: { password: string } }>(
    '/api/session',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
    },
    async (req, reply) => {
      const wait = loginThrottle.retryAfterMs();
      if (wait > 0) {
        reply.header('Retry-After', Math.ceil(wait / 1000));
        return sendError(reply, 429, 'locked', `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} min.`);
      }
      if (!sessions.checkPassword(req.body.password)) {
        loginThrottle.recordFailure();
        log.warn(`Failed sign-in attempt${tailnetUser(req)}`);
        await new Promise((r) => setTimeout(r, 400)); // slow down guessing
        return sendError(reply, 401, 'bad_password', 'Incorrect PIN.');
      }
      loginThrottle.recordSuccess();
      const { token, expiresAt } = sessions.issue();
      reply.header('Set-Cookie', serializeSessionCookie(token, config.sessionTtlMs / 1000, cookieSecure(req)));
      log.info(`Signed in${tailnetUser(req)}`);
      return { authenticated: true, expiresAt } satisfies SessionInfo;
    },
  );

  app.delete('/api/session', async (req, reply) => {
    reply.header('Set-Cookie', serializeSessionCookie('', 0, cookieSecure(req)));
    return { authenticated: false, expiresAt: null } satisfies SessionInfo;
  });

  // ------------------------------------------------------------------ state

  app.get('/api/state', async () => currentState());

  let streamClients = 0;
  app.get('/api/stream', (req, reply) => {
    if (streamClients >= MAX_STREAM_CLIENTS) {
      return sendError(reply, 503, 'too_many_streams', 'Too many open dashboards.');
    }
    streamClients++;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...COMMON_SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    let pending: NodeJS.Timeout | null = null;
    let lastSentAt = 0;
    // FF777 CDU mirror bookkeeping: what this client already has, per screen.
    const sentScreens = new Map<string, string>();
    let sentCduNull = false;
    let lastCduAt = 0;
    const send = () => {
      if (closed) return;
      if (sessionExpiry(req) === null) {
        res.write('event: auth\ndata: {}\n\n');
        cleanup();
        res.end();
        return;
      }
      res.write(`event: state\ndata: ${JSON.stringify(currentState())}\n\n`);
      lastSentAt = Date.now();
      sendCdu();
    };
    // FF777 CDU mirror (mobile-data friendly): only the screens that changed,
    // at most once per second. `partial: true` = merge into what the client has.
    const sendCdu = () => {
      const now = Date.now();
      if (now - lastCduAt < 1000) return;
      const mirror = buildCduMirror(sim.status());
      if (!mirror) {
        if (!sentCduNull) {
          res.write('event: cdu\ndata: null\n\n');
          sentCduNull = true;
          sentScreens.clear();
          lastCduAt = now;
        }
        return;
      }
      sentCduNull = false;
      const changed = mirror.screens.filter((s) => sentScreens.get(s.side) !== JSON.stringify(s));
      if (changed.length === 0) return;
      const partial = sentScreens.size > 0 && mirror.screens.every((s) => sentScreens.has(s.side));
      for (const s of changed) sentScreens.set(s.side, JSON.stringify(s));
      res.write(`event: cdu\ndata: ${JSON.stringify({ ...mirror, screens: partial ? changed : mirror.screens, partial })}\n\n`);
      lastCduAt = now;
    };
    // At most one state push per STREAM_INTERVAL_MS: in flight X-Plane changes
    // something every frame, and 1 Hz is plenty for a phone on mobile data.
    // Pause/resume results don't wait for this; they come back on the POST.
    const off = sim.onChange(() => {
      pending ??= setTimeout(
        () => {
          pending = null;
          send();
        },
        Math.max(50, STREAM_INTERVAL_MS - (Date.now() - lastSentAt)),
      );
    });
    // Keeps ages current while nothing changes; also a keep-alive.
    const tick = setInterval(() => {
      if (!pending && Date.now() - lastSentAt >= STREAM_INTERVAL_MS) send();
    }, STREAM_INTERVAL_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      streamClients--;
      off();
      clearInterval(tick);
      if (pending) clearTimeout(pending);
    };
    req.raw.on('close', cleanup);
    res.write('retry: 2000\n\n');
    send();
  });

  // ------------------------------------------------------------------ control

  const controlRoute = (action: PauseAction) =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      if (!controlLimiter.take()) return sendError(reply, 429, 'rate_limited', 'Too many control requests. Wait a moment.');
      log.info(`${action} requested${tailnetUser(req)}`);
      const result: PauseResponse = await pause.request(action);
      reply.code(result.ok ? 200 : statusFor(result.error));
      return result;
    };
  const emptyBody = { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } };
  app.post('/api/sim/pause', emptyBody, controlRoute('pause'));
  app.post('/api/sim/resume', emptyBody, controlRoute('resume'));

  // ------------------------------------------------------------------ WebFMC

  app.get('/api/webfmc/status', async () => webfmc.status());

  const proxyHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (path === WEBFMC_MOUNT) return reply.redirect(`${WEBFMC_MOUNT}/`);
    const inm = req.headers['if-none-match'];
    const res = await webfmc.handle(path, req.method === 'HEAD' ? 'HEAD' : 'GET', typeof inm === 'string' ? inm : undefined);
    reply.code(res.status).headers(res.headers);
    return reply.send(res.body);
  };
  app.get(WEBFMC_MOUNT, proxyHandler);
  app.get(`${WEBFMC_MOUNT}/*`, proxyHandler);

  // WebSocket upgrades: only /webfmc/ws, with the same host/origin/session checks.
  app.server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (path !== `${WEBFMC_MOUNT}/ws` || !webfmc.enabled) return reject(404, 'Not Found');
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) return reject(421, 'Misdirected Request');
    if (!req.headers.origin || !isSameOrigin(req.headers)) return reject(403, 'Forbidden');
    if (sessionExpiry(req) === null) return reject(401, 'Unauthorized');
    webfmc.handleUpgrade(req, socket, head);
  });

  // ------------------------------------------------------------------ client

  const dist = opts.clientDist ?? null;
  const hasClient = Boolean(dist && existsSync(join(dist, 'index.html')));
  if (hasClient && dist) {
    await app.register(fastifyStatic, {
      root: dist,
      index: ['index.html'],
      // Look files up per request, so a rebuild is picked up without a restart.
      wildcard: true,
      // Vite assets are content-hashed and can be cached; HTML and other
      // unhashed files must revalidate so phones pick up new builds.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (req.method !== 'GET' || path.startsWith('/api/') || path.startsWith(`${WEBFMC_MOUNT}/`)) {
      return sendError(reply, 404, 'not_found', 'Not found.');
    }
    if (!hasClient) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('Client not built. Run `npm run build` (production) or use `npm run dev` and open http://localhost:5173.');
    }
    // SPA fallback
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  app.addHook('onClose', async () => webfmc.close());

  return { app, pause, webfmc };
}

function statusFor(error: Extract<PauseResponse, { ok: false }>['error']): number {
  switch (error) {
    case 'busy':
      return 409;
    case 'unavailable':
    case 'read_failed':
      return 503;
    case 'command_failed':
      return 502;
    case 'unconfirmed':
      return 504;
  }
}

function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).type('application/json; charset=utf-8').send({ error, message } satisfies ApiError);
}

/** Tailscale Serve adds the tailnet identity of the caller; logged for audit only, never trusted for auth. */
function tailnetUser(req: FastifyRequest): string {
  const login = req.headers['tailscale-user-login'];
  return typeof login === 'string' && login ? ` (tailnet user ${login.slice(0, 100)})` : '';
}

function adaptLogger(l: FastifyBaseLogger): Logger {
  return {
    debug: (m) => l.debug(m),
    info: (m) => l.info(m),
    warn: (m) => l.warn(m),
    error: (m) => l.error(m),
  };
}
