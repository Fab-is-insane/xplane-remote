# Security and threat model

X-Plane Remote can pause and resume a simulator and show an FMC that accepts key presses.
That is low-stakes compared with most software, but this design keeps the PC from being exposed through it.

## Assets

| Asset | Why it matters |
|---|---|
| Control of the simulator (pause/resume, WebFMC key presses) | Someone else pausing your 8-hour flight, or typing into the FMC. |
| The PC's local services (X-Plane API on 8086, WebFMC on 9090, anything else on localhost) | The app must not become a bridge from the network to them. |
| `APP_PASSWORD` / `SESSION_SECRET` | Grant the above. |

## Trust boundaries

```
Internet ──✗── (no Funnel, no port forwarding)
Tailnet devices ──HTTPS──▶ Tailscale Serve ──▶ 127.0.0.1:8787 (this app) ──▶ 127.0.0.1:8086 / :9090
Browser on the PC ──────────────────────────▶ 127.0.0.1:8787
```

## Controls

**Network exposure**
- The app listens on `127.0.0.1` only (`HOST`). It logs a warning if configured otherwise.
- Remote access is through **Tailscale Serve**: tailnet devices only, WireGuard-encrypted, HTTPS with a valid certificate. Funnel and router port-forwarding are not used.
- The X-Plane Web API stays on loopback. It is never published through Tailscale.

**Authentication**
- Password login. The comparison is constant-time on SHA-256 digests, and the input length is capped.
- Session = HMAC-SHA256-signed cookie (`HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS), 30-day expiry. The key is derived from `SESSION_SECRET` + the password, so changing either one revokes every session.
- A global brute-force guard: 10 failures / 10 min → 10 min lock, plus a 400 ms delay per failure. It is global because every request arrives from 127.0.0.1 behind Serve.
- Every endpoint except `GET /api/health` and the login route requires a session. That includes read-only telemetry and the WebFMC proxy, because WebFMC buttons change FMC state.

**Request integrity**
- **Host allow-list** (`ALLOWED_HOSTS`, default `localhost, 127.0.0.1, ::1, *.ts.net`) → HTTP 421 otherwise. This defeats DNS-rebinding attacks from a malicious web page opened on the PC itself.
- **CSRF**: every POST/DELETE must (a) carry `X-XPR-Request: 1` (a cross-site page cannot add it without a CORS preflight, which is never approved), (b) be `application/json`, and (c) have an `Origin` matching the requested host when the browser sends one. The cookie is also `SameSite=Strict`.
- **No CORS** headers are sent, so other origins cannot read responses.
- **Input validation**: JSON schemas reject unknown fields (`removeAdditional: false`). The body limit is 4 KB. Control endpoints accept only `{}`.
- **Rate limit**: 30 control requests per minute.

**Least privilege towards X-Plane**
- The only simulator actions in the code are `sim/operation/pause_on`, `pause_off` and `pause_toggle`. They are allow-listed in `datarefs.ts` and checked again before activation.
- **No dataref is ever written.** There is no endpoint that accepts a command name, dataref name, URL or port. The tests assert that generic routes like `/api/command` do not exist.
- Upstream URLs (`XPLANE_API_URL`, `WEBFMC_URL`) must be loopback `http://` origins without a path; anything else fails at start-up. The proxy cannot be pointed elsewhere at runtime.

**WebFMC proxy**
- Fixed upstream; only `GET /`, `GET /static/<safe-file-name>` and the `/ws` upgrade are forwarded. Dot segments, back-slashes and double slashes are refused.
- Request headers are not forwarded, so your session cookie never reaches WebFMC. The upstream WebSocket is opened with WebFMC's own origin.
- WebFMC's security headers are passed through. The app adds `frame-ancestors 'self'` so only this app can frame it.
- The WebSocket upgrade requires an allowed host, a matching `Origin` and a valid session.

**Browser hardening (app pages)**
- CSP: `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`.
- The browser never talks to `localhost` services directly. Everything goes through the app's own origin.

**Secrets**
- `.env` is git-ignored. `.env.example` contains no secrets. `npm run setup` generates a 20-character password (~99 bits) and a 256-bit session secret locally.
- Tailscale Serve adds a `Tailscale-User-Login` header. The app logs it next to sign-ins and control actions for auditing, but **never** uses it for authorization.

## Threats considered

| Threat | Mitigation |
|---|---|
| Stranger on the internet | Not reachable: loopback bind, Serve is tailnet-only, no Funnel / port forward. |
| Another device or user in your tailnet | Must know the password. Use Tailscale ACLs to limit which devices can reach the PC. |
| Malicious website opened on the phone or PC (CSRF / DNS rebinding) | SameSite=Strict cookie, custom header, Origin check, Host allow-list, no CORS. |
| Password guessing | Long random password, global lockout, per-failure delay. |
| Lost/stolen phone | Remove it from the tailnet (admin console → Machines) and/or `npm run setup -- --rotate`. |
| Abuse of the app as a proxy to other local services | Fixed loopback upstreams, path allow-list, no user-supplied URLs. |
| Arbitrary simulator control | Only three allow-listed commands; no dataref writes; no generic endpoints. |
| False reassurance ("it said paused but wasn't") | Success is reported only when X-Plane's `sim/time/paused` confirms the state. |

## Residual risks and notes

### WebFMC (port 9090)
WebFMC listens on **all interfaces** without authentication. Its own log shows a phone on a Tailscale IP connecting directly. That exposure exists without this app, which neither creates nor changes it. If you want WebFMC reachable *only* through this app's login, you could add a Windows Firewall rule that blocks inbound TCP 9090 from other machines. That changes your system configuration, so it is not done automatically, and it would also stop any other device that uses WebFMC directly.

### Same-origin WebFMC
WebFMC runs on the app's origin inside the iframe, so its JavaScript is trusted like the app's own. That is acceptable because it is software you installed locally. Do not proxy anything you do not trust this way.

### Single password
There are no per-user accounts. Sessions are stateless and cannot be revoked one by one; rotate the password to revoke all of them.
