import { describe, expect, it } from 'vitest';
import { LoginThrottle, SessionManager, parseCookies, serializeSessionCookie } from '../src/auth.js';
import { isAllowedHost, isSameOrigin } from '../src/security.js';

const PASSWORD = 'correct-horse-battery';
const SECRET = 'x'.repeat(40);

describe('SessionManager', () => {
  it('accepts only the configured password', () => {
    const s = new SessionManager(PASSWORD, SECRET, 60_000);
    expect(s.checkPassword(PASSWORD)).toBe(true);
    expect(s.checkPassword('wrong')).toBe(false);
    expect(s.checkPassword('')).toBe(false);
    expect(s.checkPassword(undefined)).toBe(false);
    expect(s.checkPassword('a'.repeat(1000))).toBe(false);
  });

  it('issues tokens that verify until they expire', () => {
    let now = 1_000;
    const s = new SessionManager(PASSWORD, SECRET, 60_000, () => now);
    const { token, expiresAt } = s.issue();
    expect(s.verify(token)).toBe(expiresAt);
    now += 60_001;
    expect(s.verify(token)).toBeNull();
  });

  it('rejects tampered tokens', () => {
    const s = new SessionManager(PASSWORD, SECRET, 60_000);
    const { token } = s.issue();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: Date.now() + 1e9 })).toString('base64url');
    expect(s.verify(`${forged}.${sig}`)).toBeNull();
    expect(s.verify(`${body}.AAAA`)).toBeNull();
    expect(s.verify('garbage')).toBeNull();
    expect(s.verify(undefined)).toBeNull();
  });

  it('invalidates all sessions when the password or secret changes', () => {
    const { token } = new SessionManager(PASSWORD, SECRET, 60_000).issue();
    expect(new SessionManager('another-password!', SECRET, 60_000).verify(token)).toBeNull();
    expect(new SessionManager(PASSWORD, 'y'.repeat(40), 60_000).verify(token)).toBeNull();
  });
});

describe('LoginThrottle', () => {
  it('locks after repeated failures and unlocks after the lock period', () => {
    let now = 0;
    const t = new LoginThrottle(3, 60_000, 30_000, () => now);
    t.recordFailure();
    t.recordFailure();
    expect(t.retryAfterMs()).toBe(0);
    t.recordFailure();
    expect(t.retryAfterMs()).toBe(30_000);
    now += 30_000;
    expect(t.retryAfterMs()).toBe(0);
  });
});

describe('cookies', () => {
  it('serialises a hardened session cookie', () => {
    const c = serializeSessionCookie('abc', 3600, true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Secure');
    expect(serializeSessionCookie('abc', 3600, false)).not.toContain('Secure');
  });

  it('parses cookie headers', () => {
    expect(parseCookies('a=1; xpr_session=tok.sig; b=2')).toEqual({ a: '1', xpr_session: 'tok.sig', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('host and origin checks', () => {
  const allowed = ['localhost', '127.0.0.1', '::1', '*.ts.net'];
  it('allows loopback and tailnet names only', () => {
    expect(isAllowedHost('127.0.0.1:8787', allowed)).toBe(true);
    expect(isAllowedHost('localhost:5173', allowed)).toBe(true);
    expect(isAllowedHost('[::1]:8787', allowed)).toBe(true);
    expect(isAllowedHost('my-pc.tail1234.ts.net', allowed)).toBe(true);
    expect(isAllowedHost('evil.example.com', allowed)).toBe(false);
    expect(isAllowedHost('ts.net', allowed)).toBe(false);
    expect(isAllowedHost('evilts.net', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it('allows Tailscale IPs via a CIDR entry, nothing else', () => {
    const ts = [...allowed, '100.64.0.0/10'];
    expect(isAllowedHost('100.124.45.38:8787', ts)).toBe(true);
    expect(isAllowedHost('100.64.0.1', ts)).toBe(true);
    expect(isAllowedHost('100.127.255.255', ts)).toBe(true);
    expect(isAllowedHost('100.128.0.1:8787', ts)).toBe(false);
    expect(isAllowedHost('192.168.1.20:8787', ts)).toBe(false);
    expect(isAllowedHost('100.124.45.38.evil.com', ts)).toBe(false);
    expect(isAllowedHost('100.124.45.38:8787', allowed)).toBe(false);
  });

  it('requires Origin to match the requested host', () => {
    expect(isSameOrigin({ host: 'pc.tail.ts.net', origin: 'https://pc.tail.ts.net' })).toBe(true);
    expect(isSameOrigin({ host: 'pc.tail.ts.net:443', origin: 'https://pc.tail.ts.net' })).toBe(true);
    expect(isSameOrigin({ host: '127.0.0.1:8787', 'x-forwarded-host': 'pc.tail.ts.net', origin: 'https://pc.tail.ts.net' })).toBe(true);
    expect(isSameOrigin({ host: 'pc.tail.ts.net', origin: 'https://evil.example.com' })).toBe(false);
    expect(isSameOrigin({ host: 'pc.tail.ts.net', origin: 'null' })).toBe(false);
    expect(isSameOrigin({ host: 'pc.tail.ts.net' })).toBe(true); // non-browser client; still needs a session
  });
});

describe('PIN configuration', () => {
  it('accepts a 4-digit PIN and rejects shorter ones', async () => {
    const { loadConfig, ConfigError } = await import('../src/config.js');
    expect(loadConfig({ APP_PASSWORD: '5463', SESSION_SECRET: 's'.repeat(40) }).appPassword).toBe('5463');
    expect(() => loadConfig({ APP_PASSWORD: '123', SESSION_SECRET: 's'.repeat(40) })).toThrow(ConfigError);
    const s = new SessionManager('5463', SECRET, 60_000);
    expect(s.checkPassword('5463')).toBe(true);
    expect(s.checkPassword('5464')).toBe(false);
  });
});
