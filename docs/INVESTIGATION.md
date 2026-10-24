# Investigation notes

What was checked on this PC before implementation (2026-10-24), and what was **not** verified.

## Environment found

| Item | Finding | Source |
|---|---|---|
| X-Plane | **12.4.3-r2** at `D:\X-Plane 12` | `Log.txt` header |
| Web API | `I/WEBSRV: Port 8086 bound` (dual-stack, local only) | `Log.txt` |
| Aircraft | Zibo 737-800 at `Aircraft\B737-800X`, version **4.05.33** | `version.txt`, `Log.txt` |
| WebFMC | Plugin/backend **2.4.1**, HTTP port 9090, free tier, "zibo738" profile | `WebFMC-log.txt`, client JS |
| Node.js | 20.19.6 | `node --version` |
| Tailscale | 1.102.4. The service reported `NoState` ("starting") at the time, so MagicDNS name and Serve were not testable | `tailscale status` |
| Live processes | X-Plane and WebFMC were **not running**, so nothing was tested against a live simulator | port checks |

## X-Plane Web API

From <https://developer.x-plane.com/article/x-plane-web-api/>:

- REST `http://localhost:8086/api/v3/…`, WebSocket `ws://localhost:8086/api/v3`, same port.
- v1 (12.1.1): datarefs. **v2 (12.1.4): capabilities, commands list, command activation.** v3 (12.4.0): flight start/update.
- IDs are session-scoped (stable across aircraft loads, not across sim restarts). Lists are empty until a flight is loaded.
- `POST /command/{id}/activate {"duration": 0}` presses and releases immediately.
- WebSocket `dataref_subscribe_values` pushes `dataref_update_values` at 10 Hz with changed values only. One bad id fails the whole subscription request.
- "Disable Incoming Traffic" (Settings → Network) makes every method return 403.

With 12.4.3, v1–v3 should be available. The client still reads `/api/capabilities` at runtime and adapts: on a v1-only sim, control is disabled with an explanation.

## Pause

From `Resources/plugins/DataRefs.txt` and `Commands.txt`:

```
sim/time/paused            int  n  boolean  Is the sim paused?  Use cmd keys to change this.
sim/operation/pause_toggle      Toggle simulation paused state.
sim/operation/pause_on          Pause the simulation.
sim/operation/pause_off         Unpause the simulation.
```

- `sim/time/paused` is read-only (`n`) and is only read.
- `pause_on` / `pause_off` are preferred over the toggle because they are idempotent. If two requests race (two phones, or a phone plus the keyboard), the sim still ends up in the requested state instead of flipping twice. The toggle is kept as a fallback, guarded by reading the state before and after.
- The official API activates these commands directly (v2+), so no plugin or other mechanism is needed.

## Telemetry datarefs

| Shown as | Dataref | Type / unit (DataRefs.txt) | Conversion |
|---|---|---|---|
| Altitude (indicated) | `sim/cockpit2/gauges/indicators/altitude_ft_pilot` | float, feet | — |
| True altitude (details) | `sim/flightmodel/position/elevation` | double, meters MSL | × 3.2808 |
| Ground speed | `sim/flightmodel/position/groundspeed` | float, m/s | × 1.94384 → kt |
| IAS | `sim/cockpit2/gauges/indicators/airspeed_kts_pilot` | float, knots | — |
| Heading | `sim/flightmodel/position/mag_psi` | float, degrees magnetic | normalised 0–360 |
| Vertical speed | `sim/cockpit2/gauges/indicators/vvi_fpm_pilot` | float, ft/min | — |
| Latitude / longitude | `sim/flightmodel/position/latitude` / `longitude` | double, degrees | — |
| Aircraft | `sim/aircraft/view/acf_ui_name`, `acf_ICAO` | byte[] (base64 in API) | decoded, NUL-trimmed |
| Liveness only | `sim/time/total_running_time_sec` | float, seconds | — |

Value types reported by the API are checked against the expected kind (scalar numeric or `data`). A mismatch drops that field instead of showing garbage.

## Top of descent (Zibo 737)

Searched the installed aircraft (read-only): `plugins/xlua/scripts/B738.a_fms/B738.a_fms.lua`.

Relevant datarefs created by the Zibo FMC:

```lua
B738DR_vnav_td_dist = create_dataref("laminar/B738/fms/vnav_td_dist", "number")   -- line 5619
td_idx              = create_dataref("laminar/B738/fms/vnav_td_idx", "number")    -- line 5549
B738DR_flight_phase = create_dataref("laminar/B738/FMS/flight_phase", "number")   -- line 5080
B738DR_td_lat/lon   = "laminar/B738/nd/td_lat" / "td_lon"                         -- T/D position
```

How `vnav_td_dist` is computed (`B738_vnav_pth3`, around line 157877):

```lua
vnav_td_dist2 = (B738DR_fmc_dist + legs_data[offset][50]) - (legs_data[td_idx][50] + td_dist)
B738DR_vnav_td_dist = vnav_td_dist2
```

`B738DR_fmc_dist` is `laminar/B738/fms/lnav_dist_next` (NM to the active waypoint), and `legs_data[..][50]` is cumulative route distance. So the value is the **along-track distance in NM from the aircraft to T/D**.
While the FMC recalculates it is set to **9999**. It is ≤ 0 once T/D is passed (the FMC's PROGRESS page shows the negated value then), and `vnav_td_idx = 0` means no T/D exists.
The Zibo FMC uses the same dataref in its PROGRESS and LEGS logic (e.g. `if B738DR_vnav_td_dist > 0 then line5_x = " TO T/D …"`).

Interpretation used (`server/src/telemetry.ts`):

| Condition | Shown |
|---|---|
| datarefs absent | "—" (needs Zibo) |
| `vnav_td_idx == 0` | No T/D |
| `vnav_td_dist >= 9999` | Calculating |
| `flight_phase >= 5` (and ≠ 8) | Passed |
| `vnav_td_dist > 0` | *N* NM to T/D |
| `vnav_td_dist <= 0` | Passed (by \|N\| NM) |

**Not verified live.** The meaning comes from reading the 4.05.33 source. A different Zibo version may behave differently. The "≈ min" figure in the UI is a simple distance ÷ ground-speed estimate and is labelled as such.

## WebFMC

- Served by a Go backend (`gorilla/websocket`) from `Resources/plugins/WebFMC/data`. `index.html` loads `/static/js/app.<hash>.js`, `/static/js/chunk-vendors.<hash>.js` and `/static/css/app.<hash>.css`.
- Client WebSocket: `this.serverUrl="ws://"+window.location.hostname+":"+window.location.port+"/ws"`. It is hard-coded `ws://`, so it cannot work from an HTTPS page unchanged.
- webpack public path `e.p="/"`, and images are referenced as `e.p+"static/img/…"`. The CSS uses `url(/static/fonts/…)`. There is no client-side router.
- The backend listens on all interfaces. `WebFMC-log.txt` shows a phone at a `100.x` Tailscale address connecting directly.
- The binary contains `CheckOrigin` (gorilla). The proxy therefore connects upstream with `Origin: http://127.0.0.1:9090`.

Result: a same-origin proxy with three narrow in-transit rewrites (see README §8). It is implemented with a capability check that disables embedding if those patterns are ever missing.
