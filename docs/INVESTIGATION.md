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

## Destination ETA (Zibo 737)

Datarefs from the same Zibo file:

```lua
dist_dest              = create_dataref("laminar/B738/FMS/dist_dest", "number")  -- line 5696
time_dest              = create_dataref("laminar/B738/FMS/time_dest", "string")  -- line 5697
B738DR_dest_icao       = create_dataref("laminar/B738/fms/dest_icao", "string")  -- line 6176
```

- `dist_dest` is summed by the FMC from the aircraft along the remaining legs (`lnav_dist_next` for the active leg, then `wpt_distance(n)` for each later leg; around line 160717). Unit is NM, and it is 0 without a route.
- `time_dest` is the FMC's predicted arrival as `"HHMM"` in sim Zulu time (`time_to_string(legs_data[n][13])`, line 161159), and `""` when unknown.
- `sim/time/zulu_time_sec` (float, seconds since midnight) converts that into minutes remaining.

The app shows two ETAs (`interpretDest` in `server/src/telemetry.ts`):

| | Formula | Strength |
|---|---|---|
| **Live** | `dist_dest ÷ current GS` → minutes, plus real local clock time | Reacts instantly to the actual speed; tells you when to be back at the PC. Too early in the descent, because GS will drop on approach. |
| **FMC** | `time_dest − zulu_time_sec` | Uses the FMC's speed schedule. Depends on the FMC's performance data, and is in sim time. |

The live ETA is hidden below 60 kt GS. After T/D the T/D card is replaced by the arrival card. Before T/D, a one-line destination summary is shown.

**Live-verified 2026-10-24** in descent into VABB: all four datarefs resolved (`double` / `data` / `data` / `float`). The panel showed 33.4 NM, a live estimate of 7 min and an FMC ETA of 1151Z (in 11 min).

## FlightFactor 777v2

Installed at `Aircraft\FlightFactor777_200ER_300ER_F_EE` (version file `020523`), a SASL plugin.
Checked live on 2026-11-02 with the 777-300ER flying into VIDP:

