// Password login → HMAC-signed, HttpOnly session cookie.
//
// The signing key is derived from SESSION_SECRET *and* APP_PASSWORD, so
// changing either one in .env immediately invalidates every existing session
// (that is the "revoke all devices" switch).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'xpr_session';

interface SessionPayload {
  v: 1;
  iat: number;
  exp: number;
}

export class SessionManager {
  private readonly key: Buffer;
  private readonly passwordDigest: Buffer;

  constructor(
    password: string,
    sessionSecret: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.passwordDigest = sha256(password);
    this.key = createHmac('sha256', sessionSecret).update('xplane-remote/session/v1').update(this.passwordDigest).digest();
  }

  /** Constant-time password comparison (hashes first so lengths always match). */
  checkPassword(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) return false;
    return timingSafeEqual(sha256(candidate), this.passwordDigest);
  }

  issue(): { token: string; expiresAt: number } {
    const iat = this.now();
    const payload: SessionPayload = { v: 1, iat, exp: iat + this.ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, expiresAt: payload.exp };
  }

  /** Returns the expiry time if the token is valid, otherwise null. */
  verify(token: string | undefined | null): number | null {
    if (!token || token.length > 512) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(this.sign(body), 'base64url');
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
      if (p.v !== 1 || typeof p.exp !== 'number' || p.exp <= this.now()) return null;
      return p.exp;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

/**
 * Global brute-force guard for the login endpoint. Behind Tailscale Serve
 * every request comes from 127.0.0.1, so a per-IP limit would be meaningless;
 * a global failure budget is simple and effective for a single-user app.
 */
export class LoginThrottle {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60_000,
    private readonly lockMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until login is allowed again, or 0. */
  retryAfterMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  recordFailure() {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.maxFailures) {
      this.lockedUntil = t + this.lockMs;
      this.failures = [];
    }
  }

  recordSuccess() {
    this.failures = [];
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function serializeSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function sha256(s: string | Buffer): Buffer {
  return createHash('sha256').update(s).digest();
}
