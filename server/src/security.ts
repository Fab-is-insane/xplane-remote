// Request-level protections shared by HTTP routes and WebSocket upgrades.

import type { IncomingHttpHeaders } from 'node:http';

/** Hostname part of a Host header value ("pc.tailnet.ts.net:443" → "pc.tailnet.ts.net"). */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

/**
 * Match against ALLOWED_HOSTS entries:
 *   "*.ts.net"       any subdomain of ts.net (MagicDNS names)
 *   "100.64.0.0/10"  any IPv4 address in that range (Tailscale IPs)
 *   anything else    exact host name / IP
 */
export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  return allowed.some((pattern) => {
    const p = pattern.replace(/^\[|\]$/g, '');
    if (p.includes('/')) return ipv4InCidr(name, p);
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".ts.net"
      return name.endsWith(suffix) && name.length > suffix.length;
    }
    return name === p;
  });
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipN = ipv4ToInt(ip);
  const baseN = base === undefined ? null : ipv4ToInt(base);
  if (ipN === null || baseN === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(ipN / size) === Math.floor(baseN / size);
}

/**
 * Same-origin check for state-changing requests and WebSocket upgrades.
 * The Origin header (sent by browsers on POST/DELETE and WS) must name the
 * same host the request was addressed to. Requests without an Origin header
 * (non-browser clients) are allowed through to the auth check.
 */
export function isSameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    const o = new URL(origin).host.toLowerCase();
    // X-Forwarded-Host is set by Tailscale Serve. A cross-site page cannot add
    // it without a CORS preflight, which this server never approves.
    const candidates = [headers.host, firstHeader(headers['x-forwarded-host'])]
      .filter((h): h is string => Boolean(h))
      .map((h) => h.toLowerCase());
    return candidates.some((h) => h === o || stripDefaultPort(h, o));
  } catch {
    return false;
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
}

// "pc.ts.net:443" vs origin host "pc.ts.net" (default port omitted by the browser).
function stripDefaultPort(hostHeader: string, originHost: string): boolean {
  return hostHeader === `${originHost}:443` || hostHeader === `${originHost}:80`;
}

/** True when the original request reached Tailscale Serve (or another proxy) over HTTPS. */
export function isHttpsRequest(headers: IncomingHttpHeaders): boolean {
  const xfp = headers['x-forwarded-proto'];
  const v = Array.isArray(xfp) ? xfp[0] : xfp;
  return v?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/** CSP for the app's own pages. WebFMC responses get their own (see webfmc/proxy.ts). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const COMMON_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Fixed-window counter used to cap control requests. */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if allowed (and records the hit). */
  take(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}
