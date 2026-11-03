# X-Plane Remote

A private, mobile-first flight companion for **X-Plane 12**, with FMC support for the **Zibo 737-800** and the **FlightFactor 777v2**.
It runs on your Windows PC next to the simulator. From your phone (over Tailscale) you can:

- see whether X-Plane is connected, and whether it is **PAUSED** or **RUNNING**;
- **pause** and **resume** the sim. Success is reported only after X-Plane itself confirms the new state;
- watch altitude, ground speed, IAS, vertical speed, heading, position and the **distance to T/D** (from the Zibo FMC);
- use your existing **WebFMC** in the same page.

```
 Phone (browser)                          Windows PC
 ───────────────                          ─────────────────────────────────────────────
 https://my-pc.tailnet.ts.net  ──WireGuard──▶ Tailscale Serve (HTTPS, tailnet only)
                                                   │  http://127.0.0.1:8787
                                                   ▼
                                           X-Plane Remote (Node, loopback only)
                                            ├─ REST + WebSocket ─▶ X-Plane Web API 127.0.0.1:8086
                                            └─ /webfmc/ proxy   ─▶ WebFMC          127.0.0.1:9090
```

Contents: [Architecture](#1-architecture) · [Prerequisites](#2-prerequisites) · [Setup](#3-windows-setup) ·
[Commands](#4-development-commands) · [Production](#5-production-build) · [Start](#6-starting-the-app) ·
[X-Plane](#7-x-plane-api-access) · [WebFMC](#8-webfmc) · [Tailscale](#9-tailscale-serve) · [Phone](#10-using-it-from-your-phone) ·
[Auth](#11-authentication) · [Troubleshooting](#12-troubleshooting) · [Limitations](#13-known-limitations) · [Stop/revoke](#14-stopping-and-revoking-access)

---

## 1. Architecture

| Path | What it is |
|---|---|
| `server/` | Node.js + TypeScript + Fastify. X-Plane integration, auth, live state stream, WebFMC proxy, and serving the built client. |
| `server/src/xplane/` | `restClient.ts` (Web API REST), `connection.ts` (discovery, WebSocket telemetry, reconnect), `pauseController.ts` (state-aware pause/resume), `datarefs.ts` (the only datarefs and commands used, by name), `mockSimulator.ts` (dev only). |
| `server/src/webfmc/proxy.ts` | Same-origin proxy for WebFMC (see [§8](#8-webfmc)). |
| `server/src/shared/api-types.ts` | The API contract shared with the client. |
| `server/test/` | Vitest suite with a fake X-Plane Web API, so the simulator is not needed. |
| `client/` | React + TypeScript + Vite dashboard. |
| `docs/` | [Security & threat model](docs/SECURITY.md), [troubleshooting](docs/TROUBLESHOOTING.md), [investigation notes](docs/INVESTIGATION.md). |

**How X-Plane is used.** On start-up and after every reconnect the server:

1. calls `GET /api/capabilities`. X-Plane 12.4.3 offers API `v1`–`v3`; the server uses `v3`;
2. looks up every dataref and command **by name** (`?filter[name]=…`) and checks its `value_type`. Numeric IDs are session-specific and are never stored;
3. opens `ws://127.0.0.1:8086/api/v3` and subscribes to the datarefs (X-Plane pushes changes at 10 Hz);
4. re-reads `sim/time/paused` over REST every 2 s as a heartbeat. Telemetry is marked **stale** after 3 s without an answer;
5. reconnects with exponential backoff (1 s → 15 s) when X-Plane closes, restarts or stops answering.

**Pause/resume** (`server/src/xplane/pauseController.ts`):

1. read `sim/time/paused`. If the sim is already in the requested state, reply "already" and send **nothing**;
2. otherwise activate `sim/operation/pause_on` / `pause_off`. These are idempotent, so two clients pressing at once cannot double-toggle. If they are missing, the server falls back to `sim/operation/pause_toggle`;
3. poll `sim/time/paused` until it shows the requested state (3 s timeout). The phone shows success **only** then; otherwise it shows "unconfirmed" with the last real state.

Duplicate taps join the running request. The opposite action is refused while one is in flight. `sim/time/paused` is read-only and is never written.

## 2. Prerequisites

- Windows 10/11 with **X-Plane 12.1.4 or newer**. Command activation needs Web API v2; this PC has 12.4.3.
- **Node.js 20.12+** (this PC has 20.19.6): <https://nodejs.org>.
- **Tailscale** installed and signed in on the PC and the phone, both in the same tailnet.
- Optional: the Zibo 737-800 (for T/D) and the WebFMC plugin (for the FMC panel).

## 3. Windows setup

Use a normal **PowerShell** window (not as administrator) unless a step says otherwise.

```powershell
# 1. Go to the repository
cd "$env:USERPROFILE\OneDrive\Documents\GitHub\xplane-remote"

# 2. Install dependencies (client + server)
npm install

# 3. Create .env (sign-in PIN 5463 + a generated session secret)
npm run setup
```

The sign-in **PIN** defaults to `5463` (`APP_PASSWORD` in `.env`, which git ignores). Change it there if you like.
Open `.env` in an editor to review the other settings. The defaults match this PC. All options are documented in [`.env.example`](.env.example).

## 4. Development commands

| Command | Terminal | What it does |
|---|---|---|
| `npm run dev` | PowerShell #1 | Backend on `127.0.0.1:8787` (auto-reload) + Vite dashboard on <http://localhost:5173> |
| `npm run dev:mock` | PowerShell #1 | Same, with the **mock simulator** (no X-Plane needed). A striped "MOCK DATA" banner is always shown. |
| `npm test` | PowerShell #2 | Runs the server test suite (no simulator needed) |
| `npm run typecheck` | PowerShell #2 | Type-checks server and client |

Mock mode is **off by default**. It is enabled only by `npm run dev:mock`, `--mock`, or `XPLANE_MOCK=true`. Mock data is always labelled `source: "mock"`.

## 5. Production build

```powershell
npm run build      # compiles server/dist and client/dist
```

## 6. Starting the app

```powershell
cd "$env:USERPROFILE\OneDrive\Documents\GitHub\xplane-remote"
npm start
```

Leave this window open while you fly. You should see:

```
X-Plane Remote listening on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787> on the PC to check it works. You can start the app before or after X-Plane; it connects as soon as the sim is up.

## 7. X-Plane API access

The Web API is built into X-Plane 12 and enabled by default on `127.0.0.1:8086`. It only listens locally, which is what we want. Check:

- **Settings → Network**: *Disable Incoming Traffic* must be **off**. When it is on, every API call returns HTTP 403 and the dashboard says so.
- Do not start X-Plane with `--no_web_server`. If you use `--web_server_port=NNNN`, set `XPLANE_API_URL=http://127.0.0.1:NNNN` in `.env`.
- Datarefs exist only once a flight is loaded. Until then the dashboard shows **No flight**.

Nothing in the X-Plane, Zibo or WebFMC folders is modified by this project.

## 8. WebFMC

WebFMC 2.4.1 serves its CDU on port 9090 (log: `D:\X-Plane 12\WebFMC-log.txt`). The dashboard embeds it through a **same-origin proxy** at `/webfmc/`:

- **Why not a plain iframe of `http://pc:9090`?** The dashboard is served over HTTPS by Tailscale Serve, and an HTTPS page may not embed an `http://` page (mixed content). WebFMC's client also hard-codes `"ws://"+location.hostname+":"+location.port+"/ws"` and root-absolute `/static/...` paths.
- **What the proxy does:** it forwards only `/`, `/static/<file>` and the `/ws` WebSocket to `127.0.0.1:9090`. In transit it rewrites three things: asset paths in the HTML and CSS, webpack's public path, and that WebSocket URL expression (so it becomes `wss://<this host>/webfmc/ws`). WebFMC's own security headers are passed through unchanged. Files on disk are not touched, and the proxy is behind the app login.
- **Fallback:** if WebFMC is not running, the panel says so and keeps re-checking every 15 s. If a future WebFMC version changes the code the proxy adapts, the panel says embedding is unsupported. Either way it offers **Open via app** (new tab) and, if configured, **Open WebFMC directly**.

To show the direct button, set in `.env` (use your MagicDNS name from [§9](#9-tailscale-serve)):

```
WEBFMC_DIRECT_URL=http://my-pc.tailnet-name.ts.net:9090
```

> WebFMC itself listens on all interfaces, so it is already reachable on port 9090 from your tailnet, without a password. That is how WebFMC works on its own and is independent of this app. See [docs/SECURITY.md](docs/SECURITY.md#webfmc-port-9090).

Set `WEBFMC_ENABLED=false` to hide the panel completely.

## 9. Tailscale Serve

Tailscale Serve publishes the app **only to devices in your tailnet**, with HTTPS and a real certificate. Do **not** use `tailscale funnel` (public internet), and do not port-forward on your router.

Run in PowerShell on the PC while the app is running (`npm start`):

```powershell
# Confirm Tailscale is signed in and connected
tailscale status

# Forward port 8787 on this PC's Tailscale address to the app (tailnet only)
tailscale serve --bg --tcp=8787 tcp://127.0.0.1:8787

# Show what is being served
tailscale serve status
```

The dashboard is then at **`http://<tailscale-ip>:8787`** (on this PC: `http://100.124.45.38:8787`), or `http://desktop-gi30sno-1:8787`.
It is plain HTTP inside the tailnet, but Tailscale's WireGuard tunnel encrypts it end to end.
The `100.64.0.0/10` entry in `ALLOWED_HOSTS` lets the app answer to Tailscale IPs. TCP mode is used because Serve's HTTP mode ignores requests addressed by IP.

**Optional HTTPS instead:** enable *HTTPS Certificates* in the admin console (DNS page). Then replace the TCP forward with
`tailscale serve --tcp=8787 off; tailscale serve --bg 8787` and open `https://desktop-gi30sno-1.tailfae815.ts.net`.

If the command says *access denied*, run it once from an **administrator** PowerShell, or sign in to the Tailscale app on the PC as the same Windows user.
`--bg` keeps serving after you close the terminal **and after reboots** until you remove it ([§14](#14-stopping-and-revoking-access)).

**Find your MagicDNS name:**

```powershell
(tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
# → e.g. my-pc.tail1234.ts.net
```


## 10. Using it from your phone

1. Turn Tailscale **on** on the phone (same account/tailnet as the PC).
2. Open `http://100.124.45.38:8787` in Chrome or Safari.
3. Enter the PIN (`5463` by default). The session lasts 30 days on that device (`SESSION_TTL_HOURS`).
4. Optional: *Add to Home Screen* for an app-like icon.

What the header tells you:

| Pill | Meaning |
|---|---|
| **Live** (green) | Fresh telemetry from X-Plane. Controls enabled. |
| **Stale** (amber) | X-Plane stopped answering for >3 s. Values shown are the last received. Controls disabled. |
| **No flight** / **Connecting** (amber) | X-Plane is up but no flight is loaded / still connecting. |
| **Sim offline** (red) | X-Plane's Web API is not reachable (sim closed or API disabled). |
| **Server offline** (red) | The phone cannot reach the app (PC asleep, app stopped, or Tailscale off). |

**Supported aircraft.** The app detects the aircraft from the datarefs it finds:

| Aircraft | T/D, destination, ETA | FMC panel |
|---|---|---|
| Zibo 737-800 | `laminar/B738/...` FMC datarefs (always on) | WebFMC (embedded) |
| FlightFactor 777v2 | **PROGRESS page 1** on any CDU: destination, distance and FMC ETA from the `DEST` line. T/D is an **estimate** (~, EST): DEST DTG − (3 NM per 1000 ft + 10), because the FF777 shows T/D only on the ND | Read-only **CDU mirror** (CAPT / CTR / F/O). WebFMC reports the FF777 as unsupported |
| Anything else | not available ("—") | WebFMC if it supports the aircraft |

The FF777's FMC publishes no route datarefs, so keep **PROGRESS page 1 open on one CDU**; the centre CDU is ideal. Otherwise the card asks you to. The tab with PROGRESS open is marked `PROG` in the mirror.
Pause/resume and the basic telemetry use X-Plane's own datarefs and work with any aircraft.

**After T/D** the card switches to **ETA to destination**. It shows a live estimate (FMC route distance `laminar/B738/FMS/dist_dest` ÷ current ground speed, with your local clock time) and the FMC's own ETA (`laminar/B738/FMS/time_dest`, Zulu). The live figure runs a little early in the descent because you slow down on approach; the FMC figure accounts for that. Details: [docs/INVESTIGATION.md](docs/INVESTIGATION.md#destination-eta-zibo-737).

**T/D** comes from the Zibo FMC dataref `laminar/B738/fms/vnav_td_dist` (along-track NM). The card shows *No T/D* until you have a route with CRZ ALT and executed PERF INIT, *Calculating* while the FMC recomputes, and *Passed* after T/D. With other aircraft it shows "—". The "≈ N min" figure is distance ÷ current ground speed, an estimate only. Details: [docs/INVESTIGATION.md](docs/INVESTIGATION.md#top-of-descent-zibo-737).

## 11. Authentication

- **PIN** (`APP_PASSWORD`, default `5463`, min 4 chars) is checked with a constant-time comparison. A short PIN is acceptable because the app is reachable only from your own tailnet (it listens on 127.0.0.1, so the hostel LAN cannot reach it), and guessing is rate-limited below. On success the server sets an **HttpOnly, SameSite=Strict** session cookie, marked *Secure* when the request came through Tailscale Serve's HTTPS. The cookie is HMAC-signed with a key derived from `SESSION_SECRET` **and** the PIN.
- **Everything** except `/api/health` and the login endpoint needs a session: telemetry, the stream, pause/resume, and the WebFMC proxy (WebFMC buttons can change the FMC).
- 10 wrong PINs within 10 minutes lock sign-in for 10 minutes.
- State-changing requests must also be same-origin and carry a custom header, and the server answers only to `localhost`, `127.0.0.1` and `*.ts.net` host names.
- To change the PIN: edit `APP_PASSWORD` in `.env` and restart `npm start`. All devices are signed out.

More: [docs/SECURITY.md](docs/SECURITY.md).

## 12. Troubleshooting

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**. Quick checks:

```powershell
# Is the app up?            (expects {"ok":true})
Invoke-RestMethod http://127.0.0.1:8787/api/health
# Is X-Plane's API up?      (expects api.versions and x-plane.version)
Invoke-RestMethod http://127.0.0.1:8086/api/capabilities
# Is WebFMC up?             (expects True)
(Test-NetConnection 127.0.0.1 -Port 9090).TcpTestSucceeded
# What is Tailscale serving?
tailscale serve status
```

## 13. Known limitations

- **Live-verified so far (2026-10-24, X-Plane 12.4.3, Zibo at the gate):** API v3 detection, discovery of every dataref/command by name, WebSocket telemetry, the Zibo T/D datarefs (reported *No T/D* with no route), and the WebFMC proxy (connects exactly like direct WebFMC). **Not yet verified live:** pause/resume confirmation and a T/D distance in flight. These are covered by tests against a fake Web API that follows the official documentation.
- **T/D** relies on Zibo-internal datarefs (verified in the Zibo **4.05.33** source). A future Zibo update could rename or change them; the card then shows "—" rather than a wrong number.
- **WebFMC embedding** depends on WebFMC 2.4.1's client code (see §8). Other versions fall back to *Open directly*. WebFMC's own "check for updates" request is blocked when it runs inside the HTTPS page (harmless).
- **Toggle fallback:** only if `pause_on/off` are unavailable (or `PAUSE_COMMAND_MODE=toggle`). Someone pressing pause at the PC at exactly the same moment could then race the toggle; the result is still read back and reported truthfully.
- **Single shared PIN**, no per-user accounts. Sessions cannot be revoked one by one; changing the PIN or rotating the session secret signs out all devices.
- If X-Plane freezes (e.g. a long scenery load), telemetry goes **stale** and controls are disabled until it answers again.

## 14. Stopping and revoking access

```powershell
# Stop the app: press Ctrl+C in the window running `npm start`.

# Stop publishing it to your tailnet (immediately, survives reboot):
tailscale serve --tcp=8787 off
# …or remove ALL serve configuration on this PC:
tailscale serve reset

# Sign out every phone/browser (new session secret), then restart the app:
npm run setup -- --rotate
```

You can also remove a lost phone from the tailnet in the Tailscale admin console → **Machines**.
