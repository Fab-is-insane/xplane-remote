# Troubleshooting

Run commands in **PowerShell on the Windows PC** unless stated otherwise.

## The app won't start

| Message | Fix |
|---|---|
| `Invalid configuration: APP_PASSWORD must be set…` | Run `npm run setup` (creates/repairs `.env`). |
| `Port 8787 is already in use` | Another copy is running. Close it, or find it: `Get-NetTCPConnection -LocalPort 8787 -State Listen \| Select OwningProcess`. You can also set `PORT=` in `.env`. If you change the port, re-run `tailscale serve --bg <port>`. |
| `Client not built` in the browser | Run `npm run build` before `npm start` (or use `npm run dev`). |
| `XPLANE_API_URL must point at this PC` | Only `127.0.0.1` / `localhost` upstreams are allowed, by design. |

## Dashboard says "Sim offline"

```powershell
Invoke-RestMethod http://127.0.0.1:8086/api/capabilities
```

- **Connection refused**: X-Plane isn't running, is still starting, or was launched with `--no_web_server`.
- **HTTP 403**: X-Plane → *Settings → Network* → turn **off** "Disable Incoming Traffic".
- **Custom port**: if X-Plane uses `--web_server_port=NNNN`, set `XPLANE_API_URL=http://127.0.0.1:NNNN`.
- X-Plane's own log: `D:\X-Plane 12\Log.txt` contains `I/WEBSRV: Port 8086 bound` when the API is up.

## "No flight"

X-Plane exposes no datarefs until a flight is loaded. Start a flight; the app connects within a few seconds.

## "Stale"

X-Plane hasn't answered for over 3 s. This is common during heavy scenery loading or when the sim is frozen. It recovers by itself. If it persists, the server log shows the reason (for example `Connection lost (…); reconnecting…`).

## Pause/Resume says "not confirmed"

The command was accepted, but `sim/time/paused` didn't change within 3 s.
- Look at the sim. A modal dialog or loading screen can delay it.
- Increase `PAUSE_CONFIRM_TIMEOUT_MS` in `.env` (e.g. `6000`).
- If the on/off commands misbehave in your X-Plane build, set `PAUSE_COMMAND_MODE=toggle`.

## Controls are greyed out

They are enabled only with **Live** telemetry and when the server reports control available. The reason is shown under the buttons, e.g. *Command activation needs X-Plane 12.1.4 or newer*.

## T/D shows "—" or "No T/D"

- "—" with *needs the Zibo 737 FMC datarefs*: a different aircraft is loaded, or the Zibo is still loading (it is re-checked every 15 s and after aircraft changes).
- **No T/D**: enter a route, set CRZ ALT, and EXECUTE PERF INIT in the FMC.
- **Calculating**: the Zibo FMC is recomputing the VNAV path (e.g. right after a route change).

## WebFMC panel

```powershell
(Test-NetConnection 127.0.0.1 -Port 9090).TcpTestSucceeded
Get-Content "D:\X-Plane 12\WebFMC-log.txt" -Tail 20
```

- *not answering on 127.0.0.1:9090*: WebFMC starts with X-Plane (plugin). Start X-Plane; the panel re-checks every 15 s.
- *builds its WebSocket address differently / unrecognised page layout*: a WebFMC update changed the client code that the proxy adapts. Use **Open WebFMC directly** (set `WEBFMC_DIRECT_URL`).
- Panel loads but shows WebFMC's "CONNECTION ERROR": reload the panel (↻). If it persists, check the server log for WebSocket errors.

## Phone can't reach the dashboard

1. Tailscale is **on** on the phone and shows the PC as connected.
2. On the PC: `tailscale serve status` lists `https://<pc>.<tailnet>.ts.net` → `http://127.0.0.1:8787`.
3. On the PC: `Invoke-RestMethod http://127.0.0.1:8787/api/health` returns `ok: True`.
4. Use the exact MagicDNS name: `(tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')`.
5. If `tailscale serve` printed a link about HTTPS certificates, open it and enable HTTPS for your tailnet, then run the command again.
6. Windows sleep: the PC must stay awake while you're away (Settings → System → Power → Sleep: *Never* while plugged in).

`tailscale status` showing *"Tailscale is starting"* / `NoState` means the Tailscale service is not up. Open the Tailscale app and sign in.

## "This server does not answer to that host name" (HTTP 421)

You opened the app by a name not in `ALLOWED_HOSTS` (e.g. the PC's LAN IP). Use the MagicDNS name, or add the name to `ALLOWED_HOSTS`. Avoid adding raw IPs unless you need them.

## Signed out unexpectedly

Sessions end after `SESSION_TTL_HOURS` (default 30 days), or immediately when `APP_PASSWORD` or `SESSION_SECRET` changes.

## Too many failed attempts

After 10 wrong passwords in 10 minutes, sign-in locks for 10 minutes. Restarting the app also clears the lock.