- **No route, T/D or ETA datarefs.** Of the 11,546 datarefs in the sim, the FF777 adds 3,091 under `1-sim/...`. They are cockpit switches and animations, MCP outputs (`1-sim/output/mcp/*`), radios, and the CDU screens. It also doesn't feed X-Plane's own FMS (`sim/cockpit/gps/destination_index = -1`).
- **CDU screen datarefs** (documented in the aircraft's `docs/cduDatarefs.txt`): `1-sim/cdu{L,C,R}/display/symbols` (`data`, 14 × 24 chars + NUL), `symbolsColor` / `symbolsSize` / `symbolsEffects` (`int_array`), plus `numOfLines` / `numOfSymbolsInLine` (`int`).
- **WebFMC 2.4.1** logs `acf_ICAO: 'B77W' … Unsupported aircraft` and disables itself for the FF777.

The app reads destination data from **PROGRESS page 1**, on whichever CDU shows it (preference centre, then right, then left). Captured pages:

```
  UAE1234 PROGRESS  1/2        (descent)              AIC1523 PROGRESS  1/2   (cruise, 2026-11-03)
 TO      DTG  ETA   FUEL                              TO      DTG  ETA   FUEL
FS817     12 1356Z   8.0                             BOMBI    105 1521Z  63.8
 NEXT                                                 NEXT
DP502     25 1359Z   7.7                             TENLO    197 1534Z  62.3
 DEST                                                 DEST
VIDP      60 1409Z   7.3                             VIDP    3893 2249Z  14.0
 TGT SPD          TO E/D                              TGT SPD     TO STEP CLB
250         1409Z/  58NM                             .838                NONE
```

### T/D on the FF777 is an estimate

The FF777 FMC never shows a distance to T/D. T/D appears only as the green circle on the ND. PROGRESS shows `TO STEP CLB` or `TO E/D` (end of descent) in cruise, and `TO E/D` in descent too, so `E/D` does **not** mean "T/D passed". No dataref exposes the ND marker; `1-sim/...` was searched for `td`, `tod`, `vnav`, `descent` and `path` on 2026-11-03.

So the app estimates T/D with the standard rule of thumb, and labels it **EST** with a `~`:

```
T/D ahead ≈ DEST DTG − (altitude_ft / 1000 × 3 + 10)      3 NM per 1000 ft, +10 NM to slow down
```

Field elevation is ignored, so the estimate errs early: the safe side for "be back at the PC before T/D". Expect it to differ from the ND circle by roughly 5–20 NM, depending on winds, speed restrictions and the FMC's E/D altitude.

| PROGRESS / aircraft | T/D card |
|---|---|
| `TO T/C` | CLIMB |
| `TO T/D hhmmZ/ nnnNM` (never seen, but used if it appears) | *nnn* NM, FMC value |
| anything else, still at cruise altitude | ~*n* NM (EST); `0` = "T/D due now" |
| more than 2,500 ft below the flight's highest altitude, **or** descending ≥ 500 fpm within 30 NM of the estimated T/D | PASSED → arrival ETA card |
| no CDU on PROGRESS 1 | asks you to open it |

The highest altitude of the flight is tracked by the server (`FlightMemory` in `server/src/telemetry.ts`). It resets on the ground (< 50 kt), on an aircraft change and when the position jumps > 20 NM (a new flight loaded). A cruise step-*down* of more than 2,500 ft would therefore show PASSED early.

Destination ETA uses the same two estimates as the Zibo: DEST DTG ÷ ground speed, and the FMC ETA vs `sim/time/zulu_time_sec`.

**Live-verified:** profile detection, telemetry, DEST VIDP 60 → 18 → 5 NM with matching FMC ETAs in descent, and the colour CDU mirror of all three CDUs (2026-11-02). In cruise at FL370 (2026-11-03): `TO STEP CLB` page, T/D estimate 3851 − 121 = ~3730 NM. Not yet seen live: the change from ahead to PASSED at the real T/D, or a `TO T/C` (climb) page. Those are covered by tests.

## ToLiss A321

Installed at `Aircraft\Toliss Airbus A321 v1.3.2` (AirbusFBW plugin). Checked live on 2026-11-21 with the A321neo climbing out of VABB for VIDP. The manuals shipped with the aircraft do not document datarefs, so everything below comes from the live sim.

- **WebFMC 2.4.1** logs `acf_ICAO: 'A321', acf_author: 'Gliding Kiwi' … Unsupported aircraft`.
- **X-Plane's own FMS is not used**: `sim/cockpit/gps/destination_index = -1`, `sim/cockpit2/radios/indicators/fms_distance_to_tod_pilot = 0`.
- **No T/D dataref.** All 11,095 dataref names were searched for `tod`, `t_d`, `descent`, `vnav`, `path`.

Datarefs used (all read-only):

| Dataref | Type | Live value | Use |
|---|---|---|---|
| `AirbusFBW/DistToDest` | float | 605 → 548 NM | distance to destination along the flight plan; matches F-PLN DEST "DIST" |
| `toliss_airbus/flightplan/destination_icao` | data | `VIDP` | destination |
| `toliss_airbus/init/cruise_alt` | float | 35000 | CRZ FL for the T/D estimate |
| `AirbusFBW/APPhase` | int | 2 in the climb | FMGS phase: 0 preflight, 1 takeoff, 2 climb, 3 cruise, 4 descent, 5 approach, 6 go-around, 7 done |
| `AirbusFBW/MCDU{1,2}{title,stitle,label1-6,cont1-6,scont1-6,sp}{w,g,b,y,a,m,s}` | data | see below | MCDU screen, one string per line and colour |

**APPhase values:** only *2 = climb* has been seen live so far. The rest of the enumeration is the standard Airbus FMGS phase order and is **not yet confirmed**. If the phase dataref is missing, the app falls back to the FF777's altitude-history rule.

**MCDU layers.** Each line is a left-aligned string per colour; a space means "nothing in this colour here". Row layout: title (large) + stitle (small) → row 0; label*n* (small) → rows 1, 3, …, 11; cont*n* (large) + scont*n* (small) → rows 2, 4, …, 12; sp (scratchpad) → row 13. Colours: w white, g green, b cyan, y yellow, a amber, m magenta, s special symbols. In `s`, `A`/`B` are `[` `]` (confirmed on PROG "UPDATE AT *[    ]"); the digits are taken to be arrows (title `23` = ↑↓ on F-PLN; best guess, cosmetic). In every layer, `` ` `` is the degree sign.

F-PLN as rebuilt by the app:

```
 FROM          6488   ↑↓
        TIME  SPD/ALT
MB361   1559  301/ FL165
 ALBA2B BRG007°  11NM
…
(T/C)   1610   " / FL350
DEST    UTC   DIST  EFOB
VIDP11L 1722   548   3.0      → FMS ETA 1722Z (only when the column says UTC, not TIME)
```

**T/D from the FMS (PROG → REPORT).** There is no T/D dataref, but the FMS prints its own T/D on the REPORT page (MCDU PROG key → REPORT), line 5. This is documented in the ToLiss tutorial and was captured live on 2026-11-23:

```
      REPORT 6488
 OVHD          UTC  ALT
VABB27        1158    30
 TO
ANOLI         1202 FL095
 NEXT
MB361         1210 FL240
 SAT     T.WIND     FOB
+17°    056°/013     6.9
 T/D      UTC DIST              ← heading
AT FL350 1309  507              → T/D at 1309Z, 507 NM, for FL350
 DEST     UTC DIST  EFOB
VIDP11L  1334  632   3.2
```

**PERF CRZ** shows the same figures in a second layout, with a `TO (T/D)` marker on the line *above* the headings (captured live the same day, while REPORT on the other MCDU read 1302Z / 415 NM):

```
           CRZ
ACT MODE   UTC DEST EFOB
MANAGED   1327       3.2
 CI
12              TO (T/D)        ← marker
 MANAGED   UTC      DIST        ← headings
 267/.78  1302       416        → T/D at 1302Z, 416 NM (no level on this page)
```

The app reads the values **by column**, under the `UTC` and `DIST` headings, for either layout: `T/D` in the heading line (REPORT) or `TO (T/D)` on the line above (PERF CRZ). `TO (E/D)` and other markers are ignored. If both pages are open, MCDU1 is read first; they agree to within a few seconds.

Live checks: from REPORT, the app reported 471 NM / 1306Z and the page read 469 NM / 1305Z a few seconds later, at about 7 NM/min (the estimate would have said ~485 NM). From PERF CRZ, the app reported 399 NM / 1301Z, against REPORT's 397 NM / 1301Z.

**Order of precedence:**

1. APPhase ≥ 4 → *Passed*.
2. A T/D line on either MCDU → the FMS distance and time, without "EST".
3. Otherwise the **estimate**, like the FF777's, but from the INIT CRZ FL instead of the current altitude, so it is meaningful in the climb: `DistToDest − (max(CRZ FL, altitude)/1000 × 3 + 10)`. Example: 548.4 − (35 × 3 + 10) = ~433 NM.

**Discovery cost.** The MCDU alone is 274 datarefs, and X-Plane 12.4.3 answers a name batch with 404 if *any* name is unknown. The 404 names one missing dataref, but not necessarily the first in request order. Names are therefore resolved per add-on family:

- **Family present:** one batch.
- **Family not loaded:** the 404, then a check on the family's first name, so 2 requests.
- **A few names missing:** each one is dropped and remembered, then the batch is retried. This happens once per aircraft load.

Before this, every refresh of an absent add-on's names fell back to one request per name.

**Live-verified 2026-11-21:**

- Profile detection.
- T/D estimate (~433 NM).
- Destination VIDP 548 NM, with live ETA 76 min and FMS ETA 1722Z from the MCDU1 F-PLN.
- The colour MCDU mirror of both MCDUs (F-PLN and PROG), checked in the browser.

**Not yet seen live:** an APPhase other than 2, the change to *Passed* at T/D, and what the REPORT T/D line shows after T/D or before a flight plan exists. Those cases are parsed as "no figures" and fall back to the estimate.

## WebFMC

- Served by a Go backend (`gorilla/websocket`) from `Resources/plugins/WebFMC/data`. `index.html` loads `/static/js/app.<hash>.js`, `/static/js/chunk-vendors.<hash>.js` and `/static/css/app.<hash>.css`.
- Client WebSocket: `this.serverUrl="ws://"+window.location.hostname+":"+window.location.port+"/ws"`. It is hard-coded `ws://`, so it cannot work from an HTTPS page unchanged.
- webpack public path `e.p="/"`, and images are referenced as `e.p+"static/img/…"`. The CSS uses `url(/static/fonts/…)`. There is no client-side router.
- The backend listens on all interfaces. `WebFMC-log.txt` shows a phone at a `100.x` Tailscale address connecting directly.
- The binary contains `CheckOrigin` (gorilla). The proxy therefore connects upstream with `Origin: http://127.0.0.1:9090`.

Result: a same-origin proxy with three narrow in-transit rewrites (see README §8). It is implemented with a capability check that disables embedding if those patterns are ever missing.
