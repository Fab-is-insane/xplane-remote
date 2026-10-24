// Entry point: load .env, validate config, connect to X-Plane, serve the app.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { buildApp } from './app.js';
import { ConfigError, isLoopbackHostname, loadConfig, type AppConfig } from './config.js';
import { XPlaneConnection } from './xplane/connection.js';
import { MockSimulator } from './xplane/mockSimulator.js';
import type { SimSource } from './xplane/simSource.js';

// server/src or server/dist → repository root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config: AppConfig;
try {
  config = loadConfig(process.env, process.argv.includes('--mock') ? { xplaneMock: true } : {});
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    if (!existsSync(envFile)) console.error('No .env file found. Create one with:  npm run setup\n');
    process.exit(1);
  }
  throw err;
}

const logger = pino({
  level: config.logLevel,
  ...(process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});

if (!isLoopbackHostname(config.host)) {
  logger.warn(
    `HOST=${config.host} is not a loopback address. The app is then reachable directly on that interface; ` +
      'the recommended setup is HOST=127.0.0.1 behind Tailscale Serve.',
  );
}

const simLogger = logger.child({ module: 'xplane' });
const sim: SimSource = config.xplaneMock
  ? new MockSimulator()
  : new XPlaneConnection({
      baseUrl: config.xplaneApiUrl,
      requestTimeoutMs: config.xplaneRequestTimeoutMs,
      pauseCommandMode: config.pauseCommandMode,
      logger: {
        debug: (m) => simLogger.debug(m),
        info: (m) => simLogger.info(m),
        warn: (m) => simLogger.warn(m),
        error: (m) => simLogger.error(m),
      },
    });

if (config.xplaneMock) {
  logger.warn('*** MOCK MODE: using a simulated aircraft. Nothing shown is live X-Plane data. ***');
}

const { app } = await buildApp({ config, sim, logger, clientDist: join(repoRoot, 'client', 'dist') });

sim.start();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  logger.error(
    code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use. Stop the other process or set PORT in .env.`
      : `Could not start server: ${(err as Error).message}`,
  );
  await sim.stop();
  process.exit(1);
}

logger.info(`X-Plane Remote listening on http://${config.host}:${config.port}`);
logger.info(`X-Plane Web API: ${config.xplaneApiUrl.origin}   WebFMC: ${config.webfmcEnabled ? config.webfmcUrl.origin : 'disabled'}`);
logger.info('Remote access: run `tailscale serve --bg ' + config.port + '` once (see README), then open https://<pc>.<tailnet>.ts.net');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await app.close().catch(() => {});
  await sim.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
