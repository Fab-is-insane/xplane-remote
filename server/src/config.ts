// Loads and validates configuration from environment variables (.env).
// Any problem is collected and reported together so the user can fix the
// whole .env in one pass.

export interface AppConfig {
  host: string;
  port: number;
  xplaneApiUrl: URL;
  xplaneRequestTimeoutMs: number;
  telemetryStaleMs: number;
  pauseConfirmTimeoutMs: number;
  pauseCommandMode: 'auto' | 'toggle';
  xplaneMock: boolean;
  webfmcEnabled: boolean;
  webfmcUrl: URL;
  webfmcDirectUrl: string | null;
  appPassword: string;
  sessionSecret: string;
  sessionTtlMs: number;
  allowedHosts: string[];
  cookieSecure: 'auto' | 'always' | 'never';
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const problems: string[] = [];

  const str = (key: string, def: string): string => {
    const v = env[key];
    return v === undefined || v.trim() === '' ? def : v.trim();
  };

  const int = (key: string, def: number, min: number, max: number): number => {
    const raw = str(key, String(def));
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
      return def;
    }
    return n;
  };

  const bool = (key: string, def: boolean): boolean => {
    const raw = str(key, def ? 'true' : 'false').toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    problems.push(`${key} must be true or false (got "${raw}")`);
    return def;
  };

  const loopbackUrl = (key: string, def: string): URL => {
    const raw = str(key, def);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${key} is not a valid URL (got "${raw}")`);
      return new URL(def);
    }
    if (url.protocol !== 'http:') {
      problems.push(`${key} must use http:// (got "${url.protocol}")`);
    }
    // Only loopback targets are allowed so this app can never be used to
    // reach arbitrary hosts on the network.
    if (!isLoopbackHostname(url.hostname)) {
      problems.push(`${key} must point at this PC (127.0.0.1 / localhost), got "${url.hostname}"`);
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      problems.push(`${key} must not contain a path or query (got "${raw}")`);
    }
    return url;
  };

  const host = str('HOST', '127.0.0.1');
  const port = int('PORT', 8787, 1, 65535);
  const xplaneApiUrl = loopbackUrl('XPLANE_API_URL', 'http://127.0.0.1:8086');
  const webfmcUrl = loopbackUrl('WEBFMC_URL', 'http://127.0.0.1:9090');

  let webfmcDirectUrl: string | null = str('WEBFMC_DIRECT_URL', '') || null;
  if (webfmcDirectUrl) {
    try {
      const u = new URL(webfmcDirectUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      webfmcDirectUrl = u.toString();
    } catch {
      problems.push(`WEBFMC_DIRECT_URL must be an http(s) URL (got "${webfmcDirectUrl}")`);
      webfmcDirectUrl = null;
    }
  }

  const xplaneMock = bool('XPLANE_MOCK', false);

  const appPassword = (env.APP_PASSWORD ?? '').trim();
  if (appPassword.length < 4) {
    problems.push('APP_PASSWORD must be set and at least 4 characters long (run `npm run setup`)');
  }
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set and at least 32 characters long (run `npm run setup`)');
  }

  const pauseMode = str('PAUSE_COMMAND_MODE', 'auto').toLowerCase();
  if (pauseMode !== 'auto' && pauseMode !== 'toggle') {
    problems.push(`PAUSE_COMMAND_MODE must be "auto" or "toggle" (got "${pauseMode}")`);
  }

  const cookieSecure = str('COOKIE_SECURE', 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(cookieSecure)) {
    problems.push(`COOKIE_SECURE must be auto, always or never (got "${cookieSecure}")`);
  }

  const allowedHosts = str('ALLOWED_HOSTS', 'localhost,127.0.0.1,::1,*.ts.net,100.64.0.0/10')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length === 0) problems.push('ALLOWED_HOSTS must list at least one host');

  const config: AppConfig = {
    host,
    port,
    xplaneApiUrl,
    xplaneRequestTimeoutMs: int('XPLANE_REQUEST_TIMEOUT_MS', 2000, 200, 30000),
    telemetryStaleMs: int('TELEMETRY_STALE_MS', 3000, 500, 60000),
    pauseConfirmTimeoutMs: int('PAUSE_CONFIRM_TIMEOUT_MS', 3000, 500, 30000),
    pauseCommandMode: pauseMode === 'toggle' ? 'toggle' : 'auto',
    xplaneMock,
    webfmcEnabled: bool('WEBFMC_ENABLED', true),
    webfmcUrl,
    webfmcDirectUrl,
    appPassword,
    sessionSecret,
    sessionTtlMs: int('SESSION_TTL_HOURS', 720, 1, 24 * 365) * 3600_000,
    allowedHosts,
    cookieSecure: cookieSecure as AppConfig['cookieSecure'],
    logLevel: str('LOG_LEVEL', 'info'),
    ...overrides,
  };

  if (problems.length) throw new ConfigError(problems);
  return config;
}
